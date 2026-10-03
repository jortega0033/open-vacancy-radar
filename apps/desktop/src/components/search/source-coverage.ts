import type { GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import { discoveryProviderLabel } from '../../discovery-provider-labels.js';

type DiscoverySource = GlobalRemoteReport['discoverySources'][number];

export type SourceCoverageKind = 'not_set_up' | 'failed' | 'incomplete';

export interface SourceCoverageGroup {
  kind: SourceCoverageKind;
  /** Plain-language heading, with the source count. */
  title: string;
  /** What the group means for the candidate. */
  description: string;
  /** Display names of the sources in this group, grouped by name with counts. */
  providers: Array<{ name: string; count: number }>;
}

export interface SourceCoverage {
  /** Sources that returned partial or no results, in report order. */
  warnings: DiscoverySource[];
  groups: SourceCoverageGroup[];
  /** Sources whose own run status says they finished and returned everything they had. */
  completeCount: number;
  /** Whether at least one ATS company list is missing, so downloading it would add sources. */
  rosterMissing: boolean;
  /** One sentence leading the coverage panel, built from the counts above. */
  summary: string;
}

/**
 * The ATS roster scan reports a provider with an empty company list as a finished, empty run
 * (`status: 'success'`, `complete: true`). That is not a source that looked and found nothing: it
 * never looked. The engine marks it with this message and, on the first roster row, a zero
 * `rosterScan.totalRosterSize`.
 */
export function isRosterMissing(source: DiscoverySource): boolean {
  if (!source.id.endsWith(':roster-scan')) return false;
  if (source.rosterScan?.totalRosterSize === 0) return true;
  return source.requests === 0 && (source.error?.startsWith('No imported roster entries') ?? false);
}

function classify(source: DiscoverySource): SourceCoverageKind | null {
  if (isRosterMissing(source)) return 'not_set_up';
  if (source.status === 'error' || source.status === 'blocked') return 'failed';
  if (source.status === 'partial' || source.complete === false) return 'incomplete';
  return null;
}

function sourceWord(count: number): string {
  return count === 1 ? 'source' : 'sources';
}

/**
 * Splits a report's discovery sources into the ones that need the candidate's attention and the
 * ones that finished, using each source's stored `status` and `complete` flag. "Complete" is only
 * claimed for a source whose own run says so, never inferred from the others.
 */
export function summarizeSourceCoverage(sources: DiscoverySource[]): SourceCoverage {
  const warnings: DiscoverySource[] = [];
  const byKind: Record<SourceCoverageKind, Map<string, number>> = {
    not_set_up: new Map(),
    failed: new Map(),
    incomplete: new Map()
  };

  for (const source of sources) {
    const kind = classify(source);
    if (kind === null) continue;
    warnings.push(source);
    const label = discoveryProviderLabel(source.provider);
    const count = byKind[kind].get(label) ?? 0;
    byKind[kind].set(label, count + 1);
  }
  const completeCount = sources.length - warnings.length;

  const groups: SourceCoverageGroup[] = [];
  const add = (kind: SourceCoverageKind, label: string, description: string) => {
    const providerMap = byKind[kind];
    if (providerMap.size === 0) return;
    const providers = Array.from(providerMap.entries()).map(([name, count]) => ({ name, count }));
    groups.push({
      kind,
      title: `${providerMap.size} ${sourceWord(providerMap.size)} ${label}`,
      description,
      providers
    });
  };
  add('not_set_up', 'not set up', 'These need the ATS company list, which has not been downloaded yet.');
  add('failed', 'failed', 'These could not be reached or returned an error. Run a new scan to try them again.');
  add('incomplete', 'stopped early', 'These returned some results but did not reach the end of their listings. Run a new scan to try again.');

  const count = warnings.length;
  const lead = count === sources.length
    ? `${count} ${sourceWord(count)} returned partial or no results.`
    : `${count} ${sourceWord(count)} returned partial or no results. Results from the other ${sourceWord(completeCount)} are complete.`;

  return {
    warnings,
    groups,
    completeCount,
    rosterMissing: byKind.not_set_up.size > 0,
    summary: lead,
  };
}
