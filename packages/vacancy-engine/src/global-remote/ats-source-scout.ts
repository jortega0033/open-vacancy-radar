import { createVacancyAdapter } from '../ats/factory.js';
import type { AtsHttpClient } from '../ats/http.js';
import type { AtsRosterEntry, AtsRosterProvider } from '../companies/ats-roster-source.js';
import {
  atsSourceKey,
  classifyAtsSourceFailure,
  loadAtsSourceObservations,
  planAtsRosterScan,
  recordAtsSourceObservation,
  retryAfterMsFromError,
  writeAtsSourceObservations,
  type AtsSourceFailureCategory,
  type AtsSourceObservationFile,
} from '../companies/ats-source-observation-repository.js';
import type { CareerSourceDescriptor } from '../domain/models.js';
import { hasStableVacancyIdentity } from '../pipeline/ats-source-observation-import.js';

/**
 * Bounded, deterministic ATS source scouting (#348). One call is one scout run: it asks #341's
 * planner (`planAtsRosterScan`) for a bounded refresh batch plus a reserved exploration quota,
 * reads each planned tenant through the existing ATS adapters and safe HTTP client, and persists
 * the observation after every completed source. It reuses the planner, the observation store and
 * the promotion rule; it does not add a second planner and it makes no AI call.
 *
 * Per-host pacing, response caching, retries, the circuit breaker and `Retry-After` handling
 * all live inside the injected client (`SafeHttpClient`); this module adds the run-level bounds
 * and folds a host's `Retry-After` into the source's persisted `nextDueAt`.
 */

export type AtsSourceScoutLimits = {
  /** Most sources one run may plan. */
  maxSources: number;
  /** Most HTTP requests one run may issue, retries inside the client excluded. */
  maxRequests: number;
  /** Sources read in parallel. */
  concurrency: number;
  /** Wall-clock ceiling for one run; checked before every source and every request. */
  maxDurationMs: number;
};

export const DEFAULT_ATS_SOURCE_SCOUT_LIMITS: AtsSourceScoutLimits = {
  maxSources: 40,
  maxRequests: 120,
  concurrency: 3,
  maxDurationMs: 5 * 60 * 1_000,
};

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function resolveAtsSourceScoutLimits(
  input: Partial<AtsSourceScoutLimits> = {},
): AtsSourceScoutLimits {
  const defaults = DEFAULT_ATS_SOURCE_SCOUT_LIMITS;
  return {
    maxSources: clampInt(input.maxSources, defaults.maxSources, 1, 500),
    maxRequests: clampInt(input.maxRequests, defaults.maxRequests, 1, 2_000),
    concurrency: clampInt(input.concurrency, defaults.concurrency, 1, 8),
    maxDurationMs: clampInt(input.maxDurationMs, defaults.maxDurationMs, 1_000, 30 * 60 * 1_000),
  };
}

/** A fixed share of every run, never zero, for unseen or stale sources. */
export function scoutExplorationQuota(maxSources: number): number {
  if (maxSources <= 1) return 1;
  return Math.min(maxSources - 1, Math.max(1, Math.ceil(maxSources / 4)));
}

export type AtsSourceScoutCounters = {
  attempted: number;
  refreshed: number;
  explored: number;
  newlyVerified: number;
  empty: number;
  skipped: number;
  blocked: number;
  failed: number;
};

export function emptyAtsSourceScoutCounters(): AtsSourceScoutCounters {
  return {
    attempted: 0,
    refreshed: 0,
    explored: 0,
    newlyVerified: 0,
    empty: 0,
    skipped: 0,
    blocked: 0,
    failed: 0,
  };
}

export type AtsSourceScoutStopReason =
  | 'finished'
  | 'duration'
  | 'requests'
  | 'cancelled'
  | 'nothing_due';

