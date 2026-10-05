import type { SafeHttpClient } from '../crawler/http-client.js';
import { AtsResponseError } from '../ats/http.js';
import {
  attributeStreamNetworkRequests,
  networkAttemptFields,
  newNetworkAttemptCounters,
} from './discovery-attribution.js';
import {
  completeAudit,
  discoveryAudit,
  incompleteAudit,
  httpUrl,
  numberValue,
  record,
  sourceFailure,
  stringValue,
} from './discovery-shared.js';
import type { DiscoveryRun, DiscoverySourceAudit, DiscoveryVacancyAudit, GlobalRemoteConfig } from './models.js';
import { MpsvScanLimitReached, MpsvSnapshotError, MpsvSnapshotParser } from './mpsv-cz-snapshot.js';

/**
 * Czech Ministry of Labour and Social Affairs (MPSV) / Labour Office of the Czech Republic (Urad
 * prace CR) open vacancy dataset "Volna mista za celou CR" (`volna-mista`).
 *
 * Evidence (checked live 2026-10-05; see docs/job-source-evidence.md):
 * - Directory https://data.mpsv.cz/od/soubory/volna-mista/ publishes `volna-mista.json`,
 *   `.json.gz`, `.jsonld(.gz)`, `volna-mista.schema.json` and `volna-mista-metadata.jsonld`. No
 *   key, login or registration; the DCAT metadata names MPSV as publisher and author, daily
 *   update frequency, "no copyright work", "database not protected by sui generis right", and
 *   flags the payload as containing personal data (`osobni_udaje`).
 * - The JSON Schema (draft-04) documents `{ polozky: [...] }`. Code-list fields are `{ id }`
 *   references (`Obec/554782`, `TypMzdy/mesic`, ...) resolved against the sibling
 *   `/od/soubory/ciselniky/*.json` code lists, which this adapter downloads (the largest, `obce`,
 *   is ~0.9 MB) so geography is named by the official register rather than guessed.
 * - A full snapshot is ~17 MB gzip / ~185 MB decoded (about 50k records), so it is stream-parsed
 *   record by record (`mpsv-cz-snapshot.ts`) and only a bounded number of normalized rows are
 *   retained.
 * - The payload has no per-vacancy detail URL. `urlAdresa` is the employer's own page and is
 *   usually null. When it is a valid http(s) URL it is kept as the link; otherwise the row links
 *   to the official dataset page with a record fragment. That is an honest dataset link, not an
 *   invented job page, and the identity layer treats `data.mpsv.cz` pages as generic listings so
 *   rows never merge on the shared dataset URL.
 *
 * Increment files (`volna-mista-prirustek-YYYY-MM-DD.json`) are deliberately NOT used. Their
 * schema is the snapshot schema plus a `typyZmenOpenData` code reference, but the matching code
 * list (`typy-zmen-opendata.json`) is published empty, and neither the schema nor the metadata
 * states how a deletion is represented or in which order files must be replayed. Without that
 * proof a replay could resurrect removed vacancies, so each run seeds from the complete snapshot
 * only and the next snapshot is the reconciliation: any vacancy absent from it, expired, or
 * marked not-for-publication is simply not emitted.
 *
 * Personal data: the payload carries contact-person names, titles, positions, e-mail addresses and
 * phone numbers (`prvniKontaktSeZamestnavatelem`, `pracoviste[].email/telefon`). Normalization is
 * a strict whitelist: those objects are never read, nothing outside the whitelisted fields is
 * copied into the row, the content hash input, logs or error messages, and e-mail addresses and
 * phone-number-like sequences that employers typed into the free-text note are redacted.
 * Employer names are kept because they are the employer identity in the public register (they can
 * be a sole proprietor's trade name).
 */
export const MPSV_CZ_ORIGIN = 'https://data.mpsv.cz';
export const MPSV_CZ_SNAPSHOT_URL = `${MPSV_CZ_ORIGIN}/od/soubory/volna-mista/volna-mista.json.gz`;
export const MPSV_CZ_SCHEMA_URL = `${MPSV_CZ_ORIGIN}/od/soubory/volna-mista/volna-mista.schema.json`;
export const MPSV_CZ_METADATA_URL = `${MPSV_CZ_ORIGIN}/od/soubory/volna-mista/volna-mista-metadata.jsonld`;
export const MPSV_CZ_DATASET_PAGE_URL = `${MPSV_CZ_ORIGIN}/web/data/volna-mista-za-celou-cr`;
export const MPSV_CZ_CODE_LIST_BASE_URL = `${MPSV_CZ_ORIGIN}/od/soubory/ciselniky`;

