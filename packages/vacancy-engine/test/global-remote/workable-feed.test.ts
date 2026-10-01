import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createWorkableFeedParser,
  loadWorkableFeedSnapshot,
  WORKABLE_ALL_CUSTOMER_FEED_URL,
  WorkableFeedParseError,
  type WorkableFeedParseResult,
  type WorkableFeedSnapshotFileSystem,
  writeWorkableFeedSnapshot,
} from '../../src/global-remote/workable-feed.js';

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

type JobField = (typeof JOB_FIELDS)[number];
type JobFields = Record<JobField, string>;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function fixture(name: string): Promise<string> {
  return readFile(
    new URL(`../fixtures/global-remote/workable-feed/${name}`, import.meta.url),
    'utf8',
  );
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function fields(overrides: Partial<JobFields> = {}): JobFields {
  const shortcode = overrides.referencenumber ?? 'FRONTEND123';
  return {
    title: 'Frontend Engineer',
    date: 'Sun, 29 Dec 2019 11:02:25 UTC',
    referencenumber: shortcode,
    url: `https://apply.workable.com/j/${shortcode}`,
    company: 'Example Company',
    city: 'Remote',
    state: '',
    country: 'Worldwide',
    remote: 'true',
    postalcode: '',
    description: '<p>Current-job-only description.</p>',
    education: '',
    jobtype: 'Full-time',
    category: 'Engineering',
    experience: 'Mid-level',
    website: 'https://example.test/jobs',
    ...overrides,
  };
}

function jobXml(values: JobFields, omit?: JobField): string {
  return `<job>${JOB_FIELDS.filter((field) => field !== omit)
    .map((field) => `<${field}>${escapeXml(values[field])}</${field}>`)
    .join('')}</job>`;
}

function sourceXml(jobs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><source><publisher>Workable</publisher><publisherurl>https://www.workable.com</publisherurl>${jobs.join('')}</source>`;
}

function parse(
  xml: string,
  options: Parameters<typeof createWorkableFeedParser>[0] = {},
  chunkBytes?: number,
): WorkableFeedParseResult {
  const sink = createWorkableFeedParser(options);
  const encoded = new TextEncoder().encode(xml);
  const width = chunkBytes ?? Math.max(encoded.length, 1);
  for (let offset = 0; offset < encoded.length; offset += width) {
    sink.write(encoded.subarray(offset, Math.min(encoded.length, offset + width)));
  }
  return sink.finish();
}

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ovr-workable-feed-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'snapshot.json');
}

