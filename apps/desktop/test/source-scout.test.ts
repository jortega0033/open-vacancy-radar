// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { AtsSourceScoutResult, ScanLock } from '@open-vacancy-radar/vacancy-engine';
import { createScanGuard } from '../electron/scan-guard.js';
import {
  SCOUT_BASE_INTERVAL_MS,
  SCOUT_BUSY_RETRY_MS,
  SCOUT_MAX_BACKOFF_MS,
  createSourceScout,
  defaultSourceScoutState,
  isScoutRunDue,
  scoutFailureBackoffMs,
  sourceScoutLimitsFromEnv,
  type SourceScoutDeps,
  type SourceScoutStateStore,
} from '../electron/source-scout.js';
import type { SourceScoutState } from '../electron/source-scout-types.js';

const HOUR = 60 * 60 * 1000;

function memoryStore(initial: SourceScoutState = defaultSourceScoutState()) {
  let state = initial;
  const store: SourceScoutStateStore & { saves: number; current: () => SourceScoutState } = {
    saves: 0,
    current: () => state,
    async load() {
      return state;
    },
    async save(next) {
      store.saves += 1;
      state = next;
    },
  };
  return store;
}

function clock(startIso = '2026-10-05T10:00:00.000Z') {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function scoutResult(overrides: Partial<AtsSourceScoutResult> = {}): AtsSourceScoutResult {
  return {
    counters: { attempted: 10, refreshed: 6, explored: 4, newlyVerified: 2, empty: 3, skipped: 0, blocked: 1, failed: 1 },
    stoppedBecause: 'finished',
    requestsUsed: 10,
    totalRosterSize: 15_000,
    skippedNotDue: 400,
    checkpoint: 40,
    failuresByCategory: {},
    dueRemaining: 12_000,
    earliestNextDueAt: null,
    ...overrides,
  };
}

const grantingLock: ScanLock = { tryAcquire: () => () => {} };
const heldLock: ScanLock = { tryAcquire: () => null };

function setup(overrides: Partial<SourceScoutDeps> = {}, initial?: SourceScoutState) {
  const time = clock();
  const store = memoryStore(initial);
  const runScout = vi.fn(async (_query: string) => scoutResult());
  const loadQuery = vi.fn(async (): Promise<string | null> => 'frontend developer');
  const guard = createScanGuard(() => grantingLock);
  const deps: SourceScoutDeps = {
    isEnabled: () => true,
    loadQuery,
    runExclusiveScan: guard.runExclusiveScan,
    runScout,
    store,
    now: time.now,
    log: () => {},
    ...overrides,
  };
  return { scout: createSourceScout(deps), store, runScout, loadQuery, time, guard };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('source scout schedule decisions', () => {
  it('is due when never scheduled or once nextRunAt has passed, never before', () => {
    const now = new Date('2026-10-05T10:00:00.000Z');
    expect(isScoutRunDue(null, now)).toBe(true);
    expect(isScoutRunDue('2026-10-05T10:00:00.000Z', now)).toBe(true);
    expect(isScoutRunDue('2026-10-05T10:00:01.000Z', now)).toBe(false);
    expect(isScoutRunDue('garbage', now)).toBe(true);
  });

  it('doubles the wait after each failed run and caps it', () => {
    expect([1, 2, 3, 4].map(scoutFailureBackoffMs)).toEqual([3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR]);
    expect(scoutFailureBackoffMs(30)).toBe(SCOUT_MAX_BACKOFF_MS);
  });

  it('reads configurable bounds from the environment and ignores junk', () => {
    expect(
      sourceScoutLimitsFromEnv({
        OVR_SCOUT_MAX_SOURCES: '25',
        OVR_SCOUT_MAX_REQUESTS: '80',
        OVR_SCOUT_CONCURRENCY: '2',
        OVR_SCOUT_MAX_SECONDS: '90',
      }),
    ).toEqual({ maxSources: 25, maxRequests: 80, concurrency: 2, maxDurationMs: 90_000 });
    expect(sourceScoutLimitsFromEnv({ OVR_SCOUT_MAX_SOURCES: 'many', OVR_SCOUT_CONCURRENCY: '-1' })).toEqual({});
  });
});

describe('source scout orchestrator', () => {
  it('does nothing and touches no network while disabled', async () => {
    const { scout, runScout, loadQuery, store } = setup({ isEnabled: () => false });
    expect(await scout.tick()).toBe('disabled');
    expect(scout.runNow()).toEqual({ started: false, reason: 'disabled' });
    expect(runScout).not.toHaveBeenCalled();
    expect(loadQuery).not.toHaveBeenCalled();
    expect(store.saves).toBe(0);
  });

  it('skips without network work when no role or keyword is saved, and records why once', async () => {
    const { scout, runScout, store, time } = setup({ loadQuery: async () => null });
    expect(await scout.tick()).toBe('ran');
    time.advance(HOUR);
    await scout.tick();
    expect(runScout).not.toHaveBeenCalled();
    expect(store.current().lastOutcome?.kind).toBe('no_profile');
    expect(store.saves).toBe(1);
    expect(await scout.getStatus()).toMatchObject({ hasProfile: false, enabled: true });
  });

  it('enters the scan guard with the advisory lock, exactly like a manual scan', async () => {
    const lock = { acquisitions: 0, tryAcquire: () => { lock.acquisitions += 1; return () => {}; } };
    const guard = createScanGuard(() => lock);
    const spy = vi.fn(guard.runExclusiveScan);
    const { scout, runScout } = setup({ runExclusiveScan: spy as SourceScoutDeps['runExclusiveScan'] });
    await scout.tick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toEqual({ takeAdvisoryLock: true });
    expect(runScout).toHaveBeenCalledWith('frontend developer');
    void guard;
  });

  it('skips cleanly and retries soon when another process owns the scan lock', async () => {
    const guard = createScanGuard(() => heldLock);
    const { scout, runScout, store, time } = setup({ runExclusiveScan: guard.runExclusiveScan });
    expect(await scout.tick()).toBe('ran');
    expect(runScout).not.toHaveBeenCalled();
    expect(store.current().lastOutcome?.kind).toBe('busy');
    expect(store.current().lastRunAt).toBeNull();
    expect(store.current().consecutiveFailedRuns).toBe(0);
    expect(Date.parse(store.current().nextRunAt!) - time.now().valueOf()).toBe(SCOUT_BUSY_RETRY_MS);
  });

  it('skips cleanly when a manual or scheduled vacancy scan in this process holds the guard', async () => {
    const { scout, runScout, store, guard } = setup();
    const vacancyScan = deferred<void>();
    const running = guard.runExclusiveScan(() => vacancyScan.promise, { takeAdvisoryLock: true });
    expect(await scout.tick()).toBe('ran');
    expect(runScout).not.toHaveBeenCalled();
    expect(store.current().lastOutcome?.kind).toBe('busy');
    vacancyScan.resolve();
    await running;
    // The guard is free again, so a later due tick runs.
    store.current().nextRunAt = null;
    await scout.tick();
    expect(runScout).toHaveBeenCalledTimes(1);
  });

  it('never lets two runs overlap inside one process', async () => {
    const gate = deferred<AtsSourceScoutResult>();
    const { scout, runScout } = setup({ runScout: vi.fn(() => gate.promise) });
    const first = scout.tick();
    expect(scout.running).toBe(true);
    expect(await scout.tick()).toBe('overlap');
    expect(scout.runNow()).toEqual({ started: false, reason: 'running' });
    gate.resolve(scoutResult());
    expect(await first).toBe('ran');
    expect(runScout).not.toBe(undefined);
    expect(scout.running).toBe(false);
  });

  it('keeps the schedule across a restart and does not rerun early', async () => {
    const first = setup();
    await first.scout.tick();
    expect(first.runScout).toHaveBeenCalledTimes(1);
    // A new orchestrator over the same stored state stands in for a restarted app.
    const restarted = setup({}, first.store.current());
    restarted.time.advance(0);
    expect(await restarted.scout.tick()).toBe('not_due');
    expect(restarted.runScout).not.toHaveBeenCalled();
    const status = await restarted.scout.getStatus();
    expect(status.lastRunAt).toBe(first.store.current().lastRunAt);
    expect(status.lastOutcome?.kind).toBe('completed');
  });

  it('runs at most one scout after a long sleep and does not replay missed intervals', async () => {
    const { scout, runScout, store, time } = setup(
      {},
      { ...defaultSourceScoutState(), nextRunAt: '2026-10-02T10:00:00.000Z', lastRunAt: '2026-10-02T07:00:00.000Z' },
    );
    time.advance(3 * 24 * HOUR);
    const results = [];
    for (let index = 0; index < 6; index += 1) results.push(await scout.tick());
    expect(runScout).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result === 'ran')).toHaveLength(1);
    expect(Date.parse(store.current().nextRunAt!) - time.now().valueOf()).toBe(SCOUT_BASE_INTERVAL_MS);
  });

  it('backs off more after repeated failures and resets after a good run', async () => {
    let fail = true;
    const runScout = vi.fn(async () => {
      if (fail) throw new Error('network is down');
      return scoutResult();
    });
    const { scout, store, time } = setup({ runScout });
    const waits: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      await scout.tick();
      const wait = Date.parse(store.current().nextRunAt!) - time.now().valueOf();
      waits.push(wait);
      time.advance(wait);
    }
    expect(waits).toEqual([3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR]);
    expect(store.current().lastOutcome).toMatchObject({ kind: 'failed', message: 'network is down' });
    fail = false;
    await scout.tick();
    expect(store.current().consecutiveFailedRuns).toBe(0);
    expect(Date.parse(store.current().nextRunAt!) - time.now().valueOf()).toBe(SCOUT_BASE_INTERVAL_MS);
  });

  it('treats a run where every source failed as a failed run for backoff', async () => {
    const allFailed = scoutResult({
      counters: { attempted: 5, refreshed: 0, explored: 5, newlyVerified: 0, empty: 0, skipped: 0, blocked: 2, failed: 3 },
    });
    const { scout, store, time } = setup({ runScout: vi.fn(async () => allFailed) });
    await scout.tick();
    expect(store.current().consecutiveFailedRuns).toBe(1);
    time.advance(3 * HOUR);
    await scout.tick();
    expect(Date.parse(store.current().nextRunAt!) - time.now().valueOf()).toBe(6 * HOUR);
  });

  it('records the real counters and a limit outcome when a bound stopped the run', async () => {
    const limited = scoutResult({ stoppedBecause: 'duration', requestsUsed: 77 });
    const { scout, store } = setup({ runScout: vi.fn(async () => limited) });
    await scout.tick();
    expect(store.current().lastOutcome).toMatchObject({
      kind: 'limit_reached',
      stoppedBecause: 'duration',
      requestsUsed: 77,
      counters: { attempted: 10, refreshed: 6, explored: 4, newlyVerified: 2, empty: 3, skipped: 0, blocked: 1, failed: 1 },
    });
  });

  it('waits until the earliest due time when nothing is due', async () => {
    const idle = scoutResult({
      stoppedBecause: 'nothing_due',
      dueRemaining: 0,
      earliestNextDueAt: '2026-10-07T10:00:00.000Z',
      counters: { attempted: 0, refreshed: 0, explored: 0, newlyVerified: 0, empty: 0, skipped: 0, blocked: 0, failed: 0 },
    });
    const { scout, store } = setup({ runScout: vi.fn(async () => idle) });
    await scout.tick();
    expect(store.current().lastOutcome?.kind).toBe('nothing_due');
    expect(store.current().nextRunAt).toBe('2026-10-07T10:00:00.000Z');
  });

  it('honors Pause for scheduled ticks and lets Run now still start a run', async () => {
    const { scout, runScout, store } = setup();
    const status = await scout.setPaused(true);
    expect(status.paused).toBe(true);
    expect(await scout.tick()).toBe('paused');
    expect(runScout).not.toHaveBeenCalled();
    const started = scout.runNow();
    expect(started.started).toBe(true);
    if (started.started) await started.done;
    expect(runScout).toHaveBeenCalledTimes(1);
    expect(store.current().paused).toBe(true);
    expect((await scout.setPaused(false)).paused).toBe(false);
  });
});