export const MPSV_CZ_TIMEOUT_MS = 10 * 60 * 1_000;
export const MPSV_CZ_MAX_RESPONSE_BYTES = 1024 * 1024 * 1024;
export const MPSV_CZ_MAX_RETAINED_RECORDS = 5_000;
const MPSV_CZ_CODE_LIST_MAX_BYTES = 4 * 1024 * 1024;
const MPSV_CZ_MAX_STALE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MPSV_CZ_MAX_CONTRACT_VIOLATION_SHARE = 0.05;
const MPSV_CZ_MAX_DESCRIPTION_CHARS = 2_000;
const SOURCE_ID = 'mpsv_cz:snapshot';
const SOURCE_NOTE =
  'Source: open vacancy data of the Czech Ministry of Labour and Social Affairs and the Labour Office of the Czech Republic.';

/**
 * Every top-level key the schema defines that this adapter relies on. Each must appear (even as
 * null) in at least one record: the publisher emits all keys, so a key missing from every record
 * means it was renamed or dropped and the mapping would silently go blank.
 */
export const MPSV_CZ_CORE_KEYS = [
  'portalId',
  'referencniCislo',
  'datumVlozeni',
  'datumZmeny',
  'mesicniMzdaOd',
  'mesicniMzdaDo',
  'typMzdy',
  'pozadovanaProfese',
  'zamestnavatel',
  'mistoVykonuPrace',
  'zverejnovat',
  'expirace',
  'urlAdresa',
  'pracovnePravniVztahy',
  'upresnujiciInformace',
] as const;

/**
 * Keys that must never reach a row, report, log or fixture. The fixture scan test and the
 * normalization tests both assert against this list.
 */
export const MPSV_CZ_PERSONAL_DATA_KEYS = [
  'prvniKontaktSeZamestnavatelem',
  'komuSeHlasit',
  'kdeSeHlasit',
  'jmeno',
  'prijmeni',
  'titulPredJmenem',
  'titulZaJmenem',
  'poziceVeSpolecnosti',
  'email',
  'telefon',
] as const;

const CODE_LISTS = {
  obec: 'obce',
  okres: 'okresy',
  kraj: 'kraje',
  relationship: 'pracovnepravni-vztahy',
  shift: 'smennosti',
  education: 'vzdelani-detailni-kategorie',
  skill: 'dovednosti',
  language: 'jazyky',
  languageLevel: 'urovne-znalosti-jazyka',
} as const;

export type MpsvCodeListName = keyof typeof CODE_LISTS;
export type MpsvLookups = Readonly<Record<MpsvCodeListName, ReadonlyMap<string, string>>>;

export function emptyMpsvLookups(): MpsvLookups {
  return {
    obec: new Map(),
    okres: new Map(),
    kraj: new Map(),
    relationship: new Map(),
    shift: new Map(),
    education: new Map(),
    skill: new Map(),
    language: new Map(),
    languageLevel: new Map(),
  };
}

/** Parses an official code list (`{ polozky: [{ id, nazev: { cs } }] }`) into id -> Czech label. */
export function parseMpsvCodeList(body: string): Map<string, string> {
  let root: unknown;
  try {
    root = JSON.parse(body) as unknown;
  } catch {
    throw new MpsvContractError('code list is not valid JSON');
  }
  const items = record(root)?.polozky;
  if (!Array.isArray(items)) throw new MpsvContractError('code list has no polozky array');
  const labels = new Map<string, string>();
  for (const item of items) {
    const entry = record(item);
    const id = stringValue(entry?.id);
    const name = stringValue(record(entry?.nazev)?.cs);
    if (id !== null && name !== null) labels.set(id, name);
  }
  return labels;
}

class MpsvContractError extends Error {}

function codeId(value: unknown): string | null {
  return stringValue(record(value)?.id);
}

function label(map: ReadonlyMap<string, string>, id: string | null): string | null {
  return id === null ? null : (map.get(id) ?? null);
}

const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
/** `jan(at)firma.cz`, `jan [at] firma . cz`, `jan{zavinac}firma.cz`. */
const OBFUSCATED_EMAIL_PATTERN =
  /[\p{L}\p{N}._%+-]+\p{Zs}*[([{<]\p{Zs}*(?:at|zavin[aá]č)\p{Zs}*[)\]}>]\p{Zs}*[\p{L}\p{N}-]+(?:\p{Zs}*\.\p{Zs}*[\p{L}\p{N}-]+)*\p{Zs}*\.\p{Zs}*\p{L}{2,}/giu;
