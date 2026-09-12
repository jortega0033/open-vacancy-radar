import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from 'pino';

import type { AtsHttpClient } from '../ats/http.js';
import { loadCandidateProfile, type CandidateProfile } from '../candidate/profile.js';
import { loadAtsRoster } from '../companies/ats-roster-repository.js';
import {
  readWorldwideSponsorLookups,
  writeWorldwideSponsorLookup,
} from '../companies/worldwide-sponsor-lookup-cache.js';
import {
  isWorldwideSponsorMatchEligible,
  resolveWorldwideSponsorKvk,
  sponsorMatchForKvk,
} from '../companies/worldwide-sponsor-match.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { assessWorkEligibility } from '../eligibility/evidence.js';
import { candidateWorkLanguages } from '../eligibility/language.js';
import { normalizeCountry } from '../geo/countries.js';
import { recordAttributedNetworkAttempt } from '../global-remote/discovery-attribution.js';
import { runGlobalRemoteDiscovery } from '../global-remote/discovery.js';
import { evaluateOfficialReview, mandatoryLanguageGate } from '../global-remote/evaluation.js';
import {
  globalRemoteConfigSchema,
  type DiscoveryVacancyAudit,
  type DiscoverySourceAudit,
  type GlobalRemoteConfig,
  type GlobalRemoteDecision,
  type GlobalRemoteReport,
  type OfficialVacancyAudit,
  type ScanProgressCallback,
  type VacancySourceReference,
} from '../global-remote/models.js';
import { runOfficialGlobalRemoteSources } from '../global-remote/official.js';
import { scoreWorldwideVacancy } from '../filtering/index.js';
import { globalRemoteSourceRegistry } from '../global-remote/source-registry.js';
import {
  applyFocusedScanCriteria,
  upstreamCountryFor,
  upstreamEmploymentFor,
  withFocusedScanPlan,
  type FocusedScanCriteria,
} from '../global-remote/focused-scan.js';
import { normalizeSalary, type SalaryFilterCriteria } from '../global-remote/salary.js';
import { resolveApplyUrl, vacancyIdentityFor } from '../vacancies/identity.js';
import {
  runWorkableGlobalDiscovery,
  WORKABLE_GLOBAL_MAX_RESPONSE_BYTES,
  WORKABLE_GLOBAL_TIMEOUT_MS,
} from '../global-remote/workable-global-discovery.js';
import { writeGlobalRemoteReport, type GlobalRemoteReportFiles } from '../global-remote/report.js';
import { createDatabaseBackedHttpClients } from './ats-http-client.js';

const MANUAL_DECISIONS = new Set<GlobalRemoteDecision>([
  'salary_confirmation',
  'location_confirmation',
  'remote_confirmation',
  'company_confirmation',
  'language_confirmation',
  'salary_unknown',
  'changed_since_review',
]);
const EXCLUDED_DECISIONS = new Set<GlobalRemoteDecision>([
  'excluded_location',
  'excluded_language',
  'excluded_not_remote',
  'excluded_not_us_market',
  'excluded_role',
  'inactive',
]);

/**
 * The discovery decisions the post-discovery language gate is allowed to overwrite: rows still in
 * play. A row already excluded for another reason keeps the first reason it was given, so a reader
 * is never told a vacancy was dropped for its language when it was really dropped for its title.
 */
const LANGUAGE_GATE_APPLICABLE_DECISIONS = new Set<DiscoveryVacancyAudit['decision']>([
  'official_review_candidate',
  'salary_unverified',
]);

