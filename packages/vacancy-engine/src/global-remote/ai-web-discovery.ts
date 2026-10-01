import { z } from 'zod';

import { discoveryAudit } from './discovery-shared.js';
import type { DiscoveryVacancyAudit, SourceRegistryEntry } from './models.js';

/**
 * Issue #398 -- AI-web-search vacancy discovery (Phase 1, on-demand).
 *
 * This module is the `vacancy-engine` half of the boundary the issue draws explicitly:
 *
 * ```
 * daemon AI-web discovery session (Claude WebSearch/WebFetch)
 *          |
 *          v
 * desktop orchestration calls AiWebDiscoveryCandidateSchema.safeParse() on the raw model output
 *          |
 *          v
 * normalizeAiWebDiscoveryCandidates()          <- this file
 *          |
 *          v
 * existing discoveryAudit()/identity/dedupe/scoring machinery (unchanged, shared with every source)
 * ```
 *
 * `vacancy-engine` never spawns a Claude/Codex session itself and gains no
 * `@agent-dock/agent-runtime` dependency -- it only validates and normalizes candidates the desktop
 * layer already collected. See `pipeline/global-remote.ts`'s `GlobalRemoteScanOptions.aiWebDiscoveryVacancies`
 * for where these rows re-enter the normal scan pipeline.
 */

/**
 * Evidence-per-fact for one extracted field (issue #398's "Search vs. extraction: evidence-per-fact"
 * section): `stated: true` means the source page explicitly said this, `stated: false` means the
 * model found nothing and the paired field must be `null` -- never an inference or an estimate.
 * `quote` is the verbatim/paraphrased fragment backing a `stated: true` claim, and is `null` when
 * nothing was stated (there is nothing to quote). This does not, by itself, stop a model from lying
 * about `stated`, but it does make "no inference" machine-checkable rather than a prompt-only
 * promise, exactly as the issue asks: a `stated: false` fact whose paired value is non-null is
 * rejected below (`superRefine`), so a model cannot claim "missing" while still reporting a number.
 */
const aiWebDiscoveryFactEvidenceSchema = z.object({
  stated: z.boolean(),
  quote: z.string().nullable(),
});

/**
 * Visa-sponsorship signal, extraction-time only (not the full post-discovery
 * `WorkEligibilityEvidence` assessment in `eligibility/models.ts`, which needs the candidate profile
 * and runs later in the pipeline). Closed to exactly `'yes' | 'no' | 'unknown'` -- the same
 * three-valued vocabulary `eligibilityAnswerSchema` already uses -- so "missing sponsorship signal"
 * has only one honest value to produce, `'unknown'`, and can never be silently collapsed into `'no'`.
 */
const aiWebDiscoverySponsorshipSchema = z.enum(['yes', 'no', 'unknown']);

export const aiWebDiscoveryEvidenceSchema = z
  .object({
    salary: aiWebDiscoveryFactEvidenceSchema,
    location: aiWebDiscoveryFactEvidenceSchema,
    employmentType: aiWebDiscoveryFactEvidenceSchema,
    postedAt: aiWebDiscoveryFactEvidenceSchema,
    visaSponsorship: aiWebDiscoverySponsorshipSchema,
    /**
     * Whether `url` was confirmed to resolve to this exact vacancy (not a generic `/careers`
     * landing page, not a bare search-result/aggregator page) -- issue #398's "Exact-page
     * verification, not snippet trust". `false` is always a legitimate, expected answer; nothing
     * downstream requires this to be `true`, but `applyUrl` evidence attached by `discoveryAudit()`
     * only ever reports `verified` for a URL the identity resolver itself confirms, independent of
     * what the model claims here.
     */
    exactUrlVerified: z.boolean(),
  })
  .nullable();

/**
 * One AI-web-discovered candidate vacancy, exactly as the model's JSON must validate against before
 * it is trusted as anything more than untrusted text (issue #398: "Model JSON must never be treated
 * as an already-trusted `DiscoveryVacancyAudit`"). Field-level `.nullable()`/`z.enum([...])` choices
 * follow `globalRemoteSourceSchema`'s existing convention in `models.ts`.
 */