describe('Workable all-customer feed parser', () => {
  it('streams arbitrary byte splits, CDATA, and Unicode without retaining descriptions', async () => {
    const xml = await fixture('valid.xml');

    const whole = parse(xml);
    const byteByByte = parse(xml, {}, 1);

    expect(byteByByte).toEqual(whole);
    expect(whole).toEqual({
      records: [
        {
          shortcode: 'FRONT123456',
          title: 'Senior Frontend Engineer – Café ☕',
          postedAt: '2019-12-29T11:02:25.000Z',
          url: 'https://apply.workable.com/j/FRONT123456',
          company: 'Example & Interfaces',
          city: 'Amsterdam',
          state: 'Noord-Holland',
          country: 'Netherlands',
          remote: true,
          postalCode: '1012',
          education: "Bachelor's degree",
          employmentType: 'Full-time',
          category: 'Engineering',
          experience: 'Senior',
          website: 'https://example.test/careers',
        },
      ],
      totalJobs: 2,
      filteredJobs: 1,
      duplicateJobs: 0,
      invalidJobs: 0,
      limitDroppedJobs: 0,
    });
    expect(JSON.stringify(whole)).not.toContain('Build Angular');
    expect(whole.records[0]).not.toHaveProperty('description');
  });

  it('deduplicates shortcode and filters non-frontend jobs only when each job closes', () => {
    const first = jobXml(fields());
    const duplicate = jobXml(fields({ title: 'Angular Developer' }));
    const backend = jobXml(
      fields({
        title: 'Backend Engineer',
        referencenumber: 'BACKEND123',
        url: 'https://apply.workable.com/j/BACKEND123',
      }),
    );

    expect(parse(sourceXml([first, duplicate, backend]))).toMatchObject({
      records: [{ shortcode: 'FRONTEND123' }],
      totalJobs: 3,
      filteredJobs: 1,
      duplicateJobs: 1,
      invalidJobs: 0,
      limitDroppedJobs: 0,
    });
  });

  it('discards non-remote frontend jobs before retention', () => {
    const onsite = jobXml(
      fields({
        remote: 'false',
        referencenumber: 'ONSITE123',
        url: 'https://apply.workable.com/j/ONSITE123',
      }),
    );

    expect(parse(sourceXml([onsite, jobXml(fields())]))).toMatchObject({
      records: [{ shortcode: 'FRONTEND123', remote: true }],
      totalJobs: 2,
      filteredJobs: 1,
    });
  });

  it.each([
    'http://apply.workable.com/j/FRONTEND123',
    'https://apply.workable.com/j/FRONTEND123/',
    'https://apply.workable.com/j/FRONTEND123?source=test',
    'https://apply.workable.com/j/DIFFERENT',
    'https://apply.workable.com/example/j/FRONTEND123',
    'https://apply.workable.com/j/FRONTEND\t123',
  ])('skips non-exact or changed job URL %s', (url) => {
    expect(parse(sourceXml([jobXml(fields({ url }))]))).toMatchObject({
      records: [],
      totalJobs: 1,
      invalidJobs: 1,
    });
  });

  it('skips invalid facts without guessing identity or losing later valid jobs', () => {
    const invalid = jobXml(
      fields({
        referencenumber: 'ＦRONTEND123',
        url: 'https://apply.workable.com/j/FRONTEND123',
      }),
    );

    expect(parse(sourceXml([invalid, jobXml(fields())]))).toMatchObject({
      records: [{ shortcode: 'FRONTEND123' }],
      totalJobs: 2,
      invalidJobs: 1,
    });
  });

  it('rejects missing, duplicate, unknown, attributed, and nested fields', () => {
    const complete = jobXml(fields());
    const cases = [
      jobXml(fields(), 'description'),
      complete.replace('</job>', '<title>Second title</title></job>'),
      complete.replace('</job>', '<salary>100000</salary></job>'),
      complete.replace('<title>', '<title language="en">'),
      complete.replace('Frontend Engineer', 'Frontend <strong>Engineer</strong>'),
      complete.replace('Frontend Engineer', 'Frontend <!-- hidden --> Engineer'),
    ];

    for (const xml of cases) {
      expect(() => parse(sourceXml([xml]))).toThrow(WorkableFeedParseError);
    }
  });

  it('rejects declarations, entities, malformed XML, and truncated XML', async () => {
    const doctype = await fixture('doctype.xml');
    const truncated = await fixture('truncated.xml');

    expect(() => parse(doctype, {}, 1)).toThrow(/forbidden/u);
    expect(() =>
      parse(
        sourceXml([jobXml(fields({ title: 'Frontend &unknown; Engineer' }))]).replace(
          '&amp;unknown;',
          '&unknown;',
        ),
      ),
    ).toThrow(WorkableFeedParseError);
    expect(() => parse('<source><publisher></source>')).toThrow(WorkableFeedParseError);
    expect(() => parse(truncated)).toThrow(WorkableFeedParseError);
  });

  it('rejects invalid or truncated UTF-8', () => {
    const invalid = createWorkableFeedParser();
    expect(() => invalid.write(Uint8Array.of(0xff))).toThrow(/UTF-8/u);

    const truncated = createWorkableFeedParser();
    truncated.write(Uint8Array.of(0xc3));
    expect(() => truncated.finish()).toThrow(/UTF-8 sequence/u);
  });

  it('enforces nesting, per-field, and total retained-record bounds', () => {
    const nested = sourceXml([
      jobXml(fields()).replace('Frontend Engineer', 'Frontend <span>x</span> Engineer'),
    ]);
    expect(() => parse(nested, { maxDepth: 3 })).toThrow(/depth limit/u);

    expect(() =>
      parse(sourceXml([jobXml(fields({ description: 'x'.repeat(33) }))]), {
        maxFieldBytes: 32,
      }),
    ).toThrow(/field-size limit/u);

    const unclosed = createWorkableFeedParser({ maxFieldBytes: 32 });
    unclosed.write(
      new TextEncoder().encode(
        '<?xml version="1.0"?><source><publisher>Workable</publisher><publisherurl>https://www.workable.com</publisherurl><job><description>',
      ),
    );
    expect(() => unclosed.write(new TextEncoder().encode('x'.repeat(70_000)))).toThrow(
      /streaming size guard/u,
    );

    const oversizedMarkup = createWorkableFeedParser();
    expect(() =>
      oversizedMarkup.write(new TextEncoder().encode(`<source data-value="${'x'.repeat(9_000)}`)),
    ).toThrow(/markup token exceeds/u);

    const secondFrontend = jobXml(
      fields({
        referencenumber: 'FRONTEND456',
        url: 'https://apply.workable.com/j/FRONTEND456',
      }),
    );
    expect(
      parse(sourceXml([jobXml(fields()), secondFrontend]), { maxRetainedRecords: 1 }),
    ).toMatchObject({
      records: [{ shortcode: 'FRONTEND123' }],
      totalJobs: 2,
      limitDroppedJobs: 1,
    });

    const backend = jobXml(
      fields({
        title: 'Backend Engineer',
        referencenumber: 'BACKEND456',
        url: 'https://apply.workable.com/j/BACKEND456',
      }),
    );
    expect(parse(sourceXml([backend, jobXml(fields())]), { maxRetainedRecords: 1 })).toMatchObject({
      records: [{ shortcode: 'FRONTEND123' }],
      filteredJobs: 1,
    });

    const newer = jobXml(
      fields({
        date: 'Sun, 30 Aug 2026 11:02:25 UTC',
        referencenumber: 'NEWEST123',
        url: 'https://apply.workable.com/j/NEWEST123',
      }),
    );
    expect(parse(sourceXml([jobXml(fields()), newer]), { maxRetainedRecords: 1 })).toMatchObject({
      records: [{ shortcode: 'NEWEST123' }],
      limitDroppedJobs: 1,
    });
  });

  it('makes parser completion terminal', () => {
    const sink = createWorkableFeedParser();
    sink.write(new TextEncoder().encode(sourceXml([])));
    sink.finish();

    expect(() => sink.finish()).toThrow(/only be called once/u);
    expect(() => sink.write(new Uint8Array())).toThrow(/cannot write after finish/u);
  });
});