async function loadGlobalRemoteConfig(projectRoot: string): Promise<GlobalRemoteConfig> {
  const file = path.resolve(projectRoot, 'config', 'global-remote-profile-v1.json');
  const relative = path.relative(projectRoot, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Global remote profile must remain inside the project root');
  }
  return globalRemoteConfigSchema.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

/**
 * Which discovered row's own fields (title, description, location, ...) survive as a merged
 * group's representation, when more than one discovery row shares one canonical identity (issue
 * #278). Lower sorts first. `workable_global` keeps rank 0 for exact backward compatibility with
 * the dedup this replaces (see `uniqueDiscovery`'s own doc comment): its "all customers" feed is
 * Workable's own authoritative export, and every row surviving a scan used to prefer it whenever a
 * URL match was found. The `ats_roster_*` providers rank just behind it for the same reason --
 * `global-remote/ats-roster-discovery.ts` calls this repo's own reviewed ATS parsers directly
 * (`ats/greenhouse.ts` etc.), the same trust level `global-remote/official.ts` already gives a
 * curated source, versus an aggregator's own copy of the same listing. Every other provider ties at
 * the lowest rank and falls back to first-seen order, matching this function's previous behavior.
 */
const IDENTITY_MERGE_PRIORITY: Partial<Record<DiscoveryVacancyAudit['provider'], number>> = {
  workable_global: 0,
  ats_roster_greenhouse: 1,
  ats_roster_lever: 1,
  ats_roster_ashby: 1,
  ats_roster_recruitee: 1,
  ats_roster_personio: 1,
};

function identityMergePriority(provider: DiscoveryVacancyAudit['provider']): number {
  return IDENTITY_MERGE_PRIORITY[provider] ?? 2;
}

/** A row's own source references, falling back to a single self-reference for a row that predates
 * `sources` (issue #278) -- e.g. one read back from a `latest.json` written by an older engine
 * version, or a literal object built by an existing test fixture that never called
 * `discoveryAudit()`. */
function ownSourceReferences(vacancy: DiscoveryVacancyAudit): VacancySourceReference[] {
  return vacancy.sources ?? [{ provider: vacancy.provider, key: vacancy.key, url: vacancy.url }];
}

/**
 * Collapses one identity group (every row `uniqueDiscovery` decided is the same underlying
 * vacancy) into the single row that survives: the highest-priority row's own fields
 * (`identityMergePriority` above), with every group member's source references merged onto it so
 * the result carries every source that found this vacancy, not just the one whose content won --
 * issue #278's "one actionable vacancy carrying both source references" requirement.
 */
function mergeIdentityGroup(
  group: readonly { vacancy: DiscoveryVacancyAudit; index: number }[],
): DiscoveryVacancyAudit {
  const ordered = [...group].sort(
    (left, right) =>
      identityMergePriority(left.vacancy.provider) - identityMergePriority(right.vacancy.provider) ||
      left.index - right.index,
  );
  const primary = ordered[0]!.vacancy;
  const sources: VacancySourceReference[] = [];
  const seen = new Set<string>();
  for (const { vacancy } of ordered) {
    for (const reference of ownSourceReferences(vacancy)) {
      const dedupeKey = `${reference.provider}::${reference.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      sources.push(reference);
    }
  }
  // Recomputed here (never trusted off `primary.identity`/`primary.applyUrl`) for the same reason
  // grouping itself recomputes identity below: a row from an old persisted report, or a hand-built
  // test fixture, may not carry either field yet, and the merged output must always expose both.
  const identity = vacancyIdentityFor(primary);
  const applyUrl = resolveApplyUrl(identity, primary.url);
  const locations = [...new Set(ordered.flatMap(({ vacancy }) => vacancy.locations ?? [vacancy.location]))];
  const searchableText = [...new Set(ordered.flatMap(({ vacancy }) =>
    vacancy.searchableText ?? [`${vacancy.title} ${vacancy.description ?? ''}`.trim()],
  ))];
  const employmentTypes = [...new Set(ordered.flatMap(({ vacancy }) =>
    vacancy.employmentTypes ?? (vacancy.employmentType ? [vacancy.employmentType] : []),
  ))];
  const salaryEvidence =
    ordered.find(({ vacancy }) =>
      vacancy.normalizedAnnualMinimum != null && vacancy.salaryProvenance === 'reviewed_structured',
    )?.vacancy ??
    ordered.find(({ vacancy }) => vacancy.advertisedMinimum != null)?.vacancy;
  return {
    ...primary,
    locations,
    searchableText,
    employmentTypes,
    ...(salaryEvidence && salaryEvidence !== primary
      ? {
          currency: salaryEvidence.currency,
          salaryPeriod: salaryEvidence.salaryPeriod,
          advertisedMinimum: salaryEvidence.advertisedMinimum,
          annualizedMinimumUsd: salaryEvidence.annualizedMinimumUsd,
          normalizedAnnualMinimum: salaryEvidence.normalizedAnnualMinimum,
          normalizedCurrency: salaryEvidence.normalizedCurrency,
          normalizationMethod: salaryEvidence.normalizationMethod,
          assumptionProvenance: salaryEvidence.assumptionProvenance,
          salaryProvenance: salaryEvidence.salaryProvenance,
          salaryProvider: salaryEvidence.salaryProvider,
          salarySourceKey: salaryEvidence.salarySourceKey,
          salarySourceUrl: salaryEvidence.salarySourceUrl,
        }
      : {}),
    sourceUrl: primary.sourceUrl ?? primary.url,
    identity,
    applyUrl,
    sources,
  };
}

/**
 * Merges discovery rows that resolve to the same canonical job identity (issue #278) into one
 * actionable vacancy per identity, replacing the previous Workable-URL-only special case with the
 * general tiered resolver in `vacancies/identity.ts#vacancyIdentityFor`: an employer/ATS-tenant plus
 * requisition ID first, then a normalized canonical URL for a URL that looks like one specific
 * posting, and a company-scoped semantic fingerprint only as a last resort. Identity is always
 * recomputed here from each row's own `url`/`company`/`title`/`location` -- never read off a row's
 * `identity` field -- so a row that predates that field (an old persisted report, or a hand-built
 * test fixture) still groups correctly.
 *
 * This never drops a row for lacking a verified `applyUrl`: an `unresolved` apply-URL row is exactly
 * as eligible to survive (on its own, or as the representative of its group) as a `verified` one --
 * only merging with an identical-identity duplicate removes a row, never an unresolved status by
 * itself. See `resolveApplyUrl`'s own doc comment for why that distinction matters.
 */
export function uniqueDiscovery(vacancies: DiscoveryVacancyAudit[]): DiscoveryVacancyAudit[] {
  const groups = new Map<string, { vacancy: DiscoveryVacancyAudit; index: number }[]>();
  vacancies.forEach((vacancy, index) => {
    const identity = vacancyIdentityFor(vacancy);
    const groupKey = `${identity.kind}::${identity.key}`;
    const existing = groups.get(groupKey);
    if (existing === undefined) groups.set(groupKey, [{ vacancy, index }]);
    else existing.push({ vacancy, index });
  });
  const merged = [...groups.values()].map((group) => mergeIdentityGroup(group));
  return merged.sort(
    (left, right) =>
      left.company.localeCompare(right.company) || left.title.localeCompare(right.title),
  );
}

function candidateProfilePathFor(projectRoot: string): string {
  return path.join(projectRoot, 'config', 'candidate-profile-v1.json');
}

/**
 * Computed once here, after discovery, rather than threaded through each of the ~30
 * `discoveryAudit()` call sites in global-remote/*.ts: unlike `description`/`postedAt`, which are
 * per-source raw metadata, a profile score needs the candidate profile and the pipeline's own
 * salary floor -- neither of which any individual discovery source has, or should have, access to.
 * This mirrors how the Netherlands pipeline only scores after `runVacancyScan` has already produced
 * its vacancy list (see the `deterministic_scoring` stage in `runUnlockedEndToEndScan`, full-scan.ts).
 */
export function applyWorldwideProfileScores(
  vacancies: readonly DiscoveryVacancyAudit[],
  profile: CandidateProfile,
  minimumAnnualBaseUsd: number | null,
): DiscoveryVacancyAudit[] {
  return vacancies.map((vacancy) => ({
    ...vacancy,
    profileScore:
      scoreWorldwideVacancy(vacancy, profile, minimumAnnualBaseUsd)?.deterministicScore ?? null,
  }));
}

/**
 * Attaches the work-eligibility evidence record to every discovered row, and applies the one gate
 * that evidence can produce, after discovery for the same reason `applyWorldwideProfileScores`
 * runs here: the answers need the candidate profile, which no individual discovery source has.
 *
 * Running it once over the merged row list, rather than inside each of the ~30 discovery sources,
 * is also what makes the mandatory-language gate hold for *every* source instead of the handful
 * that might have remembered to pass the profile down (issue #280).
 *
 * Country is read in exactly one direction here: the vacancy's own stated restriction is compared
 * against the country the candidate configured for themselves. Nothing is included, excluded,
 * ranked or ordered by which country a vacancy is in, and an unconfigured profile leaves every
 * answer `unknown` rather than falling back to a default country, language or market.
 */
export function applyWorkEligibilityEvidence(
  vacancies: readonly DiscoveryVacancyAudit[],
  profile: CandidateProfile,
  now: Date = new Date(),
): DiscoveryVacancyAudit[] {
  const candidateLanguages = candidateWorkLanguages(profile);
  const candidateWorkCountry = normalizeCountry(profile.constraints.primaryCountry);
  const relocationWilling = profile.constraints.relocationWilling ?? null;

  return vacancies.map((vacancy) => {
    const eligibility = assessWorkEligibility(
      {
        description: vacancy.description,
        location: vacancy.location,
        candidateWorkCountry,
        candidateLanguages,
        candidateRelocationWilling: relocationWilling,
        employerRegisterMatch:
          vacancy.worldwideSponsorMatch === null
            ? null
            : {
                register: 'IND recognised sponsor register',
                legalName: vacancy.worldwideSponsorMatch.legalName,
                observedAt: null,
              },
        currency: vacancy.currency,
        salaryPeriod: vacancy.salaryPeriod,
        advertisedMinimum: vacancy.advertisedMinimum,
        observedAt: vacancy.postedAt,
      },
      now,
    );
    const gate = LANGUAGE_GATE_APPLICABLE_DECISIONS.has(vacancy.decision)
      ? mandatoryLanguageGate({ description: vacancy.description, candidateLanguages })
      : null;
    return gate === null
      ? { ...vacancy, eligibility }
      : { ...vacancy, eligibility, decision: gate.decision, reasons: gate.reasons };
  });
}

/**
 * Employers looked up at once by `applyWorldwideSponsorMatches`.
 *
 * One, and it used to be four, which was never real: every request this pass makes goes to one
 * hostname (`www.wikidata.org`), and `RequestScheduler` enforces `perDomainConcurrency` -- which
 * defaults to 1 (see config.ts's `PER_DOMAIN_CONCURRENCY`) -- so three of those four workers only
 * ever sat in the scheduler queue. Saying so plainly matters because of what it does to the
 * per-employer timeout below: a queued worker's clock starts while it waits behind the others, so
 * extra workers turn a slow-but-healthy upstream into a false rate-limit signal. Nothing is lost --
 * Wikidata is a public API this feature reuses as a courtesy, and its own etiquette guidance asks
 * anonymous clients to make requests serially anyway.
 */
const WORLDWIDE_SPONSOR_MATCH_CONCURRENCY = 1;

/**
 * What one scan may spend on employers it has not resolved before. All three exist for the same
 * reason every discovery source in global-remote/*.ts bounds its own request budget, except that
 * here the upstream is far stricter than any of them: Wikidata's action API rate-limits an
 * anonymous client to roughly ten requests a minute and then answers `429 Retry-After: 58`.
 * Measured against a real worldwide scan, that is what turned this pass from an enrichment step
 * into a scan that never visibly finished -- 226 Netherlands-located rows, resolved one row at a
 * time, is upwards of 20 minutes of mostly waiting, with nothing persisted until it ended.
 *
 * `PER_COMPANY_TIMEOUT_MS` is the one that does the real work: a healthy lookup takes 150-600ms,
 * so an employer still unresolved after eight seconds means the rate limit has been reached, and
 * the honest move then is to stop and leave the rest for the next scan -- not to spend a minute of
 * the user's scan asleep waiting out a `Retry-After`. `BUDGET_MS` is the backstop for anything
 * that degrades some other way, and `MAX_COMPANIES` bounds how many employers a single scan may
 * fetch at all -- employers an earlier scan already resolved are free and never counted against it.
 *
 * Coverage is not lost by stopping early, only deferred: every resolved employer is persisted (see
 * `worldwide-sponsor-lookup-cache.ts`), so each scan starts where the last one left off and the
 * set converges -- including on its own, through the four-hourly background scan. Until then, an
 * unresolved employer's rows keep `worldwideSponsorMatch: null`, which the desktop UI already
 * renders as the honest "no sponsor register match was found (or attempted)" absent-check state,
 * never as a negative result (see `WORLDWIDE_VERIFICATION` in the desktop app's results.ts).
 */
export const WORLDWIDE_SPONSOR_MATCH_MAX_COMPANIES = 200;
export const WORLDWIDE_SPONSOR_MATCH_BUDGET_MS = 30_000;
export const WORLDWIDE_SPONSOR_MATCH_PER_COMPANY_TIMEOUT_MS = 8_000;

/** One employer to look up, plus every row of this scan that the answer applies to. */
export type WorldwideSponsorMatchTarget = {
  /** Normalized name, and the persisted lookup cache's key. */
  companyKey: string;
  /** The spelling actually sent to Wikidata: the first one this scan's row order produced. */
  companyName: string;
  /** A representative eligible location, so the resolver's own location gate still governs. */
  location: string;
  /** Indexes into the vacancy list the plan was built from. */
  rowIndexes: number[];
};

export type WorldwideSponsorMatchPlan = {
  targets: WorldwideSponsorMatchTarget[];
  eligibleRows: number;
  eligibleCompanies: number;
};

export type WorldwideSponsorMatchStatistics = {
  /** Netherlands-located rows -- the only ones a lookup can ever say anything about. */
  eligibleRows: number;
  /** Distinct employers across those rows. */
  eligibleCompanies: number;
  /** Employers answered from an earlier scan's persisted lookup, at no Wikidata cost. */
  cachedCompanies: number;
  /**
   * Employers this scan attempted over the network. Mostly newly resolved and persisted; a lookup
   * that errored also counts here (it was attempted, not skipped) and is retried by a later scan,
   * since a failed request is never cached.
   */
  lookedUpCompanies: number;
  /** Employers that resolved to an active IND-recognised sponsor. */
  matchedCompanies: number;
  /** Employers left unchecked by the per-scan cap or time budget. Reported, never hidden. */
  unverifiedCompanies: number;
  /** True when a time bound, rather than the cap, ended the pass early. */
  budgetExhausted: boolean;
};

export type WorldwideSponsorMatchResult = {
  vacancies: DiscoveryVacancyAudit[];
  statistics: WorldwideSponsorMatchStatistics;
};

export type WorldwideSponsorMatchOptions = {
  maxCompanies?: number;
  budgetMs?: number;
  perCompanyTimeoutMs?: number;
};

export function sponsorMatchCompanyKey(company: string): string {
  return company.trim().toLowerCase().replace(/\s+/gu, ' ');
}

/**
 * Collapses a scan's rows into the distinct employers worth asking Wikidata about, in the order
 * this scan should spend its bounded budget on them.
 *
 * Two employers whose names differ only in case or whitespace are one target, not two: the
 * resolver only ever accepts a Wikidata result whose matched label normalizes -- under the same
 * rule as `sponsorMatchCompanyKey` -- to exactly the queried name (see `selectWikidataNameMatch`),
 * so two spellings that normalize identically cannot resolve to different employers. The one thing
 * that could in principle differ is where Wikidata's own relevance ranking places the exact match
 * within the capped result page, which is not a distinction this best-effort check has ever
 * claimed to be sensitive to.
 *
 * Ordered by how many rows each employer covers (ties broken by name, so a given scan always
 * produces the same plan): when the per-scan lookup cap bites, the budget goes to the employers
 * that explain the most of what the user is actually looking at. Deliberately not ordered by
 * profile score, salary, or role -- this app ships no such default bias.
 *
 * Uncapped on purpose. The cap belongs to the *network* pass in `applyWorldwideSponsorMatches`,
 * not here: an employer an earlier scan already resolved costs nothing to answer, and capping the
 * plan would have thrown away free answers to stay under a budget those answers never touch.
 *
 * Pure and network-free, so the dedup and ordering rules are unit-testable on their own.
 */
export function planWorldwideSponsorMatches(
  vacancies: readonly DiscoveryVacancyAudit[],
): WorldwideSponsorMatchPlan {
  const byCompany = new Map<string, WorldwideSponsorMatchTarget>();
  let eligibleRows = 0;
  for (const [index, vacancy] of vacancies.entries()) {
    if (!isWorldwideSponsorMatchEligible(vacancy.location)) continue;
    eligibleRows += 1;
    const key = sponsorMatchCompanyKey(vacancy.company);
    const existing = byCompany.get(key);
    if (existing === undefined) {
      byCompany.set(key, {
        companyKey: key,
        companyName: vacancy.company,
        location: vacancy.location,
        rowIndexes: [index],
      });
    } else {
      existing.rowIndexes.push(index);
    }
  }
  const targets = [...byCompany.values()].sort(
    (left, right) =>
      right.rowIndexes.length - left.rowIndexes.length ||
      left.companyName.localeCompare(right.companyName),
  );
  return { targets, eligibleRows, eligibleCompanies: targets.length };
}

/** Distinguishes "this pass is out of time" from a genuine lookup failure, which is logged. */
class SponsorMatchBudgetExhausted extends Error {
  public constructor() {
    super('worldwide sponsor match budget exhausted');
    this.name = 'SponsorMatchBudgetExhausted';
  }
}

/**
 * Caps one employer's lookup at the shorter of the per-employer timeout and whatever is left of
 * the whole pass's budget. `SafeHttpClient` already bounds each individual request, but a single
 * employer costs up to two chained requests plus `Retry-After`-honouring retries -- which against a
 * rate-limiting upstream is a minute of sleeping per employer -- so the bound that matters is this
 * one, not the per-request one. The losing promise is left to settle on its own: `Promise.race` has
 * already attached handlers to it, so it cannot surface as an unhandled rejection, and the request
 * underneath it stays bounded by the HTTP client regardless.
 */
async function withinRemainingBudget<T>(operation: Promise<T>, remainingMs: number): Promise<T> {
  if (remainingMs <= 0) throw new SponsorMatchBudgetExhausted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SponsorMatchBudgetExhausted()), remainingMs);
  });
  try {
    return await Promise.race([operation, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Computed once here, after discovery, mirroring `applyWorldwideProfileScores` immediately above --
 * but async and network/database-backed, since resolving a match needs a Wikidata name search and
 * an `indSponsors` read (see `worldwide-sponsor-match.ts`), neither of which belongs inside any
 * individual `discoveryAudit()` call site in global-remote/*.ts.
 *
 * Three things keep this bounded, in the order they bite: employers already resolved by an earlier
 * scan are answered from the persisted lookup cache for free, what remains is resolved per distinct
 * *employer* rather than per row, and that network pass stops at the first sign of the upstream
 * rate limit. Everything it did not reach keeps the same `null` an ineligible or unmatched row
 * keeps, and the returned `statistics` say exactly how much of the scan that was -- see the
 * constants above for the full reasoning.
 */
export async function applyWorldwideSponsorMatches(
  vacancies: readonly DiscoveryVacancyAudit[],
  http: AtsHttpClient,
  database: Database,
  logger?: Pick<Logger, 'debug'>,
  options: WorldwideSponsorMatchOptions = {},
): Promise<WorldwideSponsorMatchResult> {
  const plan = planWorldwideSponsorMatches(vacancies);
  const results = [...vacancies];
  const maxCompanies = options.maxCompanies ?? WORLDWIDE_SPONSOR_MATCH_MAX_COMPANIES;
  const budgetMs = options.budgetMs ?? WORLDWIDE_SPONSOR_MATCH_BUDGET_MS;
  const perCompanyTimeoutMs =
    options.perCompanyTimeoutMs ?? WORLDWIDE_SPONSOR_MATCH_PER_COMPANY_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;

  let cachedCompanies = 0;
  let lookedUpCompanies = 0;
  let matchedCompanies = 0;
  let budgetExhausted = false;

  /**
   * The one place a resolved KVK (cached or fresh) turns into a decision about this scan's rows.
   * A failing `indSponsors` read is treated exactly like a failing Wikidata call -- logged, and
   * left as "nothing to show" -- rather than being allowed to fail a whole worldwide scan over a
   * best-effort enrichment.
   */
  async function applyKvk(
    target: WorldwideSponsorMatchTarget,
    kvkNumber: string | null,
  ): Promise<void> {
    let match: Awaited<ReturnType<typeof sponsorMatchForKvk>> = null;
    try {
      match = await sponsorMatchForKvk(database, kvkNumber);
    } catch (error) {
      logger?.debug({ error, company: target.companyName }, 'IND sponsor register read failed');
    }
    if (match === null) return;
    matchedCompanies += 1;
    for (const rowIndex of target.rowIndexes) {
      results[rowIndex] = { ...results[rowIndex]!, worldwideSponsorMatch: match };
    }
  }

  // A cache read that fails must not fail the scan, for the same reason a lookup failure does not:
  // it degrades this pass to "resolve from scratch, budget permitting", which is exactly the
  // first-run behaviour and already fully supported below.
  let cached = new Map<string, { kvkNumber: string | null }>();
  try {
    cached = await readWorldwideSponsorLookups(
      database,
      plan.targets.map((target) => target.companyKey),
    );
  } catch (error) {
    logger?.debug({ error }, 'worldwide sponsor lookup cache read failed');
  }

  const unresolved: WorldwideSponsorMatchTarget[] = [];
  for (const target of plan.targets) {
    const record = cached.get(target.companyKey);
    if (record === undefined) {
      unresolved.push(target);
      continue;
    }
    cachedCompanies += 1;
    // Sequential on purpose: this is a local SQLite read per employer, and the scan already holds
    // the single writer connection -- there is nothing to overlap with.
    await applyKvk(target, record.kvkNumber);
  }
  // The cap applies only to what this scan would have to fetch. `plan.targets` is already ordered
  // by row coverage, so the employers that explain the most listings are the ones it spends on.
  const pending = unresolved.slice(0, Math.max(0, maxCompanies));

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;
      if (budgetExhausted) return;
      const target = pending[index]!;
      // A failed or malformed Wikidata call for one company must never fail the whole worldwide
      // scan over a best-effort enrichment -- every other discovery source in this package already
      // catches its own network/parse errors (see `sourceFailure` throughout global-remote/*.ts)
      // rather than letting them propagate. A lookup failure is indistinguishable here from "found
      // nothing" for the same reason `resolveWorldwideSponsorMatch`'s own doc comment gives: neither
      // has a meaningful claim beyond "nothing to show". Logged, not silently discarded, though --
      // a genuine coding bug must not become permanently indistinguishable from a network hiccup.
      //
      // A *failure* is deliberately not cached, unlike a resolved `null`: "Wikidata answered, and
      // had nothing unambiguous" is a durable fact, while "the request errored" is not, and
      // persisting the latter would turn one bad minute into thirty stale days.
      let kvkNumber: string | null;
      try {
        kvkNumber = await withinRemainingBudget(
          resolveWorldwideSponsorKvk(http, target.companyName),
          Math.min(perCompanyTimeoutMs, deadline - Date.now()),
        );
      } catch (error) {
        if (error instanceof SponsorMatchBudgetExhausted) {
          // Not "skip this one and carry on": an employer that has not answered in seconds means
          // the upstream rate limit has been reached, and every further request this scan makes
          // would wait out the same `Retry-After`. Stopping leaves the rest for the next scan,
          // which the persisted cache makes a real continuation rather than a fresh start.
          budgetExhausted = true;
          return;
        }
        logger?.debug(
          { error, company: target.companyName },
          'worldwide sponsor match lookup failed',
        );
        lookedUpCompanies += 1;
        continue;
      }
      lookedUpCompanies += 1;
      try {
        await writeWorldwideSponsorLookup(database, {
          companyKey: target.companyKey,
          companyName: target.companyName,
          kvkNumber,
        });
      } catch (error) {
        logger?.debug(
          { error, company: target.companyName },
          'worldwide sponsor lookup cache write failed',
        );
      }
      await applyKvk(target, kvkNumber);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(WORLDWIDE_SPONSOR_MATCH_CONCURRENCY, pending.length) }, worker),
  );
  return {
    vacancies: results,
    statistics: {
      eligibleRows: plan.eligibleRows,
      eligibleCompanies: plan.eligibleCompanies,
      cachedCompanies,
      lookedUpCompanies,
      matchedCompanies,
      unverifiedCompanies: plan.eligibleCompanies - cachedCompanies - lookedUpCompanies,
      budgetExhausted,
    },
  };
}

function groupOfficial(
  audits: OfficialVacancyAudit[],
): Pick<
  GlobalRemoteReport,
  'strictMatches' | 'manualReview' | 'nearMisses' | 'excludedOrInactive' | 'blockedOrErrored'
> {
  return {
    strictMatches: audits.filter((item) => item.decision === 'strict_match'),
    manualReview: audits.filter((item) => MANUAL_DECISIONS.has(item.decision)),
    nearMisses: audits.filter((item) => item.decision === 'salary_below_threshold'),
    excludedOrInactive: audits.filter((item) => EXCLUDED_DECISIONS.has(item.decision)),
    blockedOrErrored: audits.filter((item) => ['blocked', 'error'].includes(item.decision)),
  };
}

/**
 * Wraps a caller's `onProgress`, if any, purely to tally how many vacancy rows a run showed
 * provisionally via `ScanProgressEvent` (issue #252) before final confirmation -- issue #279's
 * "distinguish fetched/confirmed coverage from provisional progressive rows" acceptance check.
 * Extracted from `runGlobalRemoteScan` so the counting behaviour is unit-testable on its own,
 * without standing up a full scan (database, HTTP client, config files, ...).
 *
 * Never changes which events fire, what they carry, or in what order -- every existing progress
 * consumer sees exactly what it always did; `count()` is purely additive bookkeeping alongside it.
 * This count is never subtracted from, deduplicated against, or fed into
 * `GlobalRemoteReport.statistics.discoveryUniqueListings`: that count is computed independently by
 * `uniqueDiscovery()` over the final merged result, once, after every source has finished, so the
 * same row appearing in both a progress event and the final result is counted by each place at
 * most once for what that place measures -- never doubled.
 */
export function trackProgressiveRows(onProgress: ScanProgressCallback | undefined): {
  onProgress: ScanProgressCallback | undefined;
  count: () => number;
} {
  if (!onProgress) return { onProgress: undefined, count: () => 0 };
  let total = 0;
  return {
    onProgress: (event) => {
      total += event.vacancies.length;
      onProgress(event);
    },
    count: () => total,
  };
}

export type GlobalRemoteScanResult = {
  report: GlobalRemoteReport;
  files: GlobalRemoteReportFiles;
};

export type GlobalRemoteScanOptions = {
  officialOnly?: boolean;
  offlineReclassify?: boolean;
  browseAll?: boolean;
  browseAllResultCap?: number;
  /**
   * Overrides the checked-in profile's static `discovery.roleQuery` for this run only, so the
   * role/keyword a caller actually searched for scopes each source's own server-side search
   * parameter (see the `config.discovery.roleQuery` reads across global-remote/*.ts) instead of
   * always fetching the same static default and filtering everything client-side afterward.
   * Ignored when empty/whitespace-only, which keeps the static default.
   */
  query?: string;
  country?: string;
  employment?: string;
  /** Optional salary floor. It is compared locally after all source rows are merged. */
  salary?: SalaryFilterCriteria;
  /**
   * Fired once per discovery sub-source (and the Workable global source) as it resolves, well
   * before the whole scan's own promise settles -- see `ScanProgressEvent`'s doc comment for the
   * exact contract. Purely an observability hook layered on top of the existing parallel `await`s
   * below: omitting it changes nothing about what a scan does or what its final `GlobalRemoteReport`
   * contains, so every existing non-streaming caller (the CLI, `officialOnly`/`offlineReclassify`
   * reclassification runs, tests) is unaffected. Never fires for `official`, since an official-source
   * audit row never becomes its own row in the desktop UI's results list (it is only ever attached,
   * by URL, to a discovery row that already exists) and never fires at all when `reuseDiscovery`
   * applies, since no new discovery ran to report progress on.
   */
  onProgress?: ScanProgressCallback;
};

export function applyBrowseAllResultCap(report: GlobalRemoteReport, resultCap: number): GlobalRemoteReport {
  const safeCap = Math.max(0, Math.floor(resultCap));
  const resultCountBeforeCap = report.discoveryAudit.length;
  const complete = resultCountBeforeCap <= safeCap;
  if (complete) {
    return {
      ...report,
      scanBounds: {
        mode: 'browse_all',
        resultCap: safeCap,
        resultCountBeforeCap,
        complete: true,
        completenessReason: null,
      },
    };
  }

  const discoveryAudit = report.discoveryAudit.slice(0, safeCap);
  const keptUrls = new Set(discoveryAudit.map((vacancy) => vacancy.url));
  const officialAudit = report.officialAudit.filter((audit) => keptUrls.has(audit.url));
  const groups = groupOfficial(officialAudit);
  return {
    ...report,
    ...groups,
    officialAudit,
    discoveryAudit,
    scanBounds: {
      mode: 'browse_all',
      resultCap: safeCap,
      resultCountBeforeCap,
      complete: false,
      completenessReason: `Browse-all result cap kept ${safeCap.toLocaleString('en-US')} of ${resultCountBeforeCap.toLocaleString('en-US')} discovered vacancies.`,
    },
    methodology: [
      ...report.methodology,
      `Browse all was explicitly confirmed. The saved report is capped at ${safeCap.toLocaleString('en-US')} result rows and is marked incomplete when discovery finds more.`,
    ],
  };
}

async function loadPreviousDiscovery(projectRoot: string): Promise<{
  sources: DiscoverySourceAudit[];
  vacancies: DiscoveryVacancyAudit[];
}> {
  const file = path.resolve(projectRoot, 'reports', 'global-remote', 'latest.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<GlobalRemoteReport>;
  if (!Array.isArray(parsed.discoverySources) || !Array.isArray(parsed.discoveryAudit)) {
    throw new Error('Previous global remote report does not contain reusable discovery audit data');
  }
  return {
    // No new request was made for a reused source, so its whole attempt/completeness picture is
    // reset to "nothing happened this run" rather than replayed from the prior report -- the same
    // reason `requests: 0` was already forced here before issue #279. A prior report written before
    // these fields existed would otherwise carry `undefined` for all of them; this override also
    // covers that case for free.
    sources: parsed.discoverySources.map((source) => ({
      ...source,
      requests: 0,
      networkAttempts: 0,
      retries: 0,
      complete: false,
      completenessReason: 'Discovery API data was reused from the prior report; no new request was made.',
      continuationCursor: null,
    })),
    vacancies: parsed.discoveryAudit,
  };
}

async function loadPreviousOfficial(
  projectRoot: string,
  profile: GlobalRemoteConfig,
  candidateLanguages: readonly string[],
): Promise<{ audits: OfficialVacancyAudit[]; requestCount: number }> {
  const file = path.resolve(projectRoot, 'reports', 'global-remote', 'latest.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<GlobalRemoteReport>;
  if (!Array.isArray(parsed.officialAudit)) {
    throw new Error('Previous global remote report does not contain reusable official audit data');
  }
  const previous = new Map(parsed.officialAudit.map((audit) => [audit.id, audit]));
  const audits = profile.officialSources.map((source): OfficialVacancyAudit => {
    const prior = previous.get(source.id);
    if (prior === undefined) {
      return {
        id: source.id,
        company: source.company,
        title: source.expectedTitle,
        url: source.url,
        provider: source.provider,
        state: 'error',
        decision: 'error',
        reasons: ['Source has no prior official audit and requires a network verification run.'],
        evidence: source.review.notes,
        minimumAnnualBaseUsd: source.review.minimumAnnualBaseUsd,
        contentHash: null,
        reviewedContentHash: source.reviewedContentHash,
        reviewedAt: source.reviewedAt,
        requestCount: 0,
        httpStatus: null,
      };
    }
    const evaluation = evaluateOfficialReview({
      source,
      state: prior.state,
      currentTitle: prior.title,
      contentHash: prior.contentHash,
      minimumAnnualBaseUsd: profile.minimumAnnualBaseUsd,
      candidateLanguages,
    });
    return {
      ...prior,
      company: source.company,
      provider: source.provider,
      decision: evaluation.decision,
      reasons: evaluation.reasons,
      minimumAnnualBaseUsd: source.review.minimumAnnualBaseUsd,
      reviewedContentHash: source.reviewedContentHash,
      reviewedAt: source.reviewedAt,
      requestCount: 0,
    };
  });
  return { audits, requestCount: 0 };
}

/**
 * A blank/whitespace-only override keeps the checked-in profile's static default rather than
 * clearing it, and `globalRemoteConfigSchema.discovery.roleQuery` caps at 200 characters, so an
 * override longer than that would otherwise pass validation on load but violate it on this path.
 */
export function resolveRoleQuery(staticRoleQuery: string, queryOverride: string | undefined): string {
  const trimmed = queryOverride?.trim();
  return trimmed ? trimmed.slice(0, 200) : staticRoleQuery;
}

export async function runGlobalRemoteScan(
  database: Database,
  appConfig: AppConfig,
  logger: Logger,
  projectRoot = process.cwd(),
  options: GlobalRemoteScanOptions = {},
): Promise<GlobalRemoteScanResult> {
  const loadedProfile = await loadGlobalRemoteConfig(projectRoot);
  // Keyed-discovery credentials always come from process env, never the checked-in profile
  // JSON, so a secret can never land in git even if someone sets these fields in the file.
  const profile: GlobalRemoteConfig = {
    ...loadedProfile,
    discovery: {
      ...loadedProfile.discovery,
      roleQuery: resolveRoleQuery(loadedProfile.discovery.roleQuery, options.query),
      himalayasQueries: options.query?.trim() ? [resolveRoleQuery(loadedProfile.discovery.roleQuery, options.query)] : loadedProfile.discovery.himalayasQueries,
      himalayasCountry: options.country === undefined
        ? loadedProfile.discovery.himalayasCountry
        : upstreamCountryFor('himalayas', options.country) ?? '',
      himalayasEmploymentType: options.employment === undefined
        ? loadedProfile.discovery.himalayasEmploymentType
        : upstreamEmploymentFor('himalayas', options.employment) ?? undefined,
      remooteCountry: options.country === undefined
        ? loadedProfile.discovery.remooteCountry
        : upstreamCountryFor('remoote', options.country) ?? '',
      adzunaAppId: appConfig.keyedDiscovery.adzunaAppId,
      adzunaAppKey: appConfig.keyedDiscovery.adzunaAppKey,
      joobleApiKey: appConfig.keyedDiscovery.joobleApiKey,
      reedApiKey: appConfig.keyedDiscovery.reedApiKey,
      jobspipeApiKey: appConfig.keyedDiscovery.jobspipeApiKey,
      navArbeidsplassenApiKey: appConfig.keyedDiscovery.navArbeidsplassenApiKey,
    },
  };
  const { safeClient, atsClient: http } = createDatabaseBackedHttpClients(appConfig, database, {
    maxStreamTimeoutMs: WORKABLE_GLOBAL_TIMEOUT_MS,
    maxStreamResponseBytes: WORKABLE_GLOBAL_MAX_RESPONSE_BYTES,
    onNetworkRequest(url, meta) {
      logger.debug({ url, retryIndex: meta.retryIndex }, 'Global remote scan HTTP request');
      // Attributes this attempt to whichever source's wrapped client (`discovery-attribution.ts`)
      // made the call, if any -- a no-op for callers that made this request outside such a wrapper
      // (the worldwide sponsor-match enrichment below, which has no `DiscoverySourceAudit` row).
      recordAttributedNetworkAttempt(meta.retryIndex);
    },
    onCacheError(error, operation, url) {
      logger.warn({ error, operation, url }, 'Global remote scan cache operation failed');
    },
  });
  const reuseDiscovery = options.officialOnly === true || options.offlineReclassify === true;
  // All three run independently -- workableGlobal consumes neither baseDiscovery's nor official's
  // output (it is only merged into the result afterward, below) -- so they run in parallel rather
  // than one after another. Workable's global "all customers" listing is comfortably the slowest
  // of the three; running it after the other two used to add its own full duration on top of
  // theirs instead of overlapping with it, which is most of the difference between a scan taking
  // a couple of minutes and one taking upwards of ten.
  // Loaded here, not inside `runGlobalRemoteDiscovery`, so the roster scan's own signature stays
  // `(http, config, roster)` like every other discovery function's `(http, config)` -- no discovery
  // function reads the filesystem directly. Skipped entirely when reusing a prior run's discovery
  // output, matching `reuseDiscovery`'s existing "no new discovery-feed requests" contract; an empty
  // roster in that branch is fine because `atsRoster` is never read again when discovery is reused.
  const atsRoster = reuseDiscovery ? [] : await loadAtsRoster(projectRoot);
  // Loaded before the scan rather than after it: the official-source pipeline enforces the same
  // mandatory-language gate the discovery pipeline does, so it needs the candidate's configured
  // languages while it is running, not once every row already has a decision (issue #280).
  const candidateProfile = await loadCandidateProfile(candidateProfilePathFor(projectRoot));
  const candidateLanguages = candidateWorkLanguages(candidateProfile);
  const progressiveRowTracker = trackProgressiveRows(options.onProgress);
  const trackedOnProgress = progressiveRowTracker.onProgress;
  const [baseDiscovery, official, workableGlobal] = await Promise.all([
    reuseDiscovery
      ? loadPreviousDiscovery(projectRoot)
      : runGlobalRemoteDiscovery(http, profile, atsRoster, projectRoot, trackedOnProgress),
    options.offlineReclassify
      ? loadPreviousOfficial(projectRoot, profile, candidateLanguages)
      : runOfficialGlobalRemoteSources(http, profile, candidateLanguages),
    reuseDiscovery
      ? Promise.resolve(null)
      : runWorkableGlobalDiscovery(safeClient, profile, projectRoot).then((result) => {
          trackedOnProgress?.({ sourceId: 'workable_global', vacancies: result.vacancies });
          return result;
        }),
  ]);
  const discovery =
    workableGlobal === null
      ? baseDiscovery
      : {
          sources: [...baseDiscovery.sources, ...workableGlobal.sources],
          vacancies: [...baseDiscovery.vacancies, ...workableGlobal.vacancies],
        };
  const auditedDiscovery = {
    ...discovery,
    vacancies: discovery.vacancies.map((vacancy) => ({
      ...vacancy,
      ...normalizeSalary(
        vacancy.advertisedMinimum,
        vacancy.currency,
        vacancy.salaryPeriod,
        vacancy.salaryProvenance,
      ),
    })),
  };
  const focusedCriteria: FocusedScanCriteria = {
    role: options.browseAll ? '' : profile.discovery.roleQuery,
    country: options.country?.trim() || null,
    employment: options.employment?.trim() || null,
    salary: options.browseAll ? null : options.salary ?? null,
  };
  const discoverySources = discovery.sources.map((source) => withFocusedScanPlan(source, focusedCriteria));
  const discoveryAudit = uniqueDiscovery(auditedDiscovery.vacancies);
  const focused = applyFocusedScanCriteria(discoveryAudit, focusedCriteria);
  const scoredDiscoveryAudit = applyWorldwideProfileScores(
    focused.vacancies,
    candidateProfile,
    profile.minimumAnnualBaseUsd,
  );
  const sponsorMatchStarted = Date.now();
  const sponsorMatched = await applyWorldwideSponsorMatches(
    scoredDiscoveryAudit,
    http,
    database,
    logger,
  );
  // After the sponsor match, never before it: the evidence record has to be able to report an
  // employer register hit as employer-scope evidence, and it can only do that once the match is
  // actually on the row.
  const assessedDiscoveryAudit = applyWorkEligibilityEvidence(
    sponsorMatched.vacancies,
    candidateProfile,
  );
  // The one enrichment step whose cost is not visible from the discovery source audit, and the one
  // that used to make a finished scan look like a hung one -- so its own budget outcome is logged
  // the way every source's request count already is, not left to be inferred from a stopwatch.
  logger.info(
    { ...sponsorMatched.statistics, durationMs: Date.now() - sponsorMatchStarted },
    'Worldwide sponsor match enrichment completed',
  );
  const officialAudit = [...official.audits].sort(
    (left, right) =>
      left.company.localeCompare(right.company) || left.title.localeCompare(right.title),
  );
  const groups = groupOfficial(officialAudit);
  const sourceRegistry = globalRemoteSourceRegistry(profile);
  const activeRegistrySources = sourceRegistry.filter((source) => source.state === 'active').length;
  const gatedRegistrySources = sourceRegistry.filter((source) =>
    ['configuration_required', 'partner_required', 'blocked'].includes(source.state),
  ).length;
  const manualOrProhibitedRegistrySources =
    sourceRegistry.length - activeRegistrySources - gatedRegistrySources;
  let report: GlobalRemoteReport = {
    runId: randomUUID(),
    generatedAt: new Date().toISOString(),
    profileVersion: profile.version,
    scanBounds: {
      mode: options.browseAll ? 'browse_all' : 'focused',
      resultCap: null,
      resultCountBeforeCap: assessedDiscoveryAudit.length,
      complete: true,
      completenessReason: null,
    },
    criteria: {
      role: 'Explicit frontend engineer/developer/architect; no full-stack, backend, or people-manager titles',
      fullyRemote: true,
      applicantLocation: 'Netherlands or an explicitly worldwide/Europe-compatible location',
      usCitizenshipRequired: false,
      minimumAnnualBaseUsd: profile.minimumAnnualBaseUsd,
      currency: 'USD',
      salary: {
        minimumAnnual: options.browseAll ? null : options.salary?.minimumAnnual ?? null,
        currency: options.browseAll ? 'EUR' : options.salary?.currency ?? 'EUR',
        includeUnknown: options.browseAll ? true : options.salary?.includeUnknown ?? true,
      },
    },
    statistics: {
      discoveryRequests: discoverySources.reduce((sum, source) => sum + source.requests, 0),
      discoveryListings: discoverySources.reduce((sum, source) => sum + source.listings, 0),
      discoveryUniqueListings: discoveryAudit.length,
      rawRowsFetched: discovery.vacancies.length,
      ...(options.browseAll ? {} : { focusedMatches: focused.vacancies.length }),
      focusedUnknownEmployment: focused.unknownEmployment,
      focusedEmploymentMismatches: focused.explicitEmploymentMismatch,
      focusedSalaryComparable: focused.salaryComparable,
      focusedSalaryUnknown: focused.salaryUnknown,
      focusedSalaryBelowMinimum: focused.salaryBelowMinimum,
      discoveryOfficialReviewCandidates: discoveryAudit.filter(
        (item) => item.decision === 'official_review_candidate',
      ).length,
      officialBoardsOrPagesAttempted: profile.officialSources.length,
      officialRequests: official.requestCount,
      strictMatches: groups.strictMatches.length,
      manualReview: groups.manualReview.length,
      nearMisses: groups.nearMisses.length,
      excludedOrInactive: groups.excludedOrInactive.length,
      blockedOrErrored: groups.blockedOrErrored.length,
      registrySources: sourceRegistry.length,
      activeRegistrySources,
      gatedRegistrySources,
      manualOrProhibitedRegistrySources,
      sponsorMatchEligibleRows: sponsorMatched.statistics.eligibleRows,
      sponsorMatchEligibleCompanies: sponsorMatched.statistics.eligibleCompanies,
      sponsorMatchResolvedCompanies:
        sponsorMatched.statistics.cachedCompanies + sponsorMatched.statistics.lookedUpCompanies,
      sponsorMatchLookedUpCompanies: sponsorMatched.statistics.lookedUpCompanies,
      sponsorMatchUnverifiedCompanies: sponsorMatched.statistics.unverifiedCompanies,
      discoveryNetworkAttempts: discoverySources.reduce((sum, source) => sum + source.networkAttempts, 0),
      discoveryRetries: discoverySources.reduce((sum, source) => sum + source.retries, 0),
      discoveryProgressiveRowsEmitted: progressiveRowTracker.count(),
    },
    sourceRegistry,
    discoverySources,
    ...groups,
    officialAudit,
    discoveryAudit: assessedDiscoveryAudit,
    methodology: [
      'Free remote-job APIs are discovery inputs only; their geography and salary labels never create a strict match.',
      'Current official ATS APIs or normal employer HTML are fetched with bounded concurrency, timeouts, retries, conditional caching, and a descriptive User-Agent.',
      'Exact official vacancy content is hashed. A changed or unbaselined posting is routed to manual review instead of silently trusting old facts.',
      'No LinkedIn scraping, browser-agent production crawl, CAPTCHA bypass, proxy rotation, or paid AI service is used.',
      'One blocked or malformed source is logged and does not fail the other sources.',
      'The official Workable all-customer XML is streamed only after normal source scans, parsed incrementally, and cached as a compact hourly snapshot; raw XML is never buffered or persisted.',
      'Dice results are retrieved through Dice’s AI-powered MCP search and are clearly treated as discovery leads requiring official employer verification.',
      'Remoote results come from one capped anonymous REST search, retain only canonical Remoote links, use a five-minute bounded in-memory cache after sanitization, and are never expanded into a bulk export.',
      'Work-country, mandatory-language, visa-sponsorship and Employer of Record eligibility are recorded per vacancy as yes/no/unknown with the source, scope and freshness of the evidence behind each answer. An absent statement stays unknown and reviewable; it is never read as a yes or a no.',
      'A remote label is never read as global eligibility. Only an explicit accepted-location statement in the vacancy can answer the work-country question, and an explicit restriction in the same posting always outranks a worldwide banner elsewhere in it.',
      'Sponsor-register recognition is employer-scope evidence and is never reported as a commitment to sponsor a specific vacancy.',
      'Candidate-confirmed relocation willingness and employer-funded relocation or visa support are recorded as two separate facts and are never merged.',
      'Advertised salaries keep the currency, period and base-versus-total basis their source stated. Where a figure is read for a country other than the one it is benchmarked to, that assumption is labelled on the row rather than folded into the number.',
      `The best-effort IND sponsor cross-check resolves distinct Netherlands-located employers, not individual listings, against Wikidata, which rate-limits anonymous clients. Each scan spends a bounded budget on employers it has not resolved before, persists what it resolves, and stops as soon as the upstream rate limit is reached, so coverage accumulates across scans instead of one scan stalling on all of it.`,
      ...(sponsorMatched.statistics.unverifiedCompanies > 0
        ? [
            `${sponsorMatched.statistics.unverifiedCompanies} of ${sponsorMatched.statistics.eligibleCompanies} Netherlands-located employers are not yet sponsor-checked${sponsorMatched.statistics.budgetExhausted ? ' (this run reached the Wikidata rate limit)' : ` (this run reached the per-scan cap of ${WORLDWIDE_SPONSOR_MATCH_MAX_COMPANIES} employers)`}; their listings carry no sponsor claim either way, and the next scan continues where this one stopped.`,
          ]
        : []),
      ...(reuseDiscovery
        ? [
            'Discovery API data was reused from the prior report; this run made no new discovery-feed requests.',
          ]
        : []),
      ...(options.offlineReclassify
        ? [
            'Official content and hashes were reused from the immediately prior report; this reclassification made no network requests.',
          ]
        : []),
    ],
    attribution: sourceRegistry
      .filter((source) => source.state === 'active')
      .map((source) => ({ name: source.name, url: source.url })),
  };
  if (options.browseAll && options.browseAllResultCap !== undefined) {
    report = applyBrowseAllResultCap(report, options.browseAllResultCap);
  }
  const files = await writeGlobalRemoteReport(report, projectRoot);
  return { report, files };
}
