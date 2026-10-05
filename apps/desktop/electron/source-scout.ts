import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AtsSourceScoutLimits, AtsSourceScoutResult } from '@open-vacancy-radar/vacancy-engine';

import { isExpectedScanBusyError, type ScanGuard } from './scan-guard.js';
import type {
  SourceScoutOutcome,
  SourceScoutRunRefusal,
  SourceScoutState,
  SourceScoutStatus,
} from './source-scout-types.js';

/**
 * Background ATS source scouting for the desktop lifecycle (#348). Runs only while OVR is open or
 * minimized to the tray; nothing here is an operating-system service.
 *
 * The main process owns one cheap periodic tick. A tick re-derives "is a run due" from a durable
 * `nextRunAt` timestamp instead of counting intervals, so a laptop waking from sleep runs at most
 * one scout and never replays the intervals it missed. Which sources to read, and in what order,
 * is the #341 planner's job (inside `runScout`); this module decides only *when* to run and what
 * to record afterward.
 */

/** Wait between runs while work remains. */
export const SCOUT_BASE_INTERVAL_MS = 3 * 60 * 60 * 1000;
/** Longest wait after repeated failed runs. */
export const SCOUT_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
/** Retry delay when a vacancy scan, or another process, held the scan lock. */
export const SCOUT_BUSY_RETRY_MS = 10 * 60 * 1000;
/** When nothing is due, never wake sooner than this. */
export const SCOUT_MIN_IDLE_WAIT_MS = 60 * 60 * 1000;

export function defaultSourceScoutState(): SourceScoutState {
  return { version: 1, paused: false, lastRunAt: null, nextRunAt: null, consecutiveFailedRuns: 0, lastOutcome: null };
}

/** True when a scheduled tick may run: never before `nextRunAt`, always once it has passed. */
export function isScoutRunDue(nextRunAt: string | null, now: Date): boolean {
  if (nextRunAt === null) return true;
  const due = Date.parse(nextRunAt);
  return Number.isNaN(due) || now.getTime() >= due;
}

/** Repeated failed runs wait twice as long each time, up to a day. */
export function scoutFailureBackoffMs(consecutiveFailedRuns: number): number {
  const exponent = Math.min(Math.max(consecutiveFailedRuns, 1) - 1, 10);
  return Math.min(SCOUT_MAX_BACKOFF_MS, SCOUT_BASE_INTERVAL_MS * 2 ** exponent);
}

/** A run that read sources but got nothing except failures counts as a failed run. */
function allAttemptsFailed(result: AtsSourceScoutResult): boolean {
  const { attempted, failed, blocked } = result.counters;
  return attempted > 0 && failed + blocked === attempted;
}

export function scoutNextRunDelayMs(result: AtsSourceScoutResult, now: Date, consecutiveFailedRuns: number): number {
  if (allAttemptsFailed(result)) return scoutFailureBackoffMs(consecutiveFailedRuns);
  if (result.dueRemaining === 0 && result.earliestNextDueAt !== null) {
    const untilDue = Date.parse(result.earliestNextDueAt) - now.getTime();
    return Math.min(SCOUT_MAX_BACKOFF_MS, Math.max(SCOUT_MIN_IDLE_WAIT_MS, untilDue));
  }
  return SCOUT_BASE_INTERVAL_MS;
}

export function sourceScoutLimitsFromEnv(env: Record<string, string | undefined>): Partial<AtsSourceScoutLimits> {
  const read = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const limits: Partial<AtsSourceScoutLimits> = {};
  const maxSources = read('OVR_SCOUT_MAX_SOURCES');
  const maxRequests = read('OVR_SCOUT_MAX_REQUESTS');
  const concurrency = read('OVR_SCOUT_CONCURRENCY');
  const maxDurationSeconds = read('OVR_SCOUT_MAX_SECONDS');
  if (maxSources !== undefined) limits.maxSources = maxSources;
  if (maxRequests !== undefined) limits.maxRequests = maxRequests;
  if (concurrency !== undefined) limits.concurrency = concurrency;
  if (maxDurationSeconds !== undefined) limits.maxDurationMs = maxDurationSeconds * 1000;
  return limits;
}

export interface SourceScoutStateStore {
  load(): Promise<SourceScoutState>;
  save(state: SourceScoutState): Promise<void>;
}

const STATE_FILE_RELATIVE_PATH = path.join('.data', 'source-scout-state-v1.json');

/** File-backed store next to the source observation file. A missing or unreadable file reads as a fresh state. */
export function createSourceScoutStateStore(dataRoot: () => Promise<string>): SourceScoutStateStore {
  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(path.resolve(await dataRoot(), STATE_FILE_RELATIVE_PATH), 'utf8')) as Partial<SourceScoutState>;
        if (raw.version !== 1) return defaultSourceScoutState();
        return { ...defaultSourceScoutState(), ...raw, version: 1 };
      } catch {
        return defaultSourceScoutState();
      }
    },
    async save(state) {
      const file = path.resolve(await dataRoot(), STATE_FILE_RELATIVE_PATH);
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(temporary, file);
    },
  };
}

