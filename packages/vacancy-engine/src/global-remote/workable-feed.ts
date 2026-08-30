import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SaxesParser } from 'saxes';
import { z } from 'zod';

import { isFrontendOnlyTitle } from './evaluation.js';

export const WORKABLE_ALL_CUSTOMER_FEED_URL = 'https://www.workable.com/boards/workable.xml';

const SNAPSHOT_VERSION = 1;
const DEFAULT_MAX_FIELD_BYTES = 1024 * 1024;
const ABSOLUTE_MAX_FIELD_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RETAINED_RECORDS = 10_000;
const ABSOLUTE_MAX_RETAINED_RECORDS = 50_000;
const DEFAULT_MAX_DEPTH = 3;
const PARSER_SLICE_CODE_UNITS = 16 * 1024;
const LEXICAL_TOKEN_SLACK_BYTES = 64 * 1024;
const MAX_MARKUP_BYTES = 8 * 1024;
const MAX_COMPACT_RECORD_BYTES = 8 * 1024;
const SNAPSHOT_OVERHEAD_BYTES = 1024 * 1024;

const JOB_FIELDS = [
  'title',
  'date',
  'referencenumber',
  'url',
  'company',
  'city',
  'state',
  'country',
  'remote',
  'postalcode',
  'description',
  'education',
  'jobtype',
  'category',
  'experience',
  'website',
] as const;

const RECORD_FIELDS = [
  'shortcode',
  'title',
  'postedAt',
  'url',
  'company',
  'city',
  'state',
  'country',
  'remote',
  'postalCode',
  'education',
  'employmentType',
  'category',
  'experience',
  'website',
] as const;

type WorkableJobField = (typeof JOB_FIELDS)[number];

const JOB_FIELD_SET = new Set<string>(JOB_FIELDS);

export type WorkableFeedRecord = Readonly<{
  shortcode: string;
  title: string;
  postedAt: string;
  url: string;
  company: string;
  city: string;
  state: string;
  country: string;
  remote: boolean;
  postalCode: string;
  education: string;
  employmentType: string;
  category: string;
  experience: string;
  website: string;
}>;

export type WorkableFeedParseResult = Readonly<{
  records: WorkableFeedRecord[];
  totalJobs: number;
  filteredJobs: number;
  duplicateJobs: number;
  /** Structurally complete jobs rejected for invalid factual field values. */
  invalidJobs: number;
  /** Frontend records omitted after the bounded retained-record prefix filled. */
  limitDroppedJobs: number;
}>;

export type WorkableFeedParserOptions = {
  maxDepth?: number;
  maxFieldBytes?: number;
  maxRetainedRecords?: number;
};

/** Minimal streaming seam for a bounded HTTP response consumer. */
export type WorkableFeedParserSink = {
  write(chunk: Uint8Array): void;
  finish(): WorkableFeedParseResult;
};

export type WorkableFeedSnapshot = Readonly<{
  version: 1;
  feedUrl: typeof WORKABLE_ALL_CUSTOMER_FEED_URL;
  etag?: string;
  lastModified?: string;
  /** Last successful HTTP 200 or 304 validation of this parsed result. */
  fetchedAt: string;
  result: WorkableFeedParseResult;
}>;

export type WorkableFeedSnapshotInput = {
  etag?: string | undefined;
  lastModified?: string | undefined;
  /** Last successful HTTP 200 or 304 validation of this parsed result. */
  fetchedAt: Date;
  result: WorkableFeedParseResult;
};

export type WorkableFeedSnapshotFileSystem = {
  mkdir(directory: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  rm(filePath: string): Promise<void>;
  stat(filePath: string): Promise<{ size: number }>;
  writeFile(filePath: string, contents: string): Promise<void>;
};

export type WorkableFeedSnapshotOptions = {
  maxRecords?: number;
  fileSystem?: WorkableFeedSnapshotFileSystem;
};

export class WorkableFeedParseError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(`workable feed: ${message}`, options);
    this.name = 'WorkableFeedParseError';
  }
}

type ActiveField = {
  scope: 'source' | 'job';
  name: string;
  byteLength: number;
  value: string;
};

type CurrentJob = {
  fields: Partial<Record<WorkableJobField, string>>;
  seen: Set<WorkableJobField>;
};