const INTERNATIONAL_PHONE_PATTERN = /(?:\+|\b00)\d{1,3}\p{Zs}?(?:\d\p{Zs}?){8,12}/gu;
/** Nine or more digits with any mix of spaces, dots and dashes between them. */
const LONG_DIGIT_RUN_PATTERN = /(?<!\d)\d(?:[\p{Zs}.-]*\d){8,}(?!\d)/gu;
const SALARY_FIGURE_PATTERN = /^(?:\d+|\d{1,3}(?:[\p{Zs}.]\d{3})+)$/u;

/**
 * A two-part range such as `35000-45000` or `35 000 - 45 000` (a salary): each side is one plain or
 * thousands-grouped number of at most seven digits, so a phone number split in two does not match.
 */
function isSalaryRange(run: string): boolean {
  const sides = run.split(/\p{Zs}*[-–]\p{Zs}*/u);
  return (
    sides.length === 2 &&
    sides.every((side) => SALARY_FIGURE_PATTERN.test(side) && side.replace(/\D/gu, '').length <= 7)
  );
}

/**
 * Removes e-mail addresses and phone-number-like sequences from an employer-typed free-text note.
 * Digit runs of nine or more digits (any spaces, dots or dashes between them) and international
 * prefixes are removed; a plain two-part range like "35000-45000" survives as a salary. A person's name typed into free text cannot be detected
 * deterministically; that residual risk is documented in docs/job-source-evidence.md.
 */
export function redactMpsvFreeText(text: string): string {
  return text
    .replace(EMAIL_PATTERN, '')
    .replace(OBFUSCATED_EMAIL_PATTERN, '')
    .replace(INTERNATIONAL_PHONE_PATTERN, '')
    .replace(LONG_DIGIT_RUN_PATTERN, (run) => (isSalaryRange(run) ? run : ''))
    .replace(/[\p{Zs}\t]{2,}/gu, ' ')
    .trim();
}

function czechToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function dateOnly(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) return undefined;
  return Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? undefined : value;
}

function isoDateTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

/** `zverejnovat` ("how to publish"): `ne` is "do not publish". Unknown codes are excluded. */
const PUBLISH_CODES = new Map<string, 'disclosed' | 'undisclosed'>([
  ['ZverejnovatVpm/ano', 'disclosed'],
  ['ZverejnovatVpm/anoeu', 'disclosed'],
  ['ZverejnovatVpm/anosp', 'undisclosed'],
]);

/** `typMzdy` is "monthly or hourly" (`Kc/mesic`, `Kc/hod.`); anything else is left unmapped. */
function salaryPeriod(typeId: string | null): string | null {
  switch (typeId) {
    case 'TypMzdy/mesic':
      return 'monthly';
    case 'TypMzdy/hod':
      return 'hourly';
    default:
      return null;
  }
}

/**
 * Only the two codes whose official label states the hours outright are mapped. The three others
 * (`dpp`, `dpc` agreements and `sluzebni` civil-service relationship) have no unambiguous match in
 * this app's employment vocabulary, so they stay unmapped here and appear verbatim in the
 * description instead.
 */
function employmentTypeFor(ids: readonly string[]): string | null {
  const mapped = new Set<string>();
  for (const id of ids) {
    if (id === 'PracovnepravniVztah/plny') mapped.add('Full-time');
    if (id === 'PracovnepravniVztah/zkraceny') mapped.add('Part-time');
  }
  return mapped.size === 0 ? null : [...mapped].join(', ');
}

type Workplace = Readonly<{ obec: string | null; kraj: string | null; okres: string | null }>;

function workplaceNames(workplace: Record<string, unknown> | null, lookups: MpsvLookups): string {
  if (workplace === null) return 'Czechia';
  const places: string[] = [];
  const add = (place: string | null): void => {
    if (place !== null && !places.includes(place)) places.push(place);
  };
  const workplaces = Array.isArray(workplace.pracoviste) ? workplace.pracoviste : [];
  for (const entry of workplaces) {
    const address = record(record(entry)?.adresa);
    if (address === null) continue;
    const found: Workplace = {
      obec: label(lookups.obec, codeId(address.obec)),
      kraj: label(lookups.kraj, codeId(address.kraj)),
      okres: label(lookups.okres, codeId(address.okres)),
    };
    if (found.obec !== null) {
      add(
        found.kraj !== null && !found.kraj.toLowerCase().includes(found.obec.toLowerCase())
          ? `${found.obec}, ${found.kraj}`
          : found.obec,
      );
    } else if (found.okres !== null) {
      add(`${found.okres} District`);
    } else {
      add(found.kraj);
    }
  }
  if (places.length === 0) {
    const obec = label(lookups.obec, codeId(workplace.obec));
    if (obec !== null) add(obec);
    for (const district of Array.isArray(workplace.okresy) ? workplace.okresy : []) {
      const name = label(lookups.okres, codeId(district));
      if (name !== null) add(`${name} District`);
    }
  }
  if (places.length === 0) return 'Czechia';
  const shown = places.slice(0, 3).join(' / ');
  return `${shown}${places.length > 3 ? ` / +${places.length - 3} more` : ''}, Czechia`;
}