export const AiWebDiscoveryCandidateSchema = z
  .object({
    company: z.string().min(1),
    title: z.string().min(1),
    // `z.url()` alone accepts `javascript:`/`data:`/`file:`/`vbscript:` schemes and embedded
    // credentials (`http://user:pass@host/...`) -- this source's URLs are effectively chosen by a
    // model reading attacker-controlled web content, so, like every other discovery source's `url`
    // field in this package (via `httpUrl()` in discovery-shared.ts, a plain validator rather than a
    // zod schema piece so not directly reusable here), this is narrowed to http(s)-only with no
    // embedded credentials.
    url: z.url().refine((value) => {
      try {
        const parsed = new URL(value);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.username === '' && parsed.password === '';
      } catch {
        return false;
      }
    }, 'url must be an http(s) URL with no embedded credentials'),
    /** "Not stated" (never omitted) when the source page genuinely never says. */
    location: z.string().min(1),
    description: z.string().nullable(),
    employmentType: z.string().nullable(),
    currency: z.string().nullable(),
    salaryPeriod: z.string().nullable(),
    advertisedMinimum: z.number().nonnegative().nullable(),
    /** ISO-8601 date string, or null when the source page carried no posting date at all. */
    postedAt: z.iso.date().nullable(),
    evidence: aiWebDiscoveryEvidenceSchema,
  })
  .superRefine((candidate, ctx) => {
    // Structural enforcement of "missing salary -> null, never an estimate": a candidate cannot
    // claim `evidence.salary.stated === false` (nothing found) while still reporting a number.
    if (candidate.evidence !== null && !candidate.evidence.salary.stated) {
      if (candidate.advertisedMinimum !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['advertisedMinimum'],
          message: 'advertisedMinimum must be null when evidence.salary.stated is false.',
        });
      }
      if (candidate.currency !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['currency'],
          message: 'currency must be null when evidence.salary.stated is false.',
        });
      }
      if (candidate.salaryPeriod !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['salaryPeriod'],
          message: 'salaryPeriod must be null when evidence.salary.stated is false.',
        });
      }
    }
    // Same "no inference, machine-checkable" enforcement as the salary block above, extended to the
    // other three per-fact evidence flags the doc comment and prompt already claim it applies to:
    // location, employmentType, postedAt.
    if (candidate.evidence !== null && !candidate.evidence.location.stated && candidate.location !== 'Not stated') {
      ctx.addIssue({
        code: 'custom',
        path: ['location'],
        message: 'location must be "Not stated" when evidence.location.stated is false.',
      });
    }
    if (candidate.evidence !== null && !candidate.evidence.employmentType.stated && candidate.employmentType !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['employmentType'],
        message: 'employmentType must be null when evidence.employmentType.stated is false.',
      });
    }
    if (candidate.evidence !== null && !candidate.evidence.postedAt.stated && candidate.postedAt !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['postedAt'],
        message: 'postedAt must be null when evidence.postedAt.stated is false.',
      });
    }
  });
export type AiWebDiscoveryCandidate = z.infer<typeof AiWebDiscoveryCandidateSchema>;

/**
 * The full expected shape of one AI-web-discovery session's output. `queriesUsed` exists because the
 * issue requires "the actual queries used in a run are persisted/reportable" -- the desktop
 * orchestrator (Stage B) is the one that actually persists/reports it; this schema only carries it
 * through validation intact.
 */
export const AiWebDiscoveryResponseSchema = z.object({
  candidates: z.array(AiWebDiscoveryCandidateSchema),
  queriesUsed: z.array(z.string()),
});
export type AiWebDiscoveryResponse = z.infer<typeof AiWebDiscoveryResponseSchema>;