export type AtsSourceScoutResult = {
  counters: AtsSourceScoutCounters;
  stoppedBecause: AtsSourceScoutStopReason;
  requestsUsed: number;
  totalRosterSize: number;
  /** Roster sources left alone because their `nextDueAt` is still in the future. */
  skippedNotDue: number;
  checkpoint: number;
  failuresByCategory: Partial<Record<AtsSourceFailureCategory, number>>;
  /** Roster sources still due after this run (unseen, stale, or past `nextDueAt`). */
  dueRemaining: number;
  /** Earliest future `nextDueAt` among observed sources, or null when none is scheduled. */
  earliestNextDueAt: string | null;
};

export type AtsSourceScoutOptions = {
  http: AtsHttpClient;
  roster: readonly AtsRosterEntry[];
  projectRoot: string;
  /** Required. A blank role never reaches the network. */
  roleQuery: string;
  country?: string;
  limits?: Partial<AtsSourceScoutLimits>;
  now?: () => Date;
  signal?: AbortSignal;
};

class ScoutStop extends Error {
  public constructor(public readonly reason: Exclude<AtsSourceScoutStopReason, 'finished' | 'nothing_due'>) {
    super(`source scout stopped: ${reason}`);
    this.name = 'ScoutStop';
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
    lifecycleAuthoritative: false,
  };
}

function summarizeSchedule(
  roster: readonly AtsRosterEntry[],
  state: AtsSourceObservationFile,
  now: Date,
): { dueRemaining: number; earliestNextDueAt: string | null } {
  const byKey = new Map(state.observations.map((item) => [atsSourceKey(item), item]));
  const seen = new Set<string>();
  let dueRemaining = 0;
  let earliest: number | null = null;
  for (const entry of roster) {
    const key = atsSourceKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    const observation = byKey.get(key);
    const dueAt = observation === undefined ? null : Date.parse(observation.nextDueAt);
    if (dueAt === null || dueAt <= now.valueOf()) {
      dueRemaining += 1;
    } else if (earliest === null || dueAt < earliest) {
      earliest = dueAt;
    }
  }
  return {
    dueRemaining,
    earliestNextDueAt: earliest === null ? null : new Date(earliest).toISOString(),
  };
}