const nodeFileSystem: WorkableFeedSnapshotFileSystem = {
  async mkdir(directory) {
    await mkdir(directory, { recursive: true });
  },
  async readFile(filePath) {
    return readFile(filePath, 'utf8');
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async rm(filePath) {
    await rm(filePath, { force: true });
  },
  async stat(filePath) {
    const result = await stat(filePath);
    return { size: result.size };
  },
  async writeFile(filePath, contents) {
    await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx' });
  },
};

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function containsCompactControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function compactText(
  value: string | undefined,
  field: string,
  maximumBytes: number,
  required = false,
): string {
  if (value === undefined) throw new WorkableFeedParseError(`job omitted <${field}>`);
  const normalized = value.normalize('NFKC').trim();
  if (required && normalized.length === 0) {
    throw new WorkableFeedParseError(`job has an empty <${field}>`);
  }
  if (containsCompactControl(normalized)) {
    throw new WorkableFeedParseError(`job <${field}> contains control characters`);
  }
  if (byteLength(normalized) > maximumBytes) {
    throw new WorkableFeedParseError(`job <${field}> exceeds its compact value limit`);
  }
  return normalized;
}

function exactText(value: string | undefined, field: string, maximumBytes: number): string {
  if (value === undefined) throw new WorkableFeedParseError(`job omitted <${field}>`);
  // Workable's live feed wraps identity values in indented CDATA. XML wrapper whitespace is not
  // part of the shortcode or URL; preserve the trimmed value without Unicode normalization.
  const exact = value.trim();
  if (exact.length === 0) throw new WorkableFeedParseError(`job has an empty <${field}>`);
  if (containsCompactControl(exact) || byteLength(exact) > maximumBytes) {
    throw new WorkableFeedParseError(`job <${field}> is not an exact compact value`);
  }
  return exact;
}

function normalizeJob(fields: Partial<Record<WorkableJobField, string>>): WorkableFeedRecord {
  const shortcode = exactText(fields.referencenumber, 'referencenumber', 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(shortcode)) {
    throw new WorkableFeedParseError('job reference number is not a safe shortcode');
  }
  const url = exactText(fields.url, 'url', 500);
  if (url !== `https://apply.workable.com/j/${shortcode}`) {
    throw new WorkableFeedParseError(
      'job URL must be the exact Workable short URL for its shortcode',
    );
  }
  const rawDate = compactText(fields.date, 'date', 100, true);
  const date = new Date(rawDate);
  if (Number.isNaN(date.valueOf())) {
    throw new WorkableFeedParseError('job date is invalid');
  }
  const rawRemote = compactText(fields.remote, 'remote', 8, true).toLowerCase();
  if (rawRemote !== 'true' && rawRemote !== 'false') {
    throw new WorkableFeedParseError('job remote flag must be true or false');
  }
  return {
    shortcode,
    title: compactText(fields.title, 'title', 500, true),
    postedAt: date.toISOString(),
    url,
    company: compactText(fields.company, 'company', 500, true),
    city: compactText(fields.city, 'city', 500),
    state: compactText(fields.state, 'state', 500),
    country: compactText(fields.country, 'country', 100),
    remote: rawRemote === 'true',
    postalCode: compactText(fields.postalcode, 'postalcode', 100),
    education: compactText(fields.education, 'education', 500),
    employmentType: compactText(fields.jobtype, 'jobtype', 500),
    category: compactText(fields.category, 'category', 500),
    experience: compactText(fields.experience, 'experience', 500),
    website: compactText(fields.website, 'website', 2_000),
  };
}

function compareOldestFirst(left: WorkableFeedRecord, right: WorkableFeedRecord): number {
  return (
    left.postedAt.localeCompare(right.postedAt) || left.shortcode.localeCompare(right.shortcode)
  );
}

function pushRecordHeap(heap: WorkableFeedRecord[], record: WorkableFeedRecord): void {
  heap.push(record);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const parentRecord = heap[parent];
    if (parentRecord === undefined || compareOldestFirst(parentRecord, record) <= 0) break;
    heap[index] = parentRecord;
    index = parent;
  }
  heap[index] = record;
}

function replaceOldestRecord(
  heap: WorkableFeedRecord[],
  record: WorkableFeedRecord,
): WorkableFeedRecord {
  const oldest = heap[0];
  if (oldest === undefined) throw new Error('record heap cannot be empty');
  heap[0] = record;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    const leftRecord = heap[left];
    const currentRecord = heap[smallest];
    if (
      leftRecord !== undefined &&
      currentRecord !== undefined &&
      compareOldestFirst(leftRecord, currentRecord) < 0
    ) {
      smallest = left;
    }
    const rightRecord = heap[right];
    const smallestRecord = heap[smallest];
    if (
      rightRecord !== undefined &&
      smallestRecord !== undefined &&
      compareOldestFirst(rightRecord, smallestRecord) < 0
    ) {
      smallest = right;
    }
    if (smallest === index) break;
    const next = heap[smallest];
    if (next === undefined) break;
    heap[index] = next;
    heap[smallest] = record;
    index = smallest;
  }
  return oldest;
}

