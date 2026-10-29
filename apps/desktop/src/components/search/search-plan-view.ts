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
  covered_by_earlier_query: 'same words as an earlier title',
  deferred_request_budget: 'not searched: request allowance used up',
  deferred_time_budget: 'not searched: time allowance used up',
  deferred_result_cap: 'not searched: result allowance used up',
};

/** "Found with: React developer; Frontend ontwikkelaar (Dutch)" for a lead of a planned run, else null. */
export function describeLeadQueries(vacancy: Pick<DiscoveryVacancyAudit, 'queryProvenance'>): string | null {
  const provenance = vacancy.queryProvenance;
  if (!provenance || !Array.isArray(provenance.matchedLocally)) return null;
  const matched = provenance.matchedLocally.map(queryLabel);
  if (matched.length === 0) return null;
  const fetched = Array.isArray(provenance.fetchedBy) ? provenance.fetchedBy : [];
  const upstream = [...new Set(fetched.map((origin) => `${queryLabel(origin)} at ${discoveryProviderLabel(origin.provider)}`))];
  return `${matched.join('; ')}${upstream.length > 0 ? `. Returned by the source for: ${upstream.join('; ')}` : '. Matched in the source feed, which cannot filter by title'}`;
}

/** Shown above the results when some approved titles could not be fully searched at the sources. */
export function searchPlanCoverageNotice(report: Pick<GlobalRemoteReport, 'searchPlan'> | null): string | null {
  const plan = report?.searchPlan;
  if (!plan || plan.coverage !== 'partial') return null;
  const variants = Array.isArray(plan.variants) ? plan.variants : [];
  const incomplete = variants.filter((entry) => entry.handling !== 'sent_upstream' && entry.handling !== 'covered_by_earlier_query');
  const names = incomplete.map((entry) => entry.query).slice(0, 4).join(', ');
  return (
    `Your search plan was only partly searched at the sources: ${incomplete.length} of ${variants.length} approved ` +
    `${variants.length === 1 ? 'title' : 'titles'}${names ? ` (${names}${incomplete.length > 4 ? ', …' : ''})` : ''} used up the shared allowance. ` +
    `Results still include every approved title that appears in the rows that were fetched.`
  );
}

/** Diagnostics lines: the plan, its allowance and use, each title's handling, and each source's handling. */
export function describeSearchPlanDiagnostics(
  report: Pick<GlobalRemoteReport, 'searchPlan' | 'discoverySources'>,
  redact: (text: string) => string = (text) => text,
): string[] {
  const plan = report.searchPlan;
  if (!plan) return [];
  const lines: string[] = [];
  const envelope = plan.envelope;
  const usage = plan.usage;
  lines.push(
    `Search plan revision ${plan.planRevision}: ${plan.queries?.length ?? 0} queries, ${plan.coverage} coverage. ` +
      `Shared allowance ${envelope?.maxRequests} requests / ${Math.round((envelope?.maxDurationMs ?? 0) / 1000)} s / ${envelope?.maxResults} rows; ` +
      `used ${usage?.literalRequests} (typed query) + ${usage?.variantRequests} (approved titles) requests, ${usage?.variantRows} extra rows.`,
  );
  for (const entry of plan.variants ?? []) {
    lines.push(redact(`  ${queryLabel(entry)}: ${HANDLING_WORDS[entry.handling] ?? entry.handling}${entry.reason ? ` (${entry.reason})` : ''}`));
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