function listIds(value: unknown, pick: (entry: unknown) => string | null): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const id = pick(entry);
        return id === null ? [] : [id];
      })
    : [];
}

export type MpsvRecordResult =
  | { readonly kind: 'vacancy'; readonly vacancy: DiscoveryVacancyAudit }
  | { readonly kind: 'skipped'; readonly reason: 'expired' | 'not_published' }
  | { readonly kind: 'invalid' };

/**
 * Normalizes one snapshot entry through a strict whitelist. Reads only the fields listed below;
 * `prvniKontaktSeZamestnavatelem` and `pracoviste[].email/telefon` are never touched.
 */
export function normalizeMpsvRecord(
  raw: unknown,
  lookups: MpsvLookups,
  options: { today: string; minimumAnnualBaseUsd: number | null },
): MpsvRecordResult {
  const entry = record(raw);
  if (entry === null) return { kind: 'invalid' };
  const portalId = entry.portalId;
  const rawProfession = stringValue(record(entry.pozadovanaProfese)?.cs);
  const professionName = rawProfession === null ? null : redactMpsvFreeText(rawProfession);
  const publishId = codeId(entry.zverejnovat);
  if (
    typeof portalId !== 'number' ||
    !Number.isSafeInteger(portalId) ||
    portalId <= 0 ||
    publishId === null
  ) {
    return { kind: 'invalid' };
  }
  const expiry = dateOnly(entry.expirace);
  if (expiry === undefined) return { kind: 'invalid' };
  const publication = PUBLISH_CODES.get(publishId);
  if (publication === undefined) return { kind: 'skipped', reason: 'not_published' };
  if (expiry !== null && expiry < options.today) return { kind: 'skipped', reason: 'expired' };
  if (professionName === null || professionName.length === 0) return { kind: 'invalid' };

  const employer = record(entry.zamestnavatel);
  const rawEmployerName = publication === 'disclosed' ? stringValue(employer?.nazev) : null;
  const employerName = rawEmployerName === null ? null : redactMpsvFreeText(rawEmployerName);
  const company = employerName === null || employerName.length === 0 ? 'Employer not disclosed' : employerName;

  const typeId = codeId(entry.typMzdy);
  const salaryFrom = numberValue(entry.mesicniMzdaOd);
  const salaryTo = numberValue(entry.mesicniMzdaDo);
  const advertisedMinimum = salaryFrom !== null && salaryFrom > 0 ? salaryFrom : null;
  const advertisedMaximum = salaryTo !== null && salaryTo > 0 ? salaryTo : null;
  const hasSalary = advertisedMinimum !== null || advertisedMaximum !== null;

  const relationshipIds = listIds(entry.pracovnePravniVztahy, codeId);
  const relationshipLabels = relationshipIds.flatMap((id) => {
    const name = label(lookups.relationship, id);
    return name === null ? [] : [name];
  });
  const shift = label(lookups.shift, codeId(entry.smennost));
  const education = label(lookups.education, codeId(entry.minPozadovaneVzdelani));
  const hours = numberValue(entry.pocetHodinTydne);
  const positions = numberValue(entry.pocetMist);
  const startDate = dateOnly(entry.terminZahajeniPracovnihoPomeru);
  const fixedTermEnd = dateOnly(entry.terminUkonceniPracovnihoPomeru);
  const skills = Array.isArray(entry.pozadovanaDovednost)
    ? entry.pozadovanaDovednost.flatMap((item) => {
        const skill = record(item);
        const name = label(lookups.skill, codeId(skill?.dovednost));
        const note = stringValue(skill?.popis);
        const text = [name, note === null ? null : redactMpsvFreeText(note)].filter(
          (part): part is string => part !== null && part.length > 0,
        );
        return text.length === 0 ? [] : [text.join(': ')];
      })
    : [];
  const languages = Array.isArray(entry.pozadovanaJazykovaZnalost)
    ? entry.pozadovanaJazykovaZnalost.flatMap((item) => {
        const language = record(item);
        const name = label(lookups.language, codeId(language?.jazyk));
        const level = label(lookups.languageLevel, codeId(language?.urovenZnalosti));
        return name === null ? [] : [level === null ? name : `${name} (${level})`];
      })
    : [];
  const note = stringValue(record(entry.upresnujiciInformace)?.cs);
  const redactedNote = note === null ? null : redactMpsvFreeText(note);

  const maxLine = advertisedMaximum !== null && advertisedMaximum !== advertisedMinimum;
  const description = [
    hasSalary
      ? `Salary: ${[advertisedMinimum, maxLine ? advertisedMaximum : null]
          .filter((value): value is number => value !== null)
          .join(' to ')} CZK${typeId === 'TypMzdy/hod' ? ' per hour' : typeId === 'TypMzdy/mesic' ? ' per month' : ''}`
      : null,
    relationshipLabels.length === 0 ? null : `Employment relationship: ${relationshipLabels.join(', ')}`,
    positions === null ? null : `Open positions: ${positions}`,
    hours === null ? null : `Hours per week: ${hours}`,
    shift === null ? null : `Shift pattern: ${shift}`,
    startDate === null || startDate === undefined ? null : `Planned start: ${startDate}`,
    fixedTermEnd === null || fixedTermEnd === undefined ? null : `Fixed term until: ${fixedTermEnd}`,
    education === null ? null : `Minimum education: ${education}`,
    skills.length === 0 ? null : `Skills: ${skills.join('; ')}`,
    languages.length === 0 ? null : `Languages: ${languages.join('; ')}`,
    expiry === null ? null : `Listed until: ${expiry}`,
    redactedNote === null || redactedNote.length === 0 ? null : redactedNote,
    SOURCE_NOTE,
  ]
    .filter((line): line is string => line !== null && line.length > 0)
    .join('\n');
  const boundedDescription =
    description.length > MPSV_CZ_MAX_DESCRIPTION_CHARS
      ? `${description.slice(0, MPSV_CZ_MAX_DESCRIPTION_CHARS)}...\n${SOURCE_NOTE}`
      : description;

  const location = workplaceNames(record(entry.mistoVykonuPrace), lookups);
  const employerUrl = httpUrl(entry.urlAdresa);
  const datasetUrl = `${MPSV_CZ_DATASET_PAGE_URL}#VolneMisto-${portalId}`;
  const employerLink = employerUrl === null ? null : new URL(employerUrl);
  const url =
    employerLink !== null && employerLink.username === '' && employerLink.password === ''
      ? employerLink.href
      : datasetUrl;
  const referenceNumber = stringValue(entry.referencniCislo);

  const vacancy = discoveryAudit({
    key: `mpsv_cz:${portalId}`,
    provider: 'mpsv_cz',
    company,
    title: professionName,
    url,
    location,
    employmentType: employmentTypeFor(relationshipIds),
    currency: advertisedMinimum === null ? null : 'CZK',
    salaryPeriod: advertisedMinimum === null ? null : salaryPeriod(typeId),
    advertisedMinimum,
    salaryProvenance: 'reviewed_structured',
    description: boundedDescription,
    postedAt: isoDateTime(entry.datumVlozeni),
    // Content-hash input is built from the whitelisted, redacted values only.
    raw: {
      portalId,
      referenceNumber,
      changedAt: stringValue(entry.datumZmeny),
      title: professionName,
      company,
      location,
      salary: [advertisedMinimum, advertisedMaximum, typeId],
      expiry,
      description: boundedDescription,
    },
    minimumAnnualBaseUsd: options.minimumAnnualBaseUsd,
  });
  return { kind: 'vacancy', vacancy };
}