function parserError(error: unknown, fallback: string): WorkableFeedParseError {
  return error instanceof WorkableFeedParseError
    ? error
    : new WorkableFeedParseError(fallback, { cause: error });
}

type LexicalMode = 'text' | 'markup' | 'cdata';

function createXmlLexicalGuard(maxTextBytes: number): (text: string) => void {
  let mode: LexicalMode = 'text';
  let tokenBytes = 0;
  let markupPrefix = '';
  let markupQuote: '"' | "'" | null = null;
  let cdataTail = '';
  const maximumTokenBytes = maxTextBytes + LEXICAL_TOKEN_SLACK_BYTES;

  const addTokenByteLength = (character: string): void => {
    tokenBytes += byteLength(character);
    if (tokenBytes > maximumTokenBytes) {
      throw new WorkableFeedParseError('XML text token exceeds the streaming size guard');
    }
  };

  return (text: string): void => {
    for (const character of text) {
      if (mode === 'cdata') {
        addTokenByteLength(character);
        cdataTail = `${cdataTail}${character}`.slice(-3);
        if (cdataTail === ']]>') {
          mode = 'text';
          tokenBytes = 0;
          cdataTail = '';
        }
        continue;
      }

      if (mode === 'text') {
        if (character === '<') {
          mode = 'markup';
          tokenBytes = 1;
          markupPrefix = '<';
          markupQuote = null;
        } else {
          addTokenByteLength(character);
        }
        continue;
      }

      tokenBytes += byteLength(character);
      if (tokenBytes > MAX_MARKUP_BYTES) {
        throw new WorkableFeedParseError('XML markup token exceeds the size limit');
      }
      if (markupPrefix.length < 16) markupPrefix += character;
      const upperPrefix = markupPrefix.toUpperCase();
      if (markupPrefix === '<!--') {
        throw new WorkableFeedParseError('comments are forbidden');
      }
      if (upperPrefix === '<!DOCTYPE' || upperPrefix === '<!ENTITY') {
        throw new WorkableFeedParseError('DOCTYPE and entity declarations are forbidden');
      }
      if (markupPrefix === '<![CDATA[') {
        mode = 'cdata';
        tokenBytes = 0;
        cdataTail = '';
        continue;
      }
      if (markupQuote === null && (character === '"' || character === "'")) {
        markupQuote = character;
      } else if (character === markupQuote) {
        markupQuote = null;
      } else if (character === '>' && markupQuote === null) {
        mode = 'text';
        tokenBytes = 0;
        markupPrefix = '';
      }
    }
  };
}

/**
 * Incrementally parses Workable's official all-customer XML feed. Descriptions
 * are size-checked but never copied into retained job state or snapshots.
 */
