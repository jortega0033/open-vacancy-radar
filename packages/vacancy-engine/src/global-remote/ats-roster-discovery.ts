import { createVacancyAdapter } from '../ats/factory.js';
import type { AtsHttpClient } from '../ats/http.js';
import {
  ATS_ROSTER_PROVIDERS,
  type AtsRosterEntry,
  type AtsRosterProvider,
} from '../companies/ats-roster-source.js';
import {
  classifyAtsSourceFailure,
  emptyAtsSourceObservationFile,
  loadAtsSourceObservations,
  planAtsRosterScan,
  recordAtsSourceObservation,
  writeAtsSourceObservations,
  type AtsRosterScanPlan,
  type AtsSourceFailureCategory,
} from '../companies/ats-source-observation-repository.js';
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
  providerRosterSize: number,
  companiesAttempted: number,
  tally: ProviderTally,
  counters: NetworkAttemptCounters,
  scanMode: AtsRosterScanPlan['mode'],
  rosterScan?: DiscoverySourceAudit['rosterScan'],
): DiscoverySourceAudit {
  const discoveryProvider = rosterDiscoveryProvider(provider);
  if (companiesAttempted === 0) {
    const noEntries = providerRosterSize === 0;
    const message = noEntries
      ? 'No imported roster entries for this provider yet; run the ats-roster:import CLI command first.'
      : 'No ATS roster tenants were due for this provider in the current incremental scan.';
    return {
      id: `${discoveryProvider}:roster-scan`,
      provider: discoveryProvider,
      url: `https://storage.stapply.ai/jobhive/v1/${provider}/companies.csv`,
      requests: 0,
      listings: 0,
      status: 'success',
      error: message,
      ...networkAttemptFields(counters),
      // Nothing was skipped or capped -- there was simply nothing to scan for this provider.
      ...(noEntries || scanMode === 'complete'
        ? completeAudit()
        : incompleteAudit(message, rosterScan?.checkpoint.toString() ?? null)),
      ...(rosterScan === undefined ? {} : { rosterScan }),
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
    // A complete scan walks the provider partition. A focused scan is deliberately marked
    // incomplete because its due queue and exploration budget cover only a bounded tenant batch.
    ...(tally.companiesFailed > 0
      ? incompleteAudit(error ?? 'One or more attempted companies failed for this provider.')
      : scanMode === 'incremental'
        ? incompleteAudit(
            'Focused ATS roster discovery attempted a bounded due batch.',
            rosterScan?.checkpoint.toString() ?? null,
          )
        : completeAudit()),
    ...(rosterScan === undefined ? {} : { rosterScan }),
  };
}

/**
 * Scans imported ATS tenants (`companies/ats-roster-repository.ts`) through this
 * repo's existing, previously-orphaned ATS parsers (`ats/factory.ts#createVacancyAdapter`) -- exactly
 * the call `global-remote/official.ts` already makes for one curated vacancy, just looped over a
 * roster instead of a reviewed list. Unfocused scans preserve the complete-roster behavior;
 * focused scans use persisted health observations, due scheduling, and a reserved exploration
 * budget. Bounded worker-pool concurrency
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
  projectRoot?: string,
): Promise<DiscoveryRun> {
  let observationState = projectRoot === undefined
    ? emptyAtsSourceObservationFile()
    : await loadAtsSourceObservations(projectRoot);
  const plan: AtsRosterScanPlan = planAtsRosterScan(roster, observationState, {
    roleQuery: config.discovery.roleQuery,
    country: config.discovery.atsRosterFocusCountry ?? '',
    maxSources: config.discovery.atsRosterMaxSourcesPerFocusedScan ?? 200,
    explorationBudget: config.discovery.atsRosterExplorationBudget ?? 80,
  });
  observationState = plan.nextState;
  // Reserve the cursor before issuing requests. A crash may defer a reserved tenant until the next
  // cursor cycle, but it cannot restart the same exploration batch indefinitely.
  if (projectRoot !== undefined && plan.mode === 'incremental') {
    await writeAtsSourceObservations(projectRoot, observationState);
  }
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
  const failuresByCategory: Partial<Record<AtsSourceFailureCategory, number>> = {};
  let newlyVerifiedSources = 0;

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= plan.entries.length) return;
      const entry = plan.entries[index]!.entry;
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
        const previous = observationState.observations.find(
          (observation) => observation.provider === entry.provider && observation.slug.toLowerCase() === entry.slug.toLowerCase(),
        );
        const status = result.vacancies.length === 0 ? 'empty' : 'verified';
        if (status === 'verified' && previous?.status !== 'verified') newlyVerifiedSources += 1;
        observationState = recordAtsSourceObservation(observationState, {
          entry,
          status,
          errorCategory: null,
          vacancies: result.vacancies,
        });
      } catch (error) {
        tally.requests += 1;
        tally.companiesFailed += 1;
        const failure = sourceFailure(error);
        if (failure.status === 'blocked') tally.companiesBlocked += 1;
        tally.lastError = `${entry.slug}: ${failure.error}`;
        const category = classifyAtsSourceFailure(error);
        failuresByCategory[category] = (failuresByCategory[category] ?? 0) + 1;
        observationState = recordAtsSourceObservation(observationState, {
          entry,
          status: failure.status === 'blocked' ? 'blocked' : 'error',
          errorCategory: category,
          vacancies: [],
        });
      }
      tallyByProvider.set(entry.provider, tally);
    }
  }

  const concurrency = Math.max(1, Math.min(config.discovery.atsRosterConcurrency, plan.entries.length || 1));
  await Promise.all(Array.from({ length: concurrency }, worker));

  if (projectRoot !== undefined) {
    await writeAtsSourceObservations(projectRoot, observationState);
  }

  const rosterScan: NonNullable<DiscoverySourceAudit['rosterScan']> = {
    mode: plan.mode,
    totalRosterSize: plan.totalRosterSize,
    dueSourcesAttempted: plan.entries.length,
    explorationSourcesAttempted: plan.entries.filter((entry) => entry.reason === 'exploration').length,
    newlyVerifiedSources,
    skippedNotDue: plan.skippedNotDue,
    failuresByCategory,
    checkpoint: plan.checkpoint,
  };

  const sources = ATS_ROSTER_PROVIDERS.map((provider) =>
    sourceAuditFor(
      provider,
      roster.filter((entry) => entry.provider === provider).length,
      attemptedByProvider.get(provider) ?? 0,
      tallyByProvider.get(provider) ?? emptyTally(),
      countersByProvider.get(provider) ?? newNetworkAttemptCounters(),
      plan.mode,
      provider === ATS_ROSTER_PROVIDERS[0] ? rosterScan : undefined,
    ),
  );

  return { sources, vacancies };
}