type MpsvStreamClient = Pick<SafeHttpClient, 'streamGet'>;

export type MpsvCzDiscoveryOptions = {
  now?: () => Date;
  snapshotUrl?: string;
  codeListBaseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Rows kept per run; the rest of the snapshot is still scanned and counted. */
  maxRetainedRecords?: number;
  /** Stop reading after this many snapshot entries (used by the capped live check). */
  maxScannedRecords?: number;
};

function failureSource(
  url: string,
  requests: number,
  error: unknown,
  counters: ReturnType<typeof newNetworkAttemptCounters>,
): DiscoverySourceAudit {
  return {
    id: SOURCE_ID,
    provider: 'mpsv_cz',
    url,
    requests,
    listings: 0,
    ...sourceFailure(error),
    ...networkAttemptFields(counters),
  };
}

async function loadCodeList(
  http: ReturnType<typeof attributeStreamNetworkRequests>,
  url: string,
  options: { timeoutMs: number },
): Promise<Map<string, string>> {
  const chunks: Uint8Array[] = [];
  await http.streamGet(url, {
    allowedOrigins: [MPSV_CZ_ORIGIN],
    timeoutMs: Math.min(options.timeoutMs, 60_000),
    maxResponseBytes: MPSV_CZ_CODE_LIST_MAX_BYTES,
    onChunk(chunk) {
      chunks.push(chunk.slice());
    },
  });
  return parseMpsvCodeList(Buffer.concat(chunks).toString('utf8'));
}