export function createWorkableFeedParser(
  options: WorkableFeedParserOptions = {},
): WorkableFeedParserSink {
  const maxDepth = boundedInteger(options.maxDepth ?? DEFAULT_MAX_DEPTH, 'maxDepth', 3, 32);
  const maxFieldBytes = boundedInteger(
    options.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES,
    'maxFieldBytes',
    1,
    ABSOLUTE_MAX_FIELD_BYTES,
  );
  const maxRetainedRecords = boundedInteger(
    options.maxRetainedRecords ?? DEFAULT_MAX_RETAINED_RECORDS,
    'maxRetainedRecords',
    1,
    ABSOLUTE_MAX_RETAINED_RECORDS,
  );
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parser = new SaxesParser({ xmlns: false, fragment: false });
  const stack: string[] = [];
  const records: WorkableFeedRecord[] = [];
  const retainedShortcodes = new Set<string>();
  let currentJob: CurrentJob | null = null;
  let activeField: ActiveField | null = null;
  let publisher: string | null = null;
  let publisherUrl: string | null = null;
  let jobsStarted = false;
  let sourceOpened = false;
  let sourceClosed = false;
  let ended = false;
  let finished = false;
  let failure: WorkableFeedParseError | null = null;
  let totalJobs = 0;
  let filteredJobs = 0;
  let duplicateJobs = 0;
  let invalidJobs = 0;
  let limitDroppedJobs = 0;

  const fail = (message: string): never => {
    throw new WorkableFeedParseError(message);
  };

  const scanLexicalTokens = createXmlLexicalGuard(maxFieldBytes);

  const appendFieldText = (text: string): void => {
    if (activeField === null) {
      if (text.trim().length > 0) fail('text is only allowed inside known fields');
      return;
    }
    activeField.byteLength += byteLength(text);
    if (activeField.byteLength > maxFieldBytes) {
      fail(`<${activeField.name}> exceeds the field-size limit`);
    }
    if (activeField.name !== 'description') activeField.value += text;
  };

  parser.on('xmldecl', (declaration) => {
    if (declaration.version !== undefined && declaration.version !== '1.0') {
      fail('only XML 1.0 is supported');
    }
    if (
      declaration.encoding !== undefined &&
      declaration.encoding.toLowerCase().replaceAll('_', '-') !== 'utf-8'
    ) {
      fail('only UTF-8 XML is supported');
    }
  });
  parser.on('processinginstruction', () => fail('processing instructions are forbidden'));
  parser.on('comment', () => fail('comments are forbidden'));
  parser.on('doctype', () => fail('DOCTYPE and entity declarations are forbidden'));
  parser.on('error', (error) => {
    throw new WorkableFeedParseError('XML is malformed or truncated', { cause: error });
  });
  parser.on('text', appendFieldText);
  parser.on('cdata', appendFieldText);
  parser.on('opentag', (tag) => {
    const depth = stack.length + 1;
    if (depth > maxDepth) fail('XML nesting exceeds the depth limit');
    if (Object.keys(tag.attributes).length > 0) fail('attributes are not allowed');
    const parent = stack.at(-1);

    if (depth === 1) {
      if (tag.name !== 'source' || sourceOpened) fail('root element must be <source>');
      sourceOpened = true;
    } else if (parent === 'source') {
      if (tag.name === 'job') {
        if (publisher !== 'Workable' || publisherUrl !== 'https://www.workable.com') {
          fail('publisher metadata must precede jobs and identify Workable');
        }
        if (currentJob !== null) fail('jobs cannot be nested');
        jobsStarted = true;
        currentJob = { fields: {}, seen: new Set() };
      } else if (tag.name === 'publisher' || tag.name === 'publisherurl') {
        if (jobsStarted) fail('publisher metadata must precede jobs');
        if (
          (tag.name === 'publisher' && publisher !== null) ||
          (tag.name === 'publisherurl' && publisherUrl !== null)
        ) {
          fail(`<${tag.name}> must appear exactly once`);
        }
        activeField = {
          scope: 'source',
          name: tag.name,
          byteLength: 0,
          value: '',
        };
      } else {
        fail(`unexpected <${tag.name}> under <source>`);
      }
    } else if (parent === 'job') {
      const job = currentJob;
      if (!JOB_FIELD_SET.has(tag.name)) fail(`unexpected <${tag.name}> under <job>`);
      if (job === null) throw new WorkableFeedParseError('job field opened outside a job');
      const name = tag.name as WorkableJobField;
      if (job.seen.has(name)) fail(`<${name}> must appear exactly once per job`);
      job.seen.add(name);
      activeField = { scope: 'job', name, byteLength: 0, value: '' };
    } else {
      fail(`unexpected nested <${tag.name}>`);
    }
    stack.push(tag.name);
  });
  parser.on('closetag', (tag) => {
    const name = tag.name;
    if (stack.at(-1) !== name) fail('XML element stack is inconsistent');
    if (activeField?.name === name) {
      if (activeField.scope === 'source') {
        const value = activeField.value.trim();
        if (name === 'publisher') publisher = value;
        else publisherUrl = value;
      } else {
        const job = currentJob;
        if (job === null) throw new WorkableFeedParseError('job field closed outside a job');
        job.fields[name as WorkableJobField] = activeField.value;
      }
      activeField = null;
    }

    if (name === 'job') {
      const job = currentJob;
      if (job === null) throw new WorkableFeedParseError('job closed without state');
      for (const field of JOB_FIELDS) {
        if (!job.seen.has(field)) fail(`job omitted <${field}>`);
      }
      totalJobs += 1;
      let record: WorkableFeedRecord | null = null;
      try {
        record = normalizeJob(job.fields);
      } catch (error) {
        if (!(error instanceof WorkableFeedParseError)) throw error;
        invalidJobs += 1;
      }
      if (record !== null) {
        if (!record.remote || !isFrontendOnlyTitle(record.title)) {
          filteredJobs += 1;
        } else if (retainedShortcodes.has(record.shortcode)) {
          duplicateJobs += 1;
        } else {
          if (records.length >= maxRetainedRecords) {
            limitDroppedJobs += 1;
            const oldest = records[0];
            if (oldest !== undefined && record.postedAt > oldest.postedAt) {
              const replaced = replaceOldestRecord(records, record);
              retainedShortcodes.delete(replaced.shortcode);
              retainedShortcodes.add(record.shortcode);
            }
          } else {
            retainedShortcodes.add(record.shortcode);
            pushRecordHeap(records, record);
          }
        }
      }
      currentJob = null;
    } else if (name === 'source') {
      if (publisher !== 'Workable' || publisherUrl !== 'https://www.workable.com') {
        fail('source publisher metadata is invalid');
      }
      sourceClosed = true;
    }
    stack.pop();
  });
  parser.on('end', () => {
    ended = true;
  });

  const guarded = (operation: () => void, fallback: string): void => {
    if (failure !== null) throw failure;
    try {
      operation();
    } catch (error) {
      failure = parserError(error, fallback);
      throw failure;
    }
  };

  const writeParserText = (text: string): void => {
    for (let offset = 0; offset < text.length; offset += PARSER_SLICE_CODE_UNITS) {
      const slice = text.slice(offset, offset + PARSER_SLICE_CODE_UNITS);
      parser.write(slice);
    }
  };

  return {
    write(chunk) {
      if (finished) throw new WorkableFeedParseError('cannot write after finish');
      guarded(() => {
        let text: string;
        try {
          text = decoder.decode(chunk, { stream: true });
        } catch (error) {
          throw new WorkableFeedParseError('input is not valid UTF-8', { cause: error });
        }
        scanLexicalTokens(text);
        writeParserText(text);
      }, 'XML chunk could not be parsed');
    },
    finish() {
      if (finished) throw new WorkableFeedParseError('finish may only be called once');
      finished = true;
      guarded(() => {
        let tail: string;
        try {
          tail = decoder.decode();
        } catch (error) {
          throw new WorkableFeedParseError('input ended inside a UTF-8 sequence', {
            cause: error,
          });
        }
        scanLexicalTokens(tail);
        if (tail.length > 0) writeParserText(tail);
        parser.close();
        if (!ended || !sourceOpened || !sourceClosed || stack.length !== 0) {
          fail('XML is malformed or truncated');
        }
      }, 'XML is malformed or truncated');
      return {
        records: [...records].sort(
          (left, right) =>
            right.postedAt.localeCompare(left.postedAt) ||
            left.shortcode.localeCompare(right.shortcode),
        ),
        totalJobs,
        filteredJobs,
        duplicateJobs,
        invalidJobs,
        limitDroppedJobs,
      };
    },
  };
}

