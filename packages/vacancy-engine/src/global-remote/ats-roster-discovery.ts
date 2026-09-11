import { createVacancyAdapter } from '../ats/factory.js';
import type { AtsHttpClient } from '../ats/http.js';
import {
  ATS_ROSTER_PROVIDERS,
  type AtsRosterEntry,
  type AtsRosterProvider,
} from '../companies/ats-roster-source.js';
import type { CareerSourceDescriptor, NormalizedVacancy, VacancyAdapter } from '../domain/models.js';
import {
  attributeNetworkRequests,
  networkAttemptFields,
  newNetworkAttemptCounters,
  type NetworkAttemptCounters,
} from './discovery-attribution.js';
import { completeAudit, discoveryAudit, incompleteAudit, sourceFailure } from './discovery-shared.js';
import type {
  DiscoveryProvider,
  DiscoveryRun,
  DiscoverySourceAudit,
  DiscoveryVacancyAudit,
  GlobalRemoteConfig,
} from './models.js';

function rosterDiscoveryProvider(provider: AtsRosterProvider): DiscoveryProvider {
  switch (provider) {
    case 'greenhouse':
      return 'ats_roster_greenhouse';
    case 'lever':
      return 'ats_roster_lever';
    case 'ashby':
      return 'ats_roster_ashby';
    case 'recruitee':
      return 'ats_roster_recruitee';
    case 'personio':
      return 'ats_roster_personio';
  }
}

function descriptorFor(entry: AtsRosterEntry): CareerSourceDescriptor {
  return {
    id: `${entry.provider}:${entry.slug}`,
    companyId: `${entry.provider}:${entry.slug}`,
    companyName: entry.company,
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    boardIdentifier: entry.slug,
    // This source has no reviewed lifecycle baseline for any individual vacancy (unlike
    // `official.ts`'s curated `officialSources`): every row here is fresh discovery output, not an
    // authoritative confirmation that a specific previously-seen posting is still live.
    lifecycleAuthoritative: false,
  };
}

/**
 * `NormalizedVacancy` carries no salary fields at all (see `domain/models.ts`), unlike every other
 * discovery source in this package, so `currency`/`salaryPeriod`/`advertisedMinimum` are always null
 * here -- not a parsing gap, the ATS board feeds these adapters read genuinely do not publish salary.
 */
function normalizeRosterVacancy(
  discoveryProvider: DiscoveryProvider,
  entry: AtsRosterEntry,
  vacancy: NormalizedVacancy,
  minimumAnnualBaseUsd: number | null,
): DiscoveryVacancyAudit {
  return discoveryAudit({
    key: `${discoveryProvider}:${entry.slug}:${vacancy.externalId}`,
    provider: discoveryProvider,
    company: entry.company,
    title: vacancy.title,
    url: vacancy.url,
    location: vacancy.location ?? 'Not stated',
    employmentType: vacancy.employmentType,
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    description: vacancy.description,
    postedAt: vacancy.postedAt === null ? null : vacancy.postedAt.toISOString(),
    raw: vacancy,
    minimumAnnualBaseUsd,
  });
}

type ProviderTally = {
  requests: number;
  listings: number;
  companiesFailed: number;
  companiesBlocked: number;
  lastError: string | null;
};

function emptyTally(): ProviderTally {
  return { requests: 0, listings: 0, companiesFailed: 0, companiesBlocked: 0, lastError: null };
}

function sourceAuditFor(
  provider: AtsRosterProvider,
  companiesAttempted: number,
  tally: ProviderTally,
  counters: NetworkAttemptCounters,
): DiscoverySourceAudit {
  const discoveryProvider = rosterDiscoveryProvider(provider);
  if (companiesAttempted === 0) {
    return {
      id: `${discoveryProvider}:roster-scan`,
      provider: discoveryProvider,
      url: `https://storage.stapply.ai/jobhive/v1/${provider}/companies.csv`,
      requests: 0,
      listings: 0,
      status: 'success',
      error: 'No imported roster entries for this provider yet; run the ats-roster:import CLI command first.',
      ...networkAttemptFields(counters),
      // Nothing was skipped or capped -- there was simply nothing to scan for this provider.
      ...completeAudit(),
    };
  }
  const status: DiscoverySourceAudit['status'] =
    tally.companiesFailed === 0
      ? 'success'
      : tally.companiesBlocked === companiesAttempted
        ? 'blocked'
        : tally.companiesFailed === companiesAttempted
          ? 'error'
          : 'partial';
  const error =
    tally.companiesFailed === 0
      ? null
      : `${tally.companiesFailed}/${companiesAttempted} companies failed (last error: ${tally.lastError ?? 'unknown'}).`;
  return {
    id: `${discoveryProvider}:roster-scan`,
    provider: discoveryProvider,
    url: `https://storage.stapply.ai/jobhive/v1/${provider}/companies.csv`,
    requests: tally.requests,
    listings: tally.listings,
    status,
    error,
    ...networkAttemptFields(counters),
    // Every roster company for this provider was attempted (a per-company failure is folded into
    // `tally`, not skipped) -- so this provider's own partition of the roster is always fully
    // walked. A per-company failure still shows up as `status !== 'success'`/`error` above; it is
    // not the kind of "stopped early" gap `complete`/`completenessReason` exist to describe.
    ...(tally.companiesFailed === companiesAttempted && companiesAttempted > 0
      ? incompleteAudit(error ?? 'All attempted companies failed for this provider.')
      : completeAudit()),
  };
}