/** Newest change first: `datumZmeny`, then `datumVlozeni`, then the larger portal ID as a tiebreak. */
type Rank = { readonly time: number; readonly portalId: number };

function rankOf(entry: Record<string, unknown> | null, portalId: number): Rank {
  const changed = Date.parse(stringValue(entry?.datumZmeny) ?? '');
  const inserted = Date.parse(stringValue(entry?.datumVlozeni) ?? '');
  const time = Number.isFinite(changed) ? changed : Number.isFinite(inserted) ? inserted : Number.NEGATIVE_INFINITY;
  return { time, portalId };
}

function isBetter(left: Rank, right: Rank): boolean {
  return left.time !== right.time ? left.time > right.time : left.portalId > right.portalId;
}

type HeapEntry = { rank: Rank; vacancy: DiscoveryVacancyAudit; index: number };

/**
 * Bounded top-N of the newest rows: a min-heap whose root is the worst retained row, so memory
 * stays at N rows and the result does not depend on file order. Entries track their own index so a
 * superseded duplicate can be removed.
 */
class NewestRows {
  readonly #heap: HeapEntry[] = [];
  readonly #capacity: number;

  public constructor(capacity: number) {
    this.#capacity = capacity;
  }

  public get size(): number {
    return this.#heap.length;
  }

  public get full(): boolean {
    return this.#heap.length >= this.#capacity;
  }

  public worst(): HeapEntry | undefined {
    return this.#heap[0];
  }

  /** Returns the stored entry (null when not good enough to keep) and any row it pushed out. */
  public add(
    rank: Rank,
    vacancy: DiscoveryVacancyAudit,
  ): { entry: HeapEntry | null; evicted: HeapEntry | null } {
    if (this.#capacity <= 0) return { entry: null, evicted: null };
    let evicted: HeapEntry | null = null;
    if (this.full) {
      const worst = this.#heap[0];
      if (worst === undefined || !isBetter(rank, worst.rank)) return { entry: null, evicted: null };
      this.remove(worst);
      evicted = worst;
    }
    const entry: HeapEntry = { rank, vacancy, index: this.#heap.length };
    this.#heap.push(entry);
    this.#up(entry.index);
    return { entry, evicted };
  }

  public remove(entry: HeapEntry): void {
    const last = this.#heap.pop();
    if (last === undefined || last === entry) return;
    this.#heap[entry.index] = last;
    last.index = entry.index;
    this.#up(last.index);
    this.#down(last.index);
  }

  public rows(): DiscoveryVacancyAudit[] {
    return [...this.#heap]
      .sort((a, b) => a.rank.portalId - b.rank.portalId)
      .map((entry) => entry.vacancy);
  }

  #swap(a: number, b: number): void {
    const left = this.#heap[a];
    const right = this.#heap[b];
    if (left === undefined || right === undefined) return;
    this.#heap[a] = right;
    this.#heap[b] = left;
    right.index = a;
    left.index = b;
  }

  #up(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const child = this.#heap[index];
      const above = this.#heap[parent];
      if (child === undefined || above === undefined || !isBetter(above.rank, child.rank)) return;
      this.#swap(index, parent);
      index = parent;
    }
  }

  #down(start: number): void {
    let index = start;
    for (;;) {
      let worst = index;
      for (const next of [index * 2 + 1, index * 2 + 2]) {
        const candidate = this.#heap[next];
        const current = this.#heap[worst];
        if (candidate !== undefined && current !== undefined && isBetter(current.rank, candidate.rank)) worst = next;
      }
      if (worst === index) return;
      this.#swap(index, worst);
      index = worst;
    }
  }
}

const ACCEPTED_CONTENT_TYPES = ['application/x-gzip', 'application/gzip', 'application/json', 'application/octet-stream'];