const snapshotRecordSchema = z.strictObject({
  shortcode: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  postedAt: z.iso.datetime({ offset: true }),
  url: z.string().min(1).max(500),
  company: z.string().min(1).max(500),
  city: z.string().max(500),
  state: z.string().max(500),
  country: z.string().max(100),
  remote: z.boolean(),
  postalCode: z.string().max(100),
  education: z.string().max(500),
  employmentType: z.string().max(500),
  category: z.string().max(500),
  experience: z.string().max(500),
  website: z.string().max(2_000),
});

const headerMetadataSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
      }),
  );

const snapshotSchema = z.strictObject({
  version: z.literal(SNAPSHOT_VERSION),
  feedUrl: z.literal(WORKABLE_ALL_CUSTOMER_FEED_URL),
  etag: headerMetadataSchema.optional(),
  lastModified: headerMetadataSchema.optional(),
  fetchedAt: z.iso.datetime({ offset: true }),
  result: z.strictObject({
    records: z.array(snapshotRecordSchema),
    totalJobs: z.number().int().nonnegative(),
    filteredJobs: z.number().int().nonnegative(),
    duplicateJobs: z.number().int().nonnegative(),
    invalidJobs: z.number().int().nonnegative(),
    limitDroppedJobs: z.number().int().nonnegative(),
  }),
});

