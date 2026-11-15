/**
 * Excluded companies (#736): the person's own list of employers that Search hides and Blind Apply
 * skips. Pure and dependency-free, exported as `@open-vacancy-radar/vacancy-engine/excluded-companies`
 * so the Electron main process, the Vite-bundled renderer and the tests share one implementation.
 *
 * Matching is deliberately narrow: exact equality after normalisation, never a substring or a fuzzy
 * match. "Meta" does not exclude "Metaplanet" and "Acme Group" does not match "Acme". Legal-form
 * suffixes are stripped here and only here: `normalizeEmployerName` (duplicate identity in the desktop
 * app) keeps them on purpose, because two legal entities sharing a trading name must stay distinct
 * applications. An exclusion is the opposite case: a person skipping "Acme" means every Acme entity.
 */

export interface ExcludedCompany {
  name: string;
  /** Optional hostnames (`acme.com`). A listing or apply URL on that host or one of its subdomains matches. */
  domains: string[];
}

export const EXCLUDED_COMPANY_LIMITS = {
  entries: 50,
  nameLength: 200,
  domainsPerEntry: 5,
  domainLength: 253,
} as const;

/**
 * Legal-form tokens removed from the end of a normalised name, at most two in a row ("Pty Ltd").
 * Written as they read after punctuation is folded to single spaces ("s r l" for "S.r.l."). Only ever
 * removed as whole trailing words, and never when they are the whole name, so "BV" alone stays "bv".
 */
export const LEGAL_FORM_TOKENS: readonly string[] = [
  'bv', 'b v', 'nv', 'n v', 'vof', 'v o f', 'bvba',
  'gmbh', 'ag', 'ug', 'kg', 'kgaa', 'se', 'gmbh and co kg', 'and co kg', 'co kg', 'and co',
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'plc', 'corp', 'corporation', 'co',
  'srl', 's r l', 'spa', 's p a', 'sa', 's a', 'sas', 's a s', 'sarl', 's a r l', 'sl', 's l', 'ltda',
  'oy', 'oyj', 'ab', 'as', 'a s', 'aps', 'asa',
  'pty', 'pty ltd', 'sp z o o',
];

const TOKENS_LONGEST_FIRST = [...LEGAL_FORM_TOKENS].sort((a, b) => b.length - a.length);

function stripLegalForms(name: string): string {
  let current = name;
  for (let pass = 0; pass < 2; pass += 1) {
    const token = TOKENS_LONGEST_FIRST.find((candidate) => current.endsWith(` ${candidate}`));
    if (!token) break;
    current = current.slice(0, -(token.length + 1)).trimEnd();
  }
  return current;
}

/**
 * A company name reduced to the key two spellings of one employer share: diacritics folded, case and
 * punctuation dropped, `&` read as "and", whitespace collapsed, trailing legal forms removed.
 */
export function normalizeCompanyName(value: string): string {
  const folded = value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return stripLegalForms(folded);
}

/**
 * Domain aliases that would exclude far more than one company, so the validator refuses them.
 *
 * - `ATS_APEX_HOSTS`: an applicant-tracking system's own domain. Refused only as the bare domain: a tenant
 *   subdomain such as `acme.recruitee.com` or `acme.wd3.myworkdayjobs.com` belongs to one company and is fine.
 *   Includes every host `FREEHIRE_ATS_HOSTS` in `global-remote/structured-discovery.ts` lists (pinned by a test),
 *   kept as its own list so this feature does not change what discovery accepts.
 * - `SHARED_TENANT_HOSTS`: ATS hosts where the company sits in the path or query, shared by every tenant
 *   (`jobs.lever.co/acme`). Refused, with any subdomain.
 * - `SHARED_POD_APEXES`: suites whose every subdomain is a shared pod with the company in the query string
 *   (`career5.successfactors.eu/career?company=acme`). Refused, with any subdomain.
 * - `JOB_SITE_HOSTS`: job boards and aggregators. Refused, with any subdomain.
 */
export const ATS_APEX_HOSTS: readonly string[] = [
  'ashbyhq.com', 'bamboohr.com', 'breezy.hr', 'greenhouse.io', 'icims.com', 'jobvite.com', 'lever.co',
  'myworkdayjobs.com', 'oraclecloud.com', 'personio.com', 'personio.de', 'pinpointhq.com', 'recruitee.com',
  'rippling.com', 'smartrecruiters.com', 'successfactors.com', 'successfactors.eu', 'sapsf.com', 'sapsf.eu',
  'teamtailor.com', 'workable.com', 'workday.com', 'join.com', 'homerun.co',
];
export const SHARED_TENANT_HOSTS: readonly string[] = [
  'jobs.lever.co', 'jobs.eu.lever.co', 'boards.greenhouse.io', 'boards.eu.greenhouse.io', 'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io', 'jobs.ashbyhq.com', 'apply.workable.com', 'jobs.workable.com',
  'jobs.smartrecruiters.com', 'careers.smartrecruiters.com', 'ats.rippling.com', 'app.rippling.com',
  'jobs.jobvite.com', 'app.join.com', 'eu.lever.co', 'eu.greenhouse.io', 'myworkdaysite.com',
];
/** Hosts shared only as the bare host: one company sits directly under them (`acme.jobs.personio.de`,
 * `acme.wd3.myworkdayjobs.com`), so a subdomain is fine and only the host itself is refused. */
