import {
  detectAshbySource,
  detectGreenhouseSource,
  detectLeverSource,
  detectPersonioSource,
  detectRecruiteeSource,
} from '../ats/detection.js';
import { optionalString } from '../ats/shared.js';
import type { AtsProvider } from '../domain/models.js';

export type AtsRosterProvider = Extract<
  AtsProvider,
  'greenhouse' | 'lever' | 'ashby' | 'recruitee' | 'personio'
>;

/**
 * The five ATS types this ticket is scoped to (see issue #251). Rippling is intentionally absent:
 * this repo has no Rippling parser yet (tracked separately in #147), and every other ATS type in
 * `ats/*.ts` (teamtailor, smartrecruiters, workday, successfactors, workable) has no matching CSV in
 * `kalil0321/ats-scrapers`, so there is nothing to import for them here.
 */
export const ATS_ROSTER_PROVIDERS: readonly AtsRosterProvider[] = [
  'greenhouse',
  'lever',
  'ashby',
  'recruitee',
  'personio',
];

/**
 * One verified `(provider, slug)` company from the external roster, plus the two fields the ATS
 * adapters actually need to build a `CareerSourceDescriptor` (`baseUrl`, for the adapters that
 * resolve a region or tenant from it -- see `ats/lever.ts` and `ats/personio.ts`) and a display-only
 * company name. Deliberately four fields, nothing more: this repo has a hard "no default
 * role/country/salary bias" rule (see docs/job-source-policy.md and CONTRIBUTING.md), and the prior
 * company-discovery system removed in `aa6ec22` was removed specifically for violating it. A country
 * field does not exist anywhere on this type, so no later code path in this ticket can read, filter,
 * or rank by one, even by accident.
 */
export type AtsRosterEntry = {
  provider: AtsRosterProvider;
  slug: string;
  baseUrl: string;
  company: string;
};

const ATS_ROSTER_SOURCE_ORIGIN = 'https://storage.stapply.ai';

/** Per-provider CSV published by `kalil0321/ats-scrapers` (see issue #251's source citation). */
export function atsRosterCsvUrl(provider: AtsRosterProvider): string {
  return `${ATS_ROSTER_SOURCE_ORIGIN}/jobhive/v1/${provider}/companies.csv`;
}

type Detected = { boardIdentifier: string; baseUrl: string } | null;

/**
 * Reuses this repo's own already-reviewed `detect*Source` parsers (`ats/detection.ts`) to turn the
 * CSV's `url` column into `(boardIdentifier, baseUrl)`, rather than re-deriving those from the
 * `slug` column with fresh, untested logic. This also gets the Lever EU-vs-US host distinction and
 * the Personio `.de`-vs-`.com` tenant host for free, both of which the adapters require exactly
 * right (see `ats/lever.ts#apiOrigin` and `ats/personio.ts#feedUrl`).
 */
const DETECTORS: Record<AtsRosterProvider, (input: string) => Detected> = {
  greenhouse: detectGreenhouseSource,
  lever: detectLeverSource,
  ashby: detectAshbySource,
  recruitee: detectRecruiteeSource,
  personio: detectPersonioSource,
};

export type AtsRosterCsvParseResult = {
  entries: AtsRosterEntry[];
  rawRowCount: number;
  invalidRowCount: number;
  duplicateRowCount: number;
};

/**
 * Splits one RFC 4180 CSV record into its raw fields. The observed source only ever quotes the
 * leading `name` column (when it contains a comma, e.g. `"ETCH, Inc",etchinc,https://...`) and never
 * escapes a literal quote inside it, but this still parses generically rather than assuming that
 * shape, so a differently-quoted future export does not silently corrupt company names.
 */
function splitCsvRecord(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * Parses one provider's CSV export into a deduplicated `(provider, slug)` roster. Every row's `url`
 * column is independently re-validated through this repo's own `detect*Source` parser (see
 * `DETECTORS` above) rather than trusted as-is: a row whose URL does not match the expected provider
 * shape is dropped and counted as invalid, so a malformed export can only ever shrink the roster, not
 * introduce an unverifiable entry. Rows are deduplicated by the detected board identifier (not the
 * raw `slug` column), matching what the ATS adapters actually key on.
 */
export function parseAtsRosterCsv(csv: string, provider: AtsRosterProvider): AtsRosterCsvParseResult {
  const detect = DETECTORS[provider];
  const lines = csv.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const dataLines = lines.length > 0 && lines[0]?.trim().toLowerCase() === 'name,slug,url'
    ? lines.slice(1)
    : lines;

  const byIdentifier = new Map<string, AtsRosterEntry>();
  let invalidRowCount = 0;
  let duplicateRowCount = 0;
  for (const line of dataLines) {
    const fields = splitCsvRecord(line);
    const company = optionalString(fields[0]);
    const url = optionalString(fields[2]);
    if (company === null || url === null) {
      invalidRowCount += 1;
      continue;
    }
    const detected = detect(url);
    if (detected === null) {
      invalidRowCount += 1;
      continue;
    }
    const key = detected.boardIdentifier.toLowerCase();
    if (byIdentifier.has(key)) {
      duplicateRowCount += 1;
      continue;
    }
    byIdentifier.set(key, {
      provider,
      slug: detected.boardIdentifier,
      baseUrl: detected.baseUrl,
      company,
    });
  }

  return {
    entries: [...byIdentifier.values()].sort((left, right) => left.slug.localeCompare(right.slug)),
    rawRowCount: dataLines.length,
    invalidRowCount,
    duplicateRowCount,
  };
}