function recordHasParserInvariants(record: WorkableFeedRecord): boolean {
  try {
    const normalized = normalizeJob({
      title: record.title,
      date: record.postedAt,
      referencenumber: record.shortcode,
      url: record.url,
      company: record.company,
      city: record.city,
      state: record.state,
      country: record.country,
      remote: String(record.remote),
      postalcode: record.postalCode,
      description: '',
      education: record.education,
      jobtype: record.employmentType,
      category: record.category,
      experience: record.experience,
      website: record.website,
    });
    return RECORD_FIELDS.every((field) => normalized[field] === record[field]);
  } catch {
    return false;
  }
}

function snapshotByteLimit(maxRecords: number): number {
  return SNAPSHOT_OVERHEAD_BYTES + maxRecords * MAX_COMPACT_RECORD_BYTES;
}

function validatedSnapshot(value: unknown, maxRecords: number): WorkableFeedSnapshot | null {
  const parsed = snapshotSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.result.records.length === 0 ||
    parsed.data.result.records.length > maxRecords ||
    parsed.data.result.totalJobs === 0 ||
    parsed.data.result.invalidJobs >= parsed.data.result.totalJobs * 0.5
  ) {
    return null;
  }
  if (
    parsed.data.result.totalJobs !==
    parsed.data.result.records.length +
      parsed.data.result.filteredJobs +
      parsed.data.result.duplicateJobs +
      parsed.data.result.invalidJobs +
      parsed.data.result.limitDroppedJobs
  ) {
    return null;
  }
  if (
    parsed.data.lastModified !== undefined &&
    !Number.isFinite(Date.parse(parsed.data.lastModified))
  ) {
    return null;
  }
  const seen = new Set<string>();
  for (const record of parsed.data.result.records) {
    if (
      seen.has(record.shortcode) ||
      !recordHasParserInvariants(record) ||
      !record.remote ||
      !isFrontendOnlyTitle(record.title)
    ) {
      return null;
    }
    seen.add(record.shortcode);
  }
  return {
    version: parsed.data.version,
    feedUrl: parsed.data.feedUrl,
    ...(parsed.data.etag === undefined ? {} : { etag: parsed.data.etag }),
    ...(parsed.data.lastModified === undefined ? {} : { lastModified: parsed.data.lastModified }),
    fetchedAt: parsed.data.fetchedAt,
    result: parsed.data.result,
  };
}

function snapshotMaxRecords(options: WorkableFeedSnapshotOptions): number {
  return boundedInteger(
    options.maxRecords ?? DEFAULT_MAX_RETAINED_RECORDS,
    'maxRecords',
    1,
    ABSOLUTE_MAX_RETAINED_RECORDS,
  );
}

/** Loads only fully validated, compact snapshots; corrupt or oversized files are ignored. */
export async function loadWorkableFeedSnapshot(
  snapshotPath: string,
  options: WorkableFeedSnapshotOptions = {},
): Promise<WorkableFeedSnapshot | null> {
  const maxRecords = snapshotMaxRecords(options);
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  try {
    const file = await fileSystem.stat(snapshotPath);
    if (file.size < 1 || file.size > snapshotByteLimit(maxRecords)) return null;
    return validatedSnapshot(
      JSON.parse(await fileSystem.readFile(snapshotPath)) as unknown,
      maxRecords,
    );
  } catch {
    return null;
  }
}

/** Validates, writes beside the target, then atomically renames the complete snapshot. */
export async function writeWorkableFeedSnapshot(
  snapshotPath: string,
  input: WorkableFeedSnapshotInput,
  options: WorkableFeedSnapshotOptions = {},
): Promise<void> {
  const maxRecords = snapshotMaxRecords(options);
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const candidate = {
    version: SNAPSHOT_VERSION,
    feedUrl: WORKABLE_ALL_CUSTOMER_FEED_URL,
    ...(input.etag === undefined ? {} : { etag: input.etag }),
    ...(input.lastModified === undefined ? {} : { lastModified: input.lastModified }),
    fetchedAt: input.fetchedAt.toISOString(),
    result: input.result,
  };
  const snapshot = validatedSnapshot(candidate, maxRecords);
  if (snapshot === null) throw new Error('Workable feed snapshot is invalid');
  const contents = `${JSON.stringify(snapshot)}\n`;
  if (byteLength(contents) > snapshotByteLimit(maxRecords)) {
    throw new Error('Workable feed snapshot exceeds its byte limit');
  }

  await fileSystem.mkdir(path.dirname(snapshotPath));
  const temporary = `${snapshotPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fileSystem.writeFile(temporary, contents);
    await fileSystem.rename(temporary, snapshotPath);
  } finally {
    await fileSystem.rm(temporary);
  }
}