describe('Workable parsed snapshots', () => {
  async function result(): Promise<WorkableFeedParseResult> {
    return parse(await fixture('valid.xml'));
  }

  it('round-trips validated metadata and compact records without descriptions', async () => {
    const snapshotPath = await temporaryPath();
    await writeWorkableFeedSnapshot(snapshotPath, {
      etag: 'W/"feed-v1"',
      lastModified: 'Sun, 30 Aug 2026 10:00:00 GMT',
      fetchedAt: new Date('2026-08-30T10:01:00.000Z'),
      result: await result(),
    });

    const loaded = await loadWorkableFeedSnapshot(snapshotPath);
    expect(loaded).toMatchObject({
      version: 1,
      feedUrl: WORKABLE_ALL_CUSTOMER_FEED_URL,
      etag: 'W/"feed-v1"',
      lastModified: 'Sun, 30 Aug 2026 10:00:00 GMT',
      fetchedAt: '2026-08-30T10:01:00.000Z',
      result: { records: [{ shortcode: 'FRONT123456' }] },
    });
    expect(await readFile(snapshotPath, 'utf8')).not.toContain('description');
    expect(await readFile(snapshotPath, 'utf8')).not.toContain('Build Angular');
  });

  it('supports missing validators and refreshes fetchedAt after a successful check', async () => {
    const snapshotPath = await temporaryPath();
    await writeWorkableFeedSnapshot(snapshotPath, {
      fetchedAt: new Date('2026-08-30T10:01:00.000Z'),
      result: await result(),
    });

    expect(await loadWorkableFeedSnapshot(snapshotPath)).toMatchObject({
      fetchedAt: '2026-08-30T10:01:00.000Z',
    });
    expect(await loadWorkableFeedSnapshot(snapshotPath)).not.toHaveProperty('etag');
    expect(await loadWorkableFeedSnapshot(snapshotPath)).not.toHaveProperty('lastModified');

    await writeWorkableFeedSnapshot(snapshotPath, {
      fetchedAt: new Date('2026-08-30T11:01:00.000Z'),
      result: await result(),
    });
    expect(await loadWorkableFeedSnapshot(snapshotPath)).toMatchObject({
      fetchedAt: '2026-08-30T11:01:00.000Z',
    });
  });

  it('ignores corrupt, excessive, duplicate, non-frontend, and URL-mutated snapshots', async () => {
    const snapshotPath = await temporaryPath();
    const parsed = await result();
    const base = {
      version: 1,
      feedUrl: WORKABLE_ALL_CUSTOMER_FEED_URL,
      etag: '"feed-v1"',
      fetchedAt: '2026-08-30T10:01:00.000Z',
      result: parsed,
    };
    const record = parsed.records[0];
    expect(record).toBeDefined();

    const invalidValues: unknown[] = [
      '{broken',
      { ...base, etag: '"bad\u0000etag"' },
      { ...base, result: { ...parsed, records: [record, record], totalJobs: 3 } },
      {
        ...base,
        result: {
          records: [{ ...record, shortcode: 'SECOND123', url: record?.url }],
          totalJobs: 1,
          filteredJobs: 0,
          duplicateJobs: 0,
          invalidJobs: 0,
          limitDroppedJobs: 0,
        },
      },
      {
        ...base,
        result: {
          records: [{ ...record, company: '   ' }],
          totalJobs: 1,
          filteredJobs: 0,
          duplicateJobs: 0,
          invalidJobs: 0,
          limitDroppedJobs: 0,
        },
      },
      {
        ...base,
        result: {
          records: [{ ...record, shortcode: 'BAD\u0000CODE' }],
          totalJobs: 1,
          filteredJobs: 0,
          duplicateJobs: 0,
          invalidJobs: 0,
          limitDroppedJobs: 0,
        },
      },
      {
        ...base,
        result: {
          records: [{ ...record, title: 'Backend Engineer' }],
          totalJobs: 1,
          filteredJobs: 0,
          duplicateJobs: 0,
          invalidJobs: 0,
          limitDroppedJobs: 0,
        },
      },
      {
        ...base,
        result: {
          records: [{ ...record, remote: false }],
          totalJobs: 1,
          filteredJobs: 0,
          duplicateJobs: 0,
          invalidJobs: 0,
          limitDroppedJobs: 0,
        },
      },
      {
        ...base,
        result: {
          records: [],
          totalJobs: 0,
          filteredJobs: 0,
          duplicateJobs: 0,
          invalidJobs: 0,
          limitDroppedJobs: 0,
        },
      },
      { ...base, result: { ...parsed, records: [record, record], totalJobs: 3 } },
      {
        ...base,
        result: {
          records: [{ ...record, description: 'must not persist' }],
          totalJobs: 1,
          filteredJobs: 0,
          duplicateJobs: 0,
          invalidJobs: 0,
          limitDroppedJobs: 0,
        },
      },
    ];

    for (const value of invalidValues) {
      await writeFile(
        snapshotPath,
        typeof value === 'string' ? value : JSON.stringify(value),
        'utf8',
      );
      await expect(loadWorkableFeedSnapshot(snapshotPath, { maxRecords: 1 })).resolves.toBeNull();
    }
  });

  it('keeps last complete snapshot and removes temp file when rename fails', async () => {
    const snapshotPath = await temporaryPath();
    const parsed = await result();
    await writeWorkableFeedSnapshot(snapshotPath, {
      etag: '"stable"',
      fetchedAt: new Date('2026-08-30T10:01:00.000Z'),
      result: parsed,
    });

    const failingFileSystem: WorkableFeedSnapshotFileSystem = {
      async mkdir(directory) {
        await mkdir(directory, { recursive: true });
      },
      async readFile(filePath) {
        return readFile(filePath, 'utf8');
      },
      async rename() {
        throw new Error('simulated rename failure');
      },
      async rm(filePath) {
        await rm(filePath, { force: true });
      },
      async stat(filePath) {
        return { size: (await stat(filePath)).size };
      },
      async writeFile(filePath, contents) {
        await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx' });
      },
    };

    await expect(
      writeWorkableFeedSnapshot(
        snapshotPath,
        {
          etag: '"replacement"',
          fetchedAt: new Date('2026-08-30T10:02:00.000Z'),
          result: parsed,
        },
        { fileSystem: failingFileSystem },
      ),
    ).rejects.toThrow('simulated rename failure');

    expect(await loadWorkableFeedSnapshot(snapshotPath)).toMatchObject({ etag: '"stable"' });
    expect(
      (await readdir(path.dirname(snapshotPath))).filter((name) => name.includes('.tmp-')),
    ).toEqual([]);
  });
});
