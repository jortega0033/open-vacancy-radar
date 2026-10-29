import type {
  DiscoveryVacancyAudit,
  GlobalRemoteReport,
  SearchPlanHandling,
  SearchPlanQueryRef,
} from '@open-vacancy-radar/vacancy-engine';
import { discoveryProviderLabel } from '../../discovery-provider-labels.js';

/**
 * Plain-language views of the search-plan fields a report carries (#686). A saved report may come from
 * another build or have been edited, so everything here tolerates a missing or odd field and says
 * nothing rather than throwing.
 */

function queryLabel(ref: Pick<SearchPlanQueryRef, 'query' | 'language'>): string {
  return ref.language ? `${ref.query} (${ref.language})` : ref.query;
}

const HANDLING_WORDS: Record<SearchPlanHandling, string> = {
  sent_upstream: 'searched at the source',
  local_only: 'matched here only',
  partial: 'only partly searched at the source',
  not_sent: 'no request reached the source',
  covered_by_earlier_query: 'same words as an earlier title',
  deferred_request_budget: 'not searched: request allowance used up',
  deferred_time_budget: 'not searched: time allowance used up',
  deferred_result_cap: 'not searched: result allowance used up',
};

/**
 * "Found with: React developer; Frontend ontwikkelaar (Dutch)" for a lead of a planned run, else null.
 * A match only in the description (possible for the typed query alone) is said to be one.
 */
export function describeLeadQueries(vacancy: Pick<DiscoveryVacancyAudit, 'queryProvenance'>): string | null {
  const provenance = vacancy.queryProvenance;
  if (!provenance || !Array.isArray(provenance.matchedLocally)) return null;
  const matched = provenance.matchedLocally.map((entry) =>
    entry.field === 'description' ? `${queryLabel(entry)} (mentioned only in the description)` : queryLabel(entry),
  );
  if (matched.length === 0) return null;
  const fetched = Array.isArray(provenance.fetchedBy) ? provenance.fetchedBy : [];
  const upstream = [...new Set(fetched.map((origin) => `${queryLabel(origin)} at ${discoveryProviderLabel(origin.provider)}`))];
  return `${matched.join('; ')}${upstream.length > 0 ? `. Returned by the source for: ${upstream.join('; ')}` : '. Matched in the source feed, which cannot filter by title'}`;
}

/** Shown above the results when the plan was not fully searched within its one shared allowance. */
export function searchPlanCoverageNotice(report: Pick<GlobalRemoteReport, 'searchPlan'> | null): string | null {
  const plan = report?.searchPlan;
  if (!plan || plan.coverage !== 'partial') return null;
  const variants = Array.isArray(plan.variants) ? plan.variants : [];
  const incomplete = variants.filter((entry) => entry.handling !== 'sent_upstream' && entry.handling !== 'covered_by_earlier_query');
  const names = incomplete.map((entry) => entry.query).slice(0, 4).join(', ');
  const typedPartly = plan.literal?.handling === 'partial';
  const parts = [
    ...(typedPartly ? ['the typed query was only partly searched'] : []),
    ...(incomplete.length > 0
      ? [
          `${incomplete.length} of ${variants.length} approved ${variants.length === 1 ? 'title' : 'titles'}${names ? ` (${names}${incomplete.length > 4 ? ', …' : ''})` : ''} could not be fully searched`,
        ]
      : []),
  ];
  if (parts.length === 0) return null;
  return (
    `Your search plan used up its shared allowance: ${parts.join(' and ')}. ` +
    `Results still include every approved title found in the listings that were fetched.`
  );
}

/** Shown when a run asked for the plan but ran without it (empty or unreadable at start). */
export function searchPlanStatusNotice(report: Pick<GlobalRemoteReport, 'searchPlanStatus'> | null): string | null {
  const status = report?.searchPlanStatus;
  if (!status || status.state === 'used') return null;
  return typeof status.message === 'string' && status.message ? status.message : 'This search did not use your search plan.';
}

/** Diagnostics lines: the plan, its one allowance and use, each title's handling, each source's handling. */
export function describeSearchPlanDiagnostics(
  report: Pick<GlobalRemoteReport, 'searchPlan' | 'discoverySources' | 'searchPlanStatus'>,
  redact: (text: string) => string = (text) => text,
): string[] {
  const statusNotice = searchPlanStatusNotice(report);
  const plan = report.searchPlan;
  if (!plan) return statusNotice ? [redact(`Search plan not used: ${statusNotice}`)] : [];
  const lines: string[] = [];
  const envelope = plan.envelope;
  const usage = plan.usage;
  lines.push(
    `Search plan revision ${plan.planRevision}: ${plan.queries?.length ?? 0} queries, ${plan.coverage} coverage. ` +
      `One shared allowance for the whole plan: ${envelope?.maxRequests} network requests (each retry and redirect counted) / ` +
      `${Math.round((envelope?.maxDurationMs ?? 0) / 1000)} s / ${envelope?.maxResults} matching rows; ` +
      `used ${usage?.attempts} (${usage?.literalAttempts} typed query, ${usage?.variantAttempts} approved titles), ` +
      `${usage?.refusedCalls ?? 0} requests not made, ${usage?.matchingRows} matching rows` +
      `${usage?.trimmedRows ? ` (${usage.trimmedRows} left out)` : ''}.`,
  );
  if (plan.budgetScope?.excludes) {
    lines.push(`  Outside the allowance (${usage?.outsideEnvelopeAttempts ?? 0} network requests): ${plan.budgetScope.excludes}`);
  }
  if (plan.literal) {
    lines.push(redact(`  Typed query: ${HANDLING_WORDS[plan.literal.handling] ?? plan.literal.handling}${plan.literal.reason ? ` (${plan.literal.reason})` : ''}`));
  }
  for (const entry of plan.variants ?? []) {
    const providers = Array.isArray(entry.providersQueried) && entry.providersQueried.length > 0
      ? `; asked at ${entry.providersQueried.map(discoveryProviderLabel).join(', ')}`
      : '';
    lines.push(redact(`  ${queryLabel(entry)}: ${HANDLING_WORDS[entry.handling] ?? entry.handling}${providers}${entry.reason ? ` (${entry.reason})` : ''}`));
  }
  if (Array.isArray(plan.providersNeverAsked) && plan.providersNeverAsked.length > 0) {
    lines.push(`  Never asked for any approved title: ${plan.providersNeverAsked.map(discoveryProviderLabel).join(', ')}`);
  }
  for (const entry of plan.criteria ?? []) {
    lines.push(redact(`  ${entry.criterion.replace('_', ' ')} "${entry.value}": ${entry.treatment === 'not_applied' ? 'not applied' : 'searched as written'} (${entry.reason})`));
  }
  for (const source of report.discoverySources) {
    const handling = source.focusedScan?.searchPlan;
    if (!handling || handling.length === 0) continue;
    const grouped = new Map<string, string[]>();
    for (const entry of handling) {
      const words = HANDLING_WORDS[entry.handling] ?? entry.handling;
      grouped.set(words, [...(grouped.get(words) ?? []), entry.query]);
    }
    lines.push(
      redact(
        `  ${discoveryProviderLabel(source.provider)} (${source.id}): ${[...grouped].map(([words, queries]) => `${words}: ${queries.join(', ')}`).join('; ')}`,
      ),
    );
  }
  return lines;
}