const SHARED_BARE_HOSTS: readonly string[] = ['jobs.personio.de', 'jobs.personio.com'];
const WORKDAY_POD = /^wd\d+\.myworkdayjobs\.com$/u;
export const SHARED_POD_APEXES: readonly string[] = ['successfactors.com', 'successfactors.eu', 'sapsf.com', 'sapsf.eu', 'oraclecloud.com'];
export const JOB_SITE_HOSTS: readonly string[] = ['linkedin.com', 'indeed.com', 'glassdoor.com', 'wellfound.com', 'welcometothejungle.com'];

/** Second-level labels that, with a two-letter country code, form a public suffix (`co.uk`, `com.au`). */
const PUBLIC_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or', 'gv']);

const isOrUnder = (alias: string, host: string): boolean => alias === host || alias.endsWith(`.${host}`);

/**
 * Why a typed domain alias cannot be stored, or null when it is usable. A path is fine and dropped
 * ("https://acme.com/careers" stores `acme.com`); what matters is whether the host belongs to one company.
 */
export function domainAliasProblem(value: string): 'not_a_domain' | 'shared_host' | 'public_suffix' | null {
  const alias = normalizeDomainAlias(value);
  if (alias === null) return 'not_a_domain';
  if (ATS_APEX_HOSTS.includes(alias) || SHARED_BARE_HOSTS.includes(alias) || WORKDAY_POD.test(alias)) return 'shared_host';
  if ([...SHARED_TENANT_HOSTS, ...SHARED_POD_APEXES, ...JOB_SITE_HOSTS].some((host) => isOrUnder(alias, host))) return 'shared_host';
  const labels = alias.split('.');
  if (labels.length === 2 && PUBLIC_SECOND_LEVEL.has(labels[0]!) && labels[1]!.length === 2) return 'public_suffix';
  return null;
}

/**
 * A domain alias as the person typed it ("https://www.Acme.com/jobs", "acme.com") reduced to a bare
 * lowercase hostname, or null when nothing host-like is left. A bare word with no dot is not a domain.
 */
export function normalizeDomainAlias(value: string): string | null {
  let host = value.trim().toLowerCase();
  if (host === '') return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split(/[/?#]/)[0] ?? '';
  host = host.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  host = host.replace(/^www\./, '');
  // Trailing dots are removed with a loop rather than `/\.+$/`: CodeQL (js/polynomial-redos) flags that
  // pattern as quadratic on input with many dots, and this runs on text the person is still typing.
  let end = host.length;
  while (end > 0 && host[end - 1] === '.') end -= 1;
  host = host.slice(0, end);
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

function hostnameOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

function hostMatchesAlias(host: string, alias: string): boolean {
  return host === alias || host.endsWith(`.${alias}`);
}

/** The slice of a vacancy the matcher reads: its company as the source names it, and any URLs it has. */
export interface ExcludableVacancy {
  company: string;
  /** The listing URL and, when known, the verified apply URL. Nulls and empties are ignored. */
  urls?: ReadonlyArray<string | null | undefined>;
}

export type ExcludedCompanyMatcher = (vacancy: ExcludableVacancy) => ExcludedCompany | null;

/**
 * Compiles the list once so a 20k-row Search index does not re-normalise 50 entries per row. An entry
 * whose name normalises to nothing (punctuation only) can match by domain only, never by name.
 */
export function createExcludedCompanyMatcher(excluded: readonly ExcludedCompany[]): ExcludedCompanyMatcher {
  if (excluded.length === 0) return () => null;
  const byName = new Map<string, ExcludedCompany>();
  const byAlias: Array<{ alias: string; entry: ExcludedCompany }> = [];
  for (const entry of excluded) {
    const name = normalizeCompanyName(entry.name);
    if (name !== '' && !byName.has(name)) byName.set(name, entry);
    for (const domain of entry.domains) {
      const alias = normalizeDomainAlias(domain);
      if (alias) byAlias.push({ alias, entry });
    }
  }
  return (vacancy) => {
    const name = normalizeCompanyName(vacancy.company);
    const named = name === '' ? undefined : byName.get(name);
    if (named) return named;
    if (byAlias.length === 0) return null;
    for (const url of vacancy.urls ?? []) {
      if (!url) continue;
      const host = hostnameOf(url);
      if (!host) continue;
      const hit = byAlias.find(({ alias }) => hostMatchesAlias(host, alias));
      if (hit) return hit.entry;
    }
    return null;
  };
}

/** One-off form of `createExcludedCompanyMatcher` for a single vacancy. */
export function findExcludedCompany(vacancy: ExcludableVacancy, excluded: readonly ExcludedCompany[]): ExcludedCompany | null {
  return createExcludedCompanyMatcher(excluded)(vacancy);
}