/**
 * Seeds from the official full snapshot only. Stateless like every other discovery source: the
 * rows emitted by one run are the complete current picture, so a vacancy removed upstream, expired
 * or switched to not-for-publication is absent from the next run and disappears on reconciliation.
 *
 * Failure model: HTTP errors, an empty snapshot, schema drift (a core key missing everywhere, or
 * more than 5% of entries violating the contract), a corrupt or truncated gzip, truncated JSON and
 * a stale snapshot are each reported on the single `mpsv_cz:snapshot` source row. A failed run
 * emits no vacancies, and nothing here throws, so other sources are unaffected.
 */
export async function runMpsvCzDiscovery(
  http: MpsvStreamClient,
  config: Pick<GlobalRemoteConfig, 'minimumAnnualBaseUsd'>,
  options: MpsvCzDiscoveryOptions = {},
): Promise<DiscoveryRun> {
  const now = options.now?.() ?? new Date();
  const snapshotUrl = options.snapshotUrl ?? MPSV_CZ_SNAPSHOT_URL;
  const codeListBase = options.codeListBaseUrl ?? MPSV_CZ_CODE_LIST_BASE_URL;
  const timeoutMs = options.timeoutMs ?? MPSV_CZ_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MPSV_CZ_MAX_RESPONSE_BYTES;
  const maxRetained = options.maxRetainedRecords ?? MPSV_CZ_MAX_RETAINED_RECORDS;
  const maxScanned = options.maxScannedRecords ?? Number.POSITIVE_INFINITY;
  const counters = newNetworkAttemptCounters();
  const streamHttp = attributeStreamNetworkRequests(http, counters);
  let requests = 0;
  const today = czechToday(now);

  const lookupMaps: Record<MpsvCodeListName, Map<string, string>> = {
    obec: new Map(),
    okres: new Map(),
    kraj: new Map(),
    relationship: new Map(),
    shift: new Map(),
    education: new Map(),
    skill: new Map(),
    language: new Map(),
    languageLevel: new Map(),
  };
  const degraded: string[] = [];
  await Promise.all(
    (Object.keys(CODE_LISTS) as MpsvCodeListName[]).map(async (name) => {
      requests += 1;
      try {
        lookupMaps[name] = await loadCodeList(streamHttp, `${codeListBase}/${CODE_LISTS[name]}.json`, { timeoutMs });
      } catch {
        degraded.push(CODE_LISTS[name]);
      }
    }),
  );
  degraded.sort();

  const retained = new NewestRows(maxRetained);
  const seen = new Map<number, { rank: Rank; entry: HeapEntry | null }>();
  const presentKeys = new Set<string>();
  let scanned = 0;
  let expired = 0;
  let notPublished = 0;
  let invalid = 0;
  let overCap = 0;
  let duplicates = 0;
  let scanLimited = false;
  const parser = new MpsvSnapshotParser({
    onRecord(raw) {
      if (scanned >= maxScanned) {
        scanLimited = true;
        throw new MpsvScanLimitReached();
      }
      scanned += 1;
      const entry = record(raw);
      if (entry !== null) for (const key of MPSV_CZ_CORE_KEYS) if (key in entry) presentKeys.add(key);
      const result = normalizeMpsvRecord(raw, lookupMaps, {
        today,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      });
      if (result.kind === 'invalid') {
        invalid += 1;
      } else if (result.kind === 'skipped') {
        if (result.reason === 'expired') expired += 1;
        else notPublished += 1;
      } else {
        const portalId = Number(result.vacancy.key.slice('mpsv_cz:'.length));
        const rank = rankOf(entry, portalId);
        const previous = seen.get(portalId);
        if (previous !== undefined) {
          // Duplicate portal ID: the version with the later change date wins, whatever the file order.
          duplicates += 1;
          if (!(rank.time > previous.rank.time)) return;
          if (previous.entry !== null) retained.remove(previous.entry);
          else overCap -= 1;
        }
        const added = retained.add(rank, result.vacancy);
        if (added.evicted !== null) {
          // A row pushed out by a newer one is no longer retained.
          const pushedOut = seen.get(added.evicted.rank.portalId);
          if (pushedOut !== undefined) pushedOut.entry = null;
          overCap += 1;
        }
        seen.set(portalId, { rank, entry: added.entry });
        if (added.entry === null) overCap += 1;
      }
    },
  });

  try {
    requests += 1;
    const response = await streamHttp.streamGet(snapshotUrl, {
      allowedOrigins: [MPSV_CZ_ORIGIN],
      timeoutMs,
      maxResponseBytes,
      maxRetries: 0,
      onChunk(chunk) {
        parser.write(chunk);
      },
    });
    if (response.status !== 200) {
      throw new AtsResponseError('mpsv_cz', `unexpected HTTP status ${response.status}`, response.status);
    }
    const contentType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (contentType !== '' && !ACCEPTED_CONTENT_TYPES.includes(contentType)) {
      throw new AtsResponseError('mpsv_cz', `unexpected content type ${contentType}`, response.status);
    }
    await parser.finish();
    const lastModified = Date.parse(response.headers['last-modified'] ?? '');
    return finishRun({
      response,
      snapshotUrl,
      requests,
      counters,
      vacancies: retained.rows(),
      degraded,
      stale: Number.isFinite(lastModified) && now.getTime() - lastModified > MPSV_CZ_MAX_STALE_AGE_MS,
      stats: { scanned, expired, notPublished, invalid, overCap, duplicates, scanLimited },
      presentKeys,
    });
  } catch (error) {
    parser.dispose();
    if (error instanceof MpsvScanLimitReached) {
      return finishRun({
        response: null,
        snapshotUrl,
        requests,
        counters,
        vacancies: retained.rows(),
        degraded,
        stale: false,
        stats: { scanned, expired, notPublished, invalid, overCap, duplicates, scanLimited: true },
        presentKeys,
      });
    }
    const wrapped =
      error instanceof MpsvSnapshotError || error instanceof MpsvContractError
        ? new AtsResponseError('mpsv_cz', error.message, null, { cause: error })
        : error;
    return { sources: [failureSource(snapshotUrl, requests, wrapped, counters)], vacancies: [] };
  }
}