/**
 * Scans every company in the imported ATS roster (`companies/ats-roster-repository.ts`) through this
 * repo's existing, previously-orphaned ATS parsers (`ats/factory.ts#createVacancyAdapter`) -- exactly
 * the call `global-remote/official.ts` already makes for one curated vacancy, just looped over a
 * roster instead of a reviewed review list. Bounded worker-pool concurrency
 * (`config.discovery.atsRosterConcurrency`), mirroring `applyWorldwideSponsorMatches` in
 * `pipeline/global-remote.ts`, since the roster can hold thousands of companies. One company's
 * failure (a stale/renamed board, a block, a timeout) never aborts the rest of the scan
 * (docs/job-source-policy.md: "isolate failure so one unavailable source cannot block other source
 * scans") -- it is folded into that provider's aggregate `DiscoverySourceAudit` instead of failing
 * the run. Vacancies are reported against one source per provider (`ats_roster_<provider>:roster-scan`),
 * not one per company, so a multi-thousand-company roster does not balloon `discoverySources` to
 * match.
 *
 * No field here is ever read from, or derived from, a country. `AtsRosterEntry` (the roster's own
 * type) has no country field to read in the first place -- see `companies/ats-roster-source.ts`.
 */
export async function runAtsRosterDiscovery(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
  roster: readonly AtsRosterEntry[],
): Promise<DiscoveryRun> {
  // One `NetworkAttemptCounters` per provider, not per company: every company of a given provider
  // shares one `DiscoverySourceAudit` row (see the module doc comment above), so their attempts are
  // meant to accumulate together -- what must not happen is a *different provider's* attempts
  // landing here, which wrapping each provider's own adapter client with its own counters prevents
  // exactly the way `attributeNetworkRequests` prevents it between top-level discovery branches.
  const countersByProvider = new Map<AtsRosterProvider, NetworkAttemptCounters>(
    ATS_ROSTER_PROVIDERS.map((provider) => [provider, newNetworkAttemptCounters()]),
  );
  const adapters = new Map<AtsRosterProvider, VacancyAdapter>();
  for (const provider of ATS_ROSTER_PROVIDERS) {
    const providerCounters = countersByProvider.get(provider) ?? newNetworkAttemptCounters();
    const adapter = createVacancyAdapter(provider, attributeNetworkRequests(http, providerCounters));
    // `ATS_ROSTER_PROVIDERS` is a fixed subset of the providers `createVacancyAdapter` already
    // handles (see `ats/factory.ts`), so this can only fail if the two lists ever drift apart.
    if (adapter === null) throw new Error(`No adapter registered for ATS roster provider ${provider}`);
    adapters.set(provider, adapter);
  }
  const attemptedByProvider = new Map<AtsRosterProvider, number>(
    ATS_ROSTER_PROVIDERS.map((provider) => [provider, 0]),
  );
  const tallyByProvider = new Map<AtsRosterProvider, ProviderTally>(
    ATS_ROSTER_PROVIDERS.map((provider) => [provider, emptyTally()]),
  );
  const vacancies: DiscoveryVacancyAudit[] = [];

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= roster.length) return;
      const entry = roster[index]!;
      attemptedByProvider.set(entry.provider, (attemptedByProvider.get(entry.provider) ?? 0) + 1);
      const tally = tallyByProvider.get(entry.provider) ?? emptyTally();
      try {
        // Guaranteed present: `adapters` was populated for every `ATS_ROSTER_PROVIDERS` entry above.
        const adapter = adapters.get(entry.provider);
        if (adapter === undefined) throw new Error(`No adapter registered for provider ${entry.provider}`);
        const result = await adapter.listVacancies(descriptorFor(entry));
        tally.requests += result.requestCount;
        tally.listings += result.vacancies.length;
        const discoveryProvider = rosterDiscoveryProvider(entry.provider);
        for (const vacancy of result.vacancies) {
          vacancies.push(normalizeRosterVacancy(discoveryProvider, entry, vacancy, config.minimumAnnualBaseUsd));
        }
      } catch (error) {
        tally.requests += 1;
        tally.companiesFailed += 1;
        const failure = sourceFailure(error);
        if (failure.status === 'blocked') tally.companiesBlocked += 1;
        tally.lastError = `${entry.slug}: ${failure.error}`;
      }
      tallyByProvider.set(entry.provider, tally);
    }
  }

  const concurrency = Math.max(1, Math.min(config.discovery.atsRosterConcurrency, roster.length));
  await Promise.all(Array.from({ length: concurrency }, worker));

  const sources = ATS_ROSTER_PROVIDERS.map((provider) =>
    sourceAuditFor(
      provider,
      attemptedByProvider.get(provider) ?? 0,
      tallyByProvider.get(provider) ?? emptyTally(),
      countersByProvider.get(provider) ?? newNetworkAttemptCounters(),
    ),
  );

  return { sources, vacancies };
}