export async function runAtsSourceScout(options: AtsSourceScoutOptions): Promise<AtsSourceScoutResult> {
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().valueOf();
  const limits = resolveAtsSourceScoutLimits(options.limits);
  const roleQuery = options.roleQuery.trim();
  if (roleQuery.length === 0) throw new Error('source scout needs a role or keyword');

  let state = await loadAtsSourceObservations(options.projectRoot);
  const plan = planAtsRosterScan(options.roster, state, {
    roleQuery,
    country: options.country ?? '',
    maxSources: limits.maxSources,
    explorationBudget: scoutExplorationQuota(limits.maxSources),
    now: clock(),
  });
  state = plan.nextState;

  // Writes are chained so the file always holds a complete, newer snapshot than the last one.
  let writeChain: Promise<unknown> = Promise.resolve();
  let writeError: unknown;
  const persist = (): void => {
    const snapshot = state;
    writeChain = writeChain
      .then(() => writeAtsSourceObservations(options.projectRoot, snapshot))
      .catch((error: unknown) => {
        writeError ??= error;
      });
  };
  // Reserve the cursor before any request: a crash can skip a reserved tenant until the next
  // cycle but can never replay the same batch forever.
  persist();

  const counters = emptyAtsSourceScoutCounters();
  const failuresByCategory: Partial<Record<AtsSourceFailureCategory, number>> = {};
  let requestsUsed = 0;
  let stop: ScoutStop | null = null;

  const checkBounds = (): void => {
    if (stop !== null) throw stop;
    if (options.signal?.aborted === true) throw (stop = new ScoutStop('cancelled'));
    if (clock().valueOf() - startedAt >= limits.maxDurationMs) throw (stop = new ScoutStop('duration'));
  };
  const spendRequest = (): void => {
    checkBounds();
    if (requestsUsed >= limits.maxRequests) throw (stop = new ScoutStop('requests'));
    requestsUsed += 1;
  };
  const budgeted: AtsHttpClient = {
    get(url, requestOptions) {
      try {
        spendRequest();
      } catch (error) {
        return Promise.reject(error);
      }
      return options.http.get(url, requestOptions);
    },
    postJson(url, body, requestOptions) {
      try {
        spendRequest();
      } catch (error) {
        return Promise.reject(error);
      }
      return options.http.postJson(url, body, requestOptions);
    },
  };
  const adapters = new Map<AtsRosterProvider, NonNullable<ReturnType<typeof createVacancyAdapter>>>();
  const adapterFor = (provider: AtsRosterProvider) => {
    let adapter = adapters.get(provider);
    if (adapter === undefined) {
      const created = createVacancyAdapter(provider, budgeted);
      if (created === null) throw new Error(`No adapter registered for ATS roster provider ${provider}`);
      adapter = created;
      adapters.set(provider, adapter);
    }
    return adapter;
  };

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      try {
        checkBounds();
      } catch {
        return;
      }
      const index = next;
      next += 1;
      const planned = plan.entries[index];
      if (planned === undefined) return;
      const { entry, reason } = planned;
      // Exploration is anything the planner picked for coverage, plus any source never observed
      // before. Refresh is a source that already has an observation and came due again.
      const explored =
        reason === 'exploration' ||
        !state.observations.some((item) => atsSourceKey(item) === atsSourceKey(entry));
      try {
        const result = await adapterFor(entry.provider).listVacancies(descriptorFor(entry));
        const previous = state.observations.find((item) => atsSourceKey(item) === atsSourceKey(entry));
        const stable =
          result.vacancies.length > 0 && result.vacancies.every(hasStableVacancyIdentity);
        const status = result.vacancies.length === 0 ? 'empty' : stable ? 'verified' : 'error';
        state = recordAtsSourceObservation(state, {
          entry,
          status,
          errorCategory: status === 'error' ? 'invalid_response' : null,
          vacancies: result.vacancies,
          attemptedAt: clock(),
          ...(status === 'error'
            ? { decisionReason: 'Adapter returned vacancies without stable HTTPS identity.' }
            : {}),
        });
        counters.attempted += 1;
        if (explored) counters.explored += 1;
        else counters.refreshed += 1;
        if (status === 'verified') {
          if (previous?.status !== 'verified') counters.newlyVerified += 1;
        } else if (status === 'empty') {
          counters.empty += 1;
        } else {
          counters.failed += 1;
          failuresByCategory.invalid_response = (failuresByCategory.invalid_response ?? 0) + 1;
        }
      } catch (error) {
        // A bound hit mid-source (even if an adapter wrapped the error) leaves that source
        // unrecorded, so it stays due for the next run instead of being penalized.
        if (error instanceof ScoutStop || stop !== null) return;
        // One source failing is recorded and never aborts the batch.
        const category = classifyAtsSourceFailure(error);
        const blocked = category === 'authentication' || category === 'blocked';
        const retryAfterMs = retryAfterMsFromError(error);
        state = recordAtsSourceObservation(state, {
          entry,
          status: blocked ? 'blocked' : 'error',
          errorCategory: category,
          vacancies: [],
          attemptedAt: clock(),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
        counters.attempted += 1;
        if (explored) counters.explored += 1;
        else counters.refreshed += 1;
        if (blocked) counters.blocked += 1;
        else counters.failed += 1;
        failuresByCategory[category] = (failuresByCategory[category] ?? 0) + 1;
      }
      persist();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limits.concurrency, Math.max(1, plan.entries.length)) }, worker));
  await writeChain;
  if (writeError !== undefined) throw writeError;

  counters.skipped = Math.max(0, plan.entries.length - counters.attempted);
  const schedule = summarizeSchedule(options.roster, state, clock());
  const stoppedBecause: AtsSourceScoutStopReason =
    stop !== null ? (stop as ScoutStop).reason : plan.entries.length === 0 ? 'nothing_due' : 'finished';
  return {
    counters,
    stoppedBecause,
    requestsUsed,
    totalRosterSize: plan.totalRosterSize,
    skippedNotDue: plan.skippedNotDue,
    checkpoint: plan.checkpoint,
    failuresByCategory,
    dueRemaining: schedule.dueRemaining,
    earliestNextDueAt: schedule.earliestNextDueAt,
  };
}