type RunStats = {
  scanned: number;
  expired: number;
  notPublished: number;
  invalid: number;
  overCap: number;
  duplicates: number;
  scanLimited: boolean;
};

function finishRun(input: {
  response: { headers: Readonly<Record<string, string>> } | null;
  snapshotUrl: string;
  requests: number;
  counters: ReturnType<typeof newNetworkAttemptCounters>;
  vacancies: DiscoveryVacancyAudit[];
  degraded: string[];
  stale: boolean;
  stats: RunStats;
  presentKeys: ReadonlySet<string>;
}): DiscoveryRun {
  const { stats } = input;
  const fail = (message: string): DiscoveryRun => ({
    sources: [failureSource(input.snapshotUrl, input.requests, new AtsResponseError('mpsv_cz', message), input.counters)],
    vacancies: [],
  });
  if (input.stale) {
    return fail('snapshot is stale: its Last-Modified date is more than 7 days old, so no vacancies were imported');
  }
  if (stats.scanned === 0) return fail('snapshot contains no vacancy records (empty data)');
  const missing = MPSV_CZ_CORE_KEYS.filter((key) => !input.presentKeys.has(key));
  if (missing.length > 0 && !stats.scanLimited) {
    return fail(`schema drift: no record carries the expected field(s) ${missing.join(', ')}`);
  }
  if (stats.invalid / stats.scanned > MPSV_CZ_MAX_CONTRACT_VIOLATION_SHARE) {
    return fail(`schema drift: ${stats.invalid} of ${stats.scanned} records violate the documented contract`);
  }
  if (input.vacancies.length === 0 && stats.overCap === 0) {
    return fail('snapshot contains no active, published vacancies (empty data)');
  }
  const notes: string[] = [];
  if (stats.scanLimited) notes.push(`scan stopped after ${stats.scanned} records by request`);
  if (stats.overCap > 0) {
    notes.push(`kept the ${input.vacancies.length} most recently changed active vacancies; ${stats.overCap} older ones were not retained`);
  }
  if (stats.invalid > 0) notes.push(`${stats.invalid} records were skipped for violating the contract`);
  if (input.degraded.length > 0) {
    notes.push(`code list(s) unavailable, labels left blank: ${input.degraded.join(', ')}`);
  }
  const complete = notes.length === 0;
  const source: DiscoverySourceAudit = {
    id: SOURCE_ID,
    provider: 'mpsv_cz',
    url: input.snapshotUrl,
    requests: input.requests,
    listings: input.vacancies.length,
    status: complete ? 'success' : 'partial',
    error: complete ? null : notes.join('; '),
    ...networkAttemptFields(input.counters),
    ...(complete ? completeAudit() : incompleteAudit(notes.join('; '))),
  };
  return { sources: [source], vacancies: input.vacancies };
}