/**
 * Converts already-validated candidates into `DiscoveryVacancyAudit` rows, through the same
 * `discoveryAudit()` boundary every other discovery source in this package uses -- never bypassed,
 * per the issue's explicit requirement. Every field is populated exactly as honestly as the
 * candidate schema allows: `null`/`"Not stated"` where the model reported nothing, never invented.
 *
 * `key` follows this package's existing `"<provider>:<stable-identifier>"` convention (see e.g.
 * `ai_dev_jobs:${id}`, `workable_global:${record.shortcode}`, or `adzuna:${identifier(job.id,
 * urlValue)}` in `keyed-discovery.ts`/`discovery.ts`). An AI-web-discovered candidate carries no
 * upstream-issued id, so `url` -- the one thing `discoveryAudit()` itself already treats as the
 * strongest available identity signal via `vacancyIdentityFor` -- is used as the stable identifier,
 * matching how `adzuna`/`jooble`/`reed`/`jobspipe` already fall back to the URL when no native id
 * exists (`identifier(job.id, urlValue)`).
 *
 * `minimumAnnualBaseUsd` is passed as `null`: this function's signature (deliberately, per issue
 * #398) takes no `GlobalRemoteConfig`, so no local salary floor is available at normalization time.
 * That never drops a row -- it only means `classifyDiscoveryVacancy` cannot yet decide
 * `salary_below_threshold` here, exactly like every other source before the pipeline's own
 * `minimumAnnualBaseUsd`-aware scoring later re-evaluates every merged row in `runGlobalRemoteScan`.
 */
export function normalizeAiWebDiscoveryCandidates(
  candidates: AiWebDiscoveryCandidate[],
): DiscoveryVacancyAudit[] {
  return candidates.map((candidate) =>
    discoveryAudit({
      key: `ai_web_search:${candidate.url}`,
      provider: 'ai_web_search',
      company: candidate.company,
      title: candidate.title,
      url: candidate.url,
      location: candidate.location,
      employmentType: candidate.employmentType,
      currency: candidate.currency,
      salaryPeriod: candidate.salaryPeriod,
      advertisedMinimum: candidate.advertisedMinimum,
      // An AI-extracted figure is read from free-text page content, never a structured API field --
      // 'loose_text' is the honest provenance whenever a figure was actually stated, matching the
      // vocabulary in salary.ts (`SalaryProvenance`). No figure was stated -> 'unreviewed', which
      // `normalizeSalary` already treats as non-comparable, same as every source that never reports
      // a salary at all.
      salaryProvenance: candidate.advertisedMinimum === null ? 'unreviewed' : 'loose_text',
      description: candidate.description,
      postedAt: candidate.postedAt,
      raw: candidate,
      minimumAnnualBaseUsd: null,
    }),
  );
}

function normalizedHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return null;
  }
}

/**
 * Issue #398 / #151: whether `url`'s hostname matches, or is a subdomain of, a `registry` entry this
 * project has already reviewed and marked `'prohibited'` or `'blocked'` (LinkedIn, Indeed, Glassdoor
 * Direct, Google Jobs, EURES, ZipRecruiter -- only these two states are checked, not every
 * non-`'active'` state; a `'manual_only'`/`'configuration_required'`/`'partner_required'` entry such
 * as Built In is deliberately NOT caught here). Called by the desktop orchestrator (or the
 * normalizer) before ever `WebFetch`-ing a candidate URL -- an AI-web-search session has no awareness
 * of this registry on its own, and can surface a result page on an already-rejected domain exactly as
 * easily as on an approved one, and an AI WebSearch pass driven by `primaryCountry` is exactly the
 * mechanism most likely to surface a country-subdomain variant of one (e.g. `nl.linkedin.com`,
 * `jobs.linkedin.com`, `uk.indeed.com`).
 *
 * Both sides are normalized (lowercased, `www.` stripped) before comparing, then matched on a
 * dot-boundary suffix rather than exact equality, so `https://www.linkedin.com/jobs/...`,
 * `https://linkedin.com/jobs/...`, and `https://nl.linkedin.com/jobs/...` all match a registry entry
 * whose own `url` is `https://www.linkedin.com/jobs/`, while a look-alike, differently-registrable
 * domain like `linkedin.com.evil.com` correctly does NOT match (it is not `linkedin.com` and does not
 * end with `.linkedin.com`).
 *
 * Fails closed: a malformed/unparseable `url` (or a registry entry whose own `url` happens to be
 * unparseable) is treated as blocked rather than silently let through, and this function never
 * throws on bad input.
 */
export function isBlockedDiscoveryDomain(
  url: string,
  registry: readonly SourceRegistryEntry[],
): boolean {
  const candidateHost = normalizedHostname(url);
  if (candidateHost === null) return true;
  return registry.some((source) => {
    if (source.state !== 'prohibited' && source.state !== 'blocked') return false;
    const registryHost = normalizedHostname(source.url);
    return registryHost !== null && (candidateHost === registryHost || candidateHost.endsWith(`.${registryHost}`));
  });
}