export interface SourceScoutDeps {
  isEnabled: () => boolean;
  /** The saved role or keyword, or null when none exists. Called before any network work. */
  loadQuery: () => Promise<string | null>;
  /** `ScanGuard.runExclusiveScan`, the same guard a manual scan uses. */
  runExclusiveScan: ScanGuard['runExclusiveScan'];
  /** One bounded scout run for `query`. */
  runScout: (query: string) => Promise<AtsSourceScoutResult>;
  store: SourceScoutStateStore;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

export type SourceScoutTickResult = 'disabled' | 'paused' | 'overlap' | 'not_due' | 'ran';

export interface SourceScout {
  /** One cheap periodic wake-up. Never rejects. */
  tick(): Promise<SourceScoutTickResult>;
  /** Starts a run now. `done` settles when it ends. Refuses instead of queueing. */
  runNow(): { started: true; done: Promise<void> } | { started: false; reason: SourceScoutRunRefusal };
  setPaused(paused: boolean): Promise<SourceScoutStatus>;
  getStatus(): Promise<SourceScoutStatus>;
  readonly running: boolean;
}

function failureMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export function createSourceScout(deps: SourceScoutDeps): SourceScout {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  // Set synchronously before the first await, so two ticks (or a tick and Run now) landing in the
  // same process can never both start a run.
  let running = false;

  async function record(update: (state: SourceScoutState) => SourceScoutState): Promise<SourceScoutState> {
    const next = update(await deps.store.load());
    await deps.store.save(next);
    return next;
  }

  function skipOutcome(kind: 'no_profile' | 'busy' | 'no_roster', at: Date): SourceScoutOutcome {
    return { kind, at: at.toISOString() };
  }

  async function execute(): Promise<void> {
    try {
      const query = await deps.loadQuery();
      if (query === null) {
        // No saved role or keyword: record why, do no network work, and keep the schedule as it was.
        // Written once, not on every 5-minute tick.
        const current = await deps.store.load();
        if (current.lastOutcome?.kind !== 'no_profile') {
          await deps.store.save({ ...current, lastOutcome: skipOutcome('no_profile', now()) });
        }
        return;
      }
      let result: AtsSourceScoutResult;
      try {
        result = await deps.runExclusiveScan(() => deps.runScout(query), { takeAdvisoryLock: true });
      } catch (error) {
        const ended = now();
        if (isExpectedScanBusyError(error)) {
          await record((state) => ({
            ...state,
            nextRunAt: new Date(ended.getTime() + SCOUT_BUSY_RETRY_MS).toISOString(),
            lastOutcome: skipOutcome('busy', ended),
          }));
          return;
        }
        log('[source-scout] run failed', error);
        await record((state) => {
          const failedRuns = state.consecutiveFailedRuns + 1;
          return {
            ...state,
            lastRunAt: ended.toISOString(),
            consecutiveFailedRuns: failedRuns,
            nextRunAt: new Date(ended.getTime() + scoutFailureBackoffMs(failedRuns)).toISOString(),
            lastOutcome: { kind: 'failed', at: ended.toISOString(), message: failureMessage(error) },
          };
        });
        return;
      }
      const ended = now();
      await record((state) => {
        const failedRuns = allAttemptsFailed(result) ? state.consecutiveFailedRuns + 1 : 0;
        const kind: SourceScoutOutcome['kind'] =
          result.totalRosterSize === 0
            ? 'no_roster'
            : result.stoppedBecause === 'nothing_due'
              ? 'nothing_due'
              : result.stoppedBecause === 'finished'
                ? 'completed'
                : 'limit_reached';
        return {
          ...state,
          lastRunAt: ended.toISOString(),
          consecutiveFailedRuns: failedRuns,
          nextRunAt: new Date(ended.getTime() + scoutNextRunDelayMs(result, ended, failedRuns)).toISOString(),
          lastOutcome: {
            kind,
            at: ended.toISOString(),
            counters: result.counters,
            stoppedBecause: result.stoppedBecause,
            skippedNotDue: result.skippedNotDue,
            requestsUsed: result.requestsUsed,
          },
        };
      });
    } catch (error) {
      // Persisting state failed; nothing more can be recorded, and the next tick starts clean.
      log('[source-scout] could not record the run', error);
    } finally {
      running = false;
    }
  }

  function start(): Promise<void> {
    running = true;
    return execute();
  }

  async function tick(): Promise<SourceScoutTickResult> {
    if (!deps.isEnabled()) return 'disabled';
    if (running) return 'overlap';
    // Claim the slot before awaiting the stored schedule so a second tick cannot slip in.
    running = true;
    let shouldRun = false;
    try {
      const state = await deps.store.load();
      if (state.paused) return 'paused';
      shouldRun = isScoutRunDue(state.nextRunAt, now());
    } catch (error) {
      log('[source-scout] could not read schedule', error);
    } finally {
      if (!shouldRun) running = false;
    }
    if (!shouldRun) return 'not_due';
    await execute();
    return 'ran';
  }

  function runNow(): ReturnType<SourceScout['runNow']> {
    if (!deps.isEnabled()) return { started: false, reason: 'disabled' };
    if (running) return { started: false, reason: 'running' };
    return { started: true, done: start() };
  }

  async function getStatus(): Promise<SourceScoutStatus> {
    const [state, query] = await Promise.all([deps.store.load(), deps.loadQuery().catch(() => null)]);
    return {
      enabled: deps.isEnabled(),
      paused: state.paused,
      running,
      hasProfile: query !== null,
      lastRunAt: state.lastRunAt,
      nextRunAt: state.nextRunAt,
      lastOutcome: state.lastOutcome,
    };
  }

  async function setPaused(paused: boolean): Promise<SourceScoutStatus> {
    await record((state) => ({ ...state, paused }));
    return getStatus();
  }

  return {
    tick,
    runNow,
    setPaused,
    getStatus,
    get running() {
      return running;
    },
  };
}
