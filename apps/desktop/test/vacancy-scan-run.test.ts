import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentEventEnvelope } from '@agent-dock/shared';
import {
  EMPTY_CANDIDATE_PROFILE,
  SCAN_PROGRESS_SOURCE_IDS,
  ScanCancelledError,
  awaitAiWebDiscoveryJoin,
  isScanCancelledError,
  type CandidateProfile,
  type DiscoverySourceAudit,
  type DiscoveryVacancyAudit,
  type GlobalRemoteReport,
  type GlobalRemoteScanOptions,
  type GlobalRemoteScanResult,
} from '@open-vacancy-radar/vacancy-engine';
import { uniqueDiscovery } from '../../../packages/vacancy-engine/src/pipeline/global-remote.js';
import { createScanGuard, isExpectedScanBusyError, SCAN_BUSY_IN_PROCESS } from '../electron/scan-guard.js';
import type { VacancyScanProgressEvent } from '../electron/vacancy-scan-progress-types.js';
import { parseVacancyScanRequest } from '../electron/vacancy-scan-query.js';
import { createVacancyScanRunner } from '../electron/vacancy-scan-run.js';
import { runAiWebDiscovery } from '../electron/vacancy-web-discovery.js';
import { describeScanProgress } from '../src/components/search/scan-progress.js';

// ---------------------------------------------------------------------------------------------
// #685: one scan run with the optional AI web search running alongside the job-site sources.
//
// What is real here: the run lifecycle (`createVacancyScanRunner`, the code main.ts delegates to),
// the in-process scan guard, the branch orchestration, `runAiWebDiscovery` (session request,
// timeout, cancel, validation and normalisation) and the engine's own `awaitAiWebDiscoveryJoin` and
// `uniqueDiscovery`. What is fake: the daemon client (a controllable session) and the engine body,
// a synthetic stand-in that runs the 13 progress groups as controllable promises in the same stage
// order as `runGlobalRemoteScan` (groups -> stop check -> AI join -> merge -> stop check -> persist).
// Everything is synthetic; no provider, job site or network is touched.
// ---------------------------------------------------------------------------------------------

const PROFILE: CandidateProfile = {
  ...EMPTY_CANDIDATE_PROFILE,
  profileVersion: 'test',
  targetRoles: ['Frontend Engineer'],
  strongestSkills: ['TypeScript'],
  constraints: { ...EMPTY_CANDIDATE_PROFILE.constraints, primaryCountry: 'Netherlands' },
};

const SHARED_URL = 'https://acme.example/careers/ui-engineer-1';
const AI_ONLY_URL = 'https://beta.example/jobs/frontend-2';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function row(provider: DiscoveryVacancyAudit['provider'], key: string, url: string, title: string): DiscoveryVacancyAudit {
  return {
    key,
    provider,
    company: 'Acme Corp',
    title,
    url,
    location: 'Worldwide',
    employmentType: null,
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    annualizedMinimumUsd: null,
    decision: 'salary_unverified',
    reasons: ['Salary is not stated.'],
    contentHash: key.padEnd(64, '0').slice(0, 64),
    description: null,
    postedAt: null,
    profileScore: null,
    worldwideSponsorMatch: null,
  };
}

function sourceAudit(id: string, listings: number): DiscoverySourceAudit {
  return {
    id,
    provider: 'himalayas',
    url: `https://source.example/${id}`,
    requests: 1,
    listings,
    status: 'success',
    networkAttempts: 1,
    retries: 0,
    complete: true,
    completenessReason: null,
    continuationCursor: null,
  } as DiscoverySourceAudit;
}

/** The synthetic engine: same stage order as `runGlobalRemoteScan`, controllable per progress group. */
function syntheticEngine() {
  const groups = new Map(SCAN_PROGRESS_SOURCE_IDS.map((id) => [id as string, deferred<DiscoveryVacancyAudit[]>()]));
  const calls: GlobalRemoteScanOptions[] = [];
  const persisted: GlobalRemoteReport[] = [];
  async function run(options: GlobalRemoteScanOptions): Promise<GlobalRemoteScanResult> {
    calls.push(options);
    if (options.signal?.aborted) throw new ScanCancelledError();
    const found = await Promise.all(
      [...groups].map(async ([sourceId, group]) => {
        const vacancies = await group.promise;
        options.onProgress?.({ sourceId, vacancies });
        return { sourceId, vacancies };
      }),
    );
    if (options.signal?.aborted) throw new ScanCancelledError();
    const ai = await awaitAiWebDiscoveryJoin(options, options.signal);
    const report = {
      runId: `report-${calls.length}`,
      generatedAt: new Date().toISOString(),
      scanBounds: { complete: true },
      discoverySources: [
        ...found.map((source) => sourceAudit(source.sourceId, source.vacancies.length)),
        ...(ai?.sourceAudit ? [ai.sourceAudit] : []),
      ],
      discoveryAudit: uniqueDiscovery([...found.flatMap((source) => source.vacancies), ...(ai?.vacancies ?? [])]),
    } as unknown as GlobalRemoteReport;
    if (options.signal?.aborted) throw new ScanCancelledError();
    persisted.push(report);
    return { report, files: {} as GlobalRemoteScanResult['files'] };
  }
  return {
    run,
    calls,
    persisted,
    group: (id: string) => groups.get(id)!,
    /** Resolves every group not yet resolved: `himalayas` with the shared-URL row, the rest empty. */
    resolveAll() {
      for (const [id, group] of groups) {
        group.resolve(id === 'himalayas' ? [row('himalayas', 'himalayas:ui-1', SHARED_URL, 'UI Engineer')] : []);
      }
    },
  };
}

function fencedJson(payload: unknown): string {
  return '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
}

function aiCandidate(url: string, title: string): Record<string, unknown> {
  return {
    company: 'Acme Corp',
    title,
    url,
    location: 'Berlin, Germany',
    description: null,
    employmentType: null,
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    postedAt: null,
    evidence: {
      salary: { stated: false, quote: null },
      location: { stated: true, quote: 'Berlin, Germany' },
      employmentType: { stated: false, quote: null },
      postedAt: { stated: false, quote: null },
      visaSponsorship: 'unknown',
      exactUrlVerified: true,
    },
  };
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * A fake AgentDock daemon with one controllable AI session. By default its event stream ends with an
 * AbortError when the caller aborts it, like the real SSE client; `honorsStop: false` models a
 * stream that ignores the abort and only ends when the session itself does.
 */
function aiDaemon(options: { honorsStop?: boolean; sessionId?: string } = {}) {
  const sessionId = options.sessionId ?? 'ai-session-685';
  const finish = deferred<AgentEvent[]>();
  const create = vi.fn().mockResolvedValue({
    id: sessionId,
    provider: 'claude',
    cwd: '/tmp/ai-685',
    prompt: 'x',
    status: 'starting',
    startedAt: new Date().toISOString(),
  });
  const cancel = vi.fn().mockResolvedValue(undefined);
  const events = vi.fn(async function* (_id: string, init: { signal: AbortSignal }): AsyncGenerator<AgentEventEnvelope, void, void> {
    let ending: Promise<AgentEvent[]> = finish.promise;
    if (options.honorsStop !== false) {
      const stopped = new Promise<never>((_resolve, reject) => {
        if (init.signal.aborted) reject(abortError());
        init.signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
      ending = Promise.race([finish.promise, stopped]);
    }
    for (const event of await ending) {
      yield { ...event, sequence: 0, timestamp: new Date().toISOString() } as AgentEventEnvelope;
    }
  });
  const client = {
    providers: {
      list: vi.fn().mockResolvedValue([
        { id: 'claude', name: 'Claude Code', installed: true, authenticated: 'authenticated', capabilities: {} },
      ]),
    },
    sessions: { createVacancyWebDiscovery: create, events, cancel },
  };
  return {
    client,
    create,
    cancel,
    sessionId,
    complete(candidates: Record<string, unknown>[]) {
      finish.resolve([
        { type: 'assistant.message', text: fencedJson({ candidates, queriesUsed: ['synthetic query'] }) },
        { type: 'session.completed' },
      ] as AgentEvent[]);
    },
    fail(message: string) {
      finish.resolve([{ type: 'session.failed', message }] as AgentEvent[]);
    },
  };
}

type Engine = ReturnType<typeof syntheticEngine>;
type Daemon = ReturnType<typeof aiDaemon>;

/** The runner exactly as main.ts builds it, with each run's engine and daemon taken in order. */
function harness(runs: Array<{ engine: Engine; daemon?: Daemon }>, options: { graceMs?: number } = {}) {
  const guard = createScanGuard(() => undefined);
  const progress: VacancyScanProgressEvent[] = [];
  const adopted: GlobalRemoteReport[] = [];
  const completed: GlobalRemoteReport[] = [];
  const failed: string[] = [];
  const warnings: string[] = [];
  let runIndex = 0;
  let scanNumber = 0;
  const runner = createVacancyScanRunner({
    beforeScan: async () => {},
    runExclusiveScan: (run) => guard.runExclusiveScan(run, { takeAdvisoryLock: false }),
    loadSearchPlanSnapshot: async () => null,
    prepareRun: async () => {
      const current = runs[runIndex++]!;
      const daemon = current.daemon ?? aiDaemon();
      return {
        loadProfile: async () => PROFILE,
        ensureAiWorkspace: async () => '/tmp/ai-685',
        runAiWebDiscovery: (aiOptions) => runAiWebDiscovery(daemon.client as never, aiOptions),
        runGlobalRemoteScan: current.engine.run,
        logger: {
          warn: (_object, message) => warnings.push(message),
          info: () => undefined,
          debug: () => undefined,
        },
        browseAllResultCap: 5_000,
        aiStopGraceMs: options.graceMs ?? 50,
      };
    },
    newScanId: () => `scan-${++scanNumber}`,
    now: () => Date.now(),
    progressSourceTotal: SCAN_PROGRESS_SOURCE_IDS.length,
    sendProgress: (event) => progress.push(event),
    adoptReport: (report) => adopted.push(report),
    notifyCompleted: (report) => completed.push(report),
    notifyFailed: (detail) => failed.push(detail),
    isQuietError: (error) => isExpectedScanBusyError(error) || isScanCancelledError(error),
    throwCancelled: () => {
      throw new ScanCancelledError();
    },
  });
  return { runner, guard, progress, adopted, completed, failed, warnings };
}

const WITH_AI = parseVacancyScanRequest({ mode: 'query', query: 'UI engineer', aiWebDiscovery: true });
const WITHOUT_AI = parseVacancyScanRequest({ mode: 'query', query: 'UI engineer' });

/** Lets every already-settled promise chain run, without advancing any clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('one scan run with the AI web search alongside the job-site sources (#685)', () => {
  it('a pending AI step does not hold back job-site progress; its rows merge before the one report is saved', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const engine = syntheticEngine();
    const daemon = aiDaemon();
    const h = harness([{ engine, daemon }]);

    const running = h.runner.run(WITH_AI);
    await vi.waitFor(() => expect(daemon.create).toHaveBeenCalledTimes(1));
    // Both branches started: the AI session is open and the engine is already running its sources.
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]!.joinAiWebDiscovery).toBeTypeOf('function');
    expect(h.runner.status()).toMatchObject({ scanId: 'scan-1', aiWebSearch: 'running', sourcesDone: 0 });

    engine.resolveAll();
    await vi.waitFor(() => expect(h.progress).toHaveLength(SCAN_PROGRESS_SOURCE_IDS.length));
    // What the renderer received while the AI step was still running.
    expect(h.progress.every((event) => event.scanId === 'scan-1' && event.sourcesTotal === SCAN_PROGRESS_SOURCE_IDS.length)).toBe(true);
    expect(h.progress.map((event) => event.sourcesDone)).toEqual(SCAN_PROGRESS_SOURCE_IDS.map((_id, index) => index + 1));
    expect(h.progress.find((event) => event.sourceId === 'himalayas')!.vacancies[0]).toMatchObject({ url: SHARED_URL });
    const status = h.runner.status()!;
    expect(status).toMatchObject({ scanning: true, sourcesDone: 13, sourcesTotal: 13, vacanciesSoFar: 1, aiWebSearch: 'running' });
    expect(describeScanProgress(status, Date.now()).headline).toBe(
      'All 13 source groups checked. Waiting for the AI web search to finish…',
    );
    // Nothing is final yet.
    expect(engine.persisted).toHaveLength(0);
    expect(h.adopted).toHaveLength(0);
    expect(h.completed).toHaveLength(0);

    daemon.complete([aiCandidate(SHARED_URL, 'UI Engineer'), aiCandidate(AI_ONLY_URL, 'Frontend Developer')]);
    const report = await running;

    // The AI rows went through the same de-duplication: the shared URL is one row, the new one is added.
    expect(report.discoveryAudit).toHaveLength(2);
    expect(report.discoveryAudit.map((vacancy) => vacancy.url).sort()).toEqual([AI_ONLY_URL, SHARED_URL].sort());
    expect(report.discoveryAudit.find((vacancy) => vacancy.url === AI_ONLY_URL)).toMatchObject({ provider: 'ai_web_search' });
    expect(report.discoverySources.find((source) => source.id === 'ai_web_search')).toMatchObject({
      status: 'success',
      aiSearchIntent: { scanId: 'scan-1' },
    });
    // Exactly one of each, for the one report, and the run is over.
    expect(engine.calls).toHaveLength(1);
    expect(engine.persisted).toEqual([report]);
    expect(h.adopted).toEqual([report]);
    expect(h.completed).toEqual([report]);
    expect(h.failed).toEqual([]);
    expect(h.runner.status()).toBeUndefined();
    expect(h.guard.isScanInFlight()).toBe(false);
    expect(daemon.cancel).not.toHaveBeenCalled();
  });

  it('an AI failure is visible on its own source row and every job-site row is kept', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const engine = syntheticEngine();
    const daemon = aiDaemon();
    const h = harness([{ engine, daemon }]);

    const running = h.runner.run(WITH_AI);
    await vi.waitFor(() => expect(daemon.create).toHaveBeenCalledTimes(1));
    daemon.fail('synthetic provider failure');
    await vi.waitFor(() => expect(h.runner.status()?.aiWebSearch).toBe('failed'));
    // Job sites are still being checked after the AI step failed, and still report progress.
    engine.group('himalayas').resolve([row('himalayas', 'himalayas:ui-1', SHARED_URL, 'UI Engineer')]);
    await vi.waitFor(() => expect(h.progress).toHaveLength(1));
    engine.resolveAll();
    const report = await running;

    expect(report.discoveryAudit.map((vacancy) => vacancy.url)).toEqual([SHARED_URL]);
    expect(report.discoverySources.find((source) => source.id === 'ai_web_search')).toMatchObject({
      status: 'error',
      error: 'synthetic provider failure',
      complete: false,
    });
    expect(h.warnings).toContain('AI web discovery did not run to completion');
    expect(engine.persisted).toEqual([report]);
    expect(h.completed).toEqual([report]);
    expect(h.failed).toEqual([]);
  });

  it('an AI step that runs out of its 90 s budget is cancelled and reported, and the job-site rows are kept (fake clock)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const engine = syntheticEngine();
    const daemon = aiDaemon();
    const h = harness([{ engine, daemon }]);

    const running = h.runner.run(WITH_AI);
    await vi.advanceTimersByTimeAsync(0);
    expect(daemon.create).toHaveBeenCalledTimes(1);
    engine.resolveAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.progress).toHaveLength(13);
    expect(engine.persisted).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(89_999);
    expect(engine.persisted).toHaveLength(0);
    expect(h.runner.status()?.aiWebSearch).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    const report = await running;

    expect(daemon.cancel).toHaveBeenCalledWith(daemon.sessionId);
    expect(report.discoverySources.find((source) => source.id === 'ai_web_search')).toMatchObject({
      status: 'error',
      error: 'AI web discovery timed out after 90s and was cancelled.',
    });
    expect(report.discoveryAudit.map((vacancy) => vacancy.url)).toEqual([SHARED_URL]);
    expect(h.completed).toEqual([report]);
    expect(engine.persisted).toEqual([report]);
  });

  it('a job-site failure still fails the whole run (unchanged): the AI session is stopped, nothing is saved, one failure notice', async () => {
    const engine = syntheticEngine();
    const daemon = aiDaemon();
    const h = harness([{ engine, daemon }]);

    const running = h.runner.run(WITH_AI);
    await vi.waitFor(() => expect(daemon.create).toHaveBeenCalledTimes(1));
    engine.group('feeds').reject(new Error('synthetic feed parser crash'));
    await expect(running).rejects.toThrow('synthetic feed parser crash');

    expect(daemon.cancel).toHaveBeenCalledWith(daemon.sessionId);
    expect(engine.persisted).toHaveLength(0);
    expect(h.adopted).toHaveLength(0);
    expect(h.completed).toHaveLength(0);
    expect(h.failed).toEqual(['synthetic feed parser crash']);
    expect(h.runner.status()).toBeUndefined();
    expect(h.guard.isScanInFlight()).toBe(false);
  });

  it('Stop while only the AI step is left ends the run at once, cancels the AI session and saves nothing', async () => {
    const engine = syntheticEngine();
    const daemon = aiDaemon();
    const h = harness([{ engine, daemon }]);

    const running = h.runner.run(WITH_AI);
    await vi.waitFor(() => expect(daemon.create).toHaveBeenCalledTimes(1));
    engine.resolveAll();
    await vi.waitFor(() => expect(h.progress).toHaveLength(13));

    expect(h.runner.cancel('some-older-scan')).toEqual({ cancelled: false });
    expect(h.runner.cancel('scan-1')).toEqual({ cancelled: true });
    expect(h.runner.status()).toMatchObject({ scanId: 'scan-1', stopping: true });
    await expect(running).rejects.toSatisfy(isScanCancelledError);

    expect(daemon.cancel).toHaveBeenCalledWith(daemon.sessionId);
    expect(engine.persisted).toHaveLength(0);
    expect(h.adopted).toHaveLength(0);
    expect(h.completed).toHaveLength(0);
    expect(h.failed).toEqual([]);
    expect(h.runner.status()).toBeUndefined();
    expect(h.runner.cancel('scan-1')).toEqual({ cancelled: false });
  });

  it('Stop while job sites are still running: their late events never reach the page', async () => {
    const engine = syntheticEngine();
    const daemon = aiDaemon();
    const h = harness([{ engine, daemon }]);

    const running = h.runner.run(WITH_AI);
    await vi.waitFor(() => expect(daemon.create).toHaveBeenCalledTimes(1));
    engine.group('himalayas').resolve([row('himalayas', 'himalayas:ui-1', SHARED_URL, 'UI Engineer')]);
    await vi.waitFor(() => expect(h.progress).toHaveLength(1));

    h.runner.cancel('scan-1');
    engine.resolveAll();
    await expect(running).rejects.toSatisfy(isScanCancelledError);

    expect(h.progress).toHaveLength(1);
    expect(daemon.cancel).toHaveBeenCalledWith(daemon.sessionId);
    expect(engine.persisted).toHaveLength(0);
    expect(h.completed).toHaveLength(0);
    expect(h.failed).toEqual([]);
  });

  it('an AI step that ignores Stop is fenced: its late result reaches neither the stopped run nor the newer one', async () => {
    const engine1 = syntheticEngine();
    const stubborn = aiDaemon({ honorsStop: false, sessionId: 'stubborn-session' });
    const engine2 = syntheticEngine();
    const daemon2 = aiDaemon({ sessionId: 'second-session' });
    const h = harness([{ engine: engine1, daemon: stubborn }, { engine: engine2, daemon: daemon2 }], { graceMs: 30 });

    const first = h.runner.run(WITH_AI);
    await vi.waitFor(() => expect(stubborn.create).toHaveBeenCalledTimes(1));
    engine1.resolveAll();
    await vi.waitFor(() => expect(h.progress).toHaveLength(13));
    h.runner.cancel('scan-1');
    await expect(first).rejects.toSatisfy(isScanCancelledError);
    expect(h.warnings).toContain('AI web discovery did not stop in time; its late result will be ignored');
    expect(h.guard.isScanInFlight()).toBe(false);

    // A newer run starts while the stopped run's AI stream is still open.
    const second = h.runner.run(WITH_AI);
    await vi.waitFor(() => expect(daemon2.create).toHaveBeenCalledTimes(1));
    expect(h.runner.status()).toMatchObject({ scanId: 'scan-2', aiWebSearch: 'running' });

    // The stopped run's AI step finally finishes, late, with a candidate.
    stubborn.complete([aiCandidate(AI_ONLY_URL, 'Late Stale Role')]);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.runner.status()).toMatchObject({ scanId: 'scan-2', aiWebSearch: 'running' });
    expect(h.progress.filter((event) => event.scanId === 'scan-1')).toHaveLength(13);
    expect(h.progress.filter((event) => event.scanId === 'scan-2')).toHaveLength(0);

    engine2.resolveAll();
    daemon2.complete([]);
    const report = await second;

    expect(report.discoveryAudit.map((vacancy) => vacancy.url)).toEqual([SHARED_URL]);
    expect(engine1.persisted).toHaveLength(0);
    expect(engine2.persisted).toEqual([report]);
    expect(h.adopted).toEqual([report]);
    expect(h.completed).toEqual([report]);
    expect(h.failed).toEqual([]);
  });

  it('a second run while one is in flight is refused quietly: one lock, one engine call, one AI session', async () => {
    const engine = syntheticEngine();
    const daemon = aiDaemon();
    const h = harness([{ engine, daemon }, { engine: syntheticEngine() }]);

    const first = h.runner.run(WITH_AI);
    await vi.waitFor(() => expect(daemon.create).toHaveBeenCalledTimes(1));
    await expect(h.runner.run(WITH_AI)).rejects.toThrow(SCAN_BUSY_IN_PROCESS);
    expect(h.failed).toEqual([]);
    expect(h.runner.status()).toMatchObject({ scanId: 'scan-1' });

    engine.resolveAll();
    daemon.complete([]);
    const report = await first;
    expect(engine.calls).toHaveLength(1);
    expect(daemon.create).toHaveBeenCalledTimes(1);
    expect(h.completed).toEqual([report]);
  });

  it('without AI search: no AI session, no AI option for the engine, the same once-only lifecycle', async () => {
    const engine = syntheticEngine();
    const daemon = aiDaemon();
    const h = harness([{ engine, daemon }]);

    const running = h.runner.run(WITHOUT_AI);
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    expect(Object.keys(engine.calls[0]!).sort()).toEqual(['onProgress', 'query', 'signal']);
    expect(h.runner.status()).not.toHaveProperty('aiWebSearch');
    engine.resolveAll();
    const report = await running;

    expect(daemon.create).not.toHaveBeenCalled();
    expect(h.progress).toHaveLength(13);
    expect(report.discoverySources.some((source) => source.id === 'ai_web_search')).toBe(false);
    expect(engine.persisted).toEqual([report]);
    expect(h.adopted).toEqual([report]);
    expect(h.completed).toEqual([report]);
  });
});

describe('measurement on one deterministic slow-AI synthetic fixture (#685)', () => {
  // WHAT THIS IS: virtual milliseconds on a fake clock, from a synthetic fixture where the 13 job-site
  // progress groups finish at 1.0 s, 1.15 s, ... 2.8 s and the AI session answers at 60 s. The
  // synthetic engine adds no enrichment time. It measures only the ordering this change controls: when
  // the first useful job-site rows reach the renderer and when the run completes. It is NOT a
  // real-world latency, recall or cost result, and none is claimed.
  const GROUP_FINISH_MS = SCAN_PROGRESS_SOURCE_IDS.map((_id, index) => 1_000 + index * 150);
  const AI_ANSWER_MS = 60_000;

  async function measure(request: typeof WITH_AI) {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const engine = syntheticEngine();
    const daemon = aiDaemon();
    const h = harness([{ engine, daemon }]);
    const startedAt = Date.now();
    SCAN_PROGRESS_SOURCE_IDS.forEach((id, index) => {
      setTimeout(() => {
        engine.group(id).resolve([row('himalayas', `${id}:row`, `https://source.example/${id}/job`, `UI Engineer (${id})`)]);
      }, GROUP_FINISH_MS[index]);
    });
    setTimeout(() => daemon.complete([aiCandidate(AI_ONLY_URL, 'Frontend Developer')]), AI_ANSWER_MS);
    let firstRowsAt: number | undefined;
    const running = h.runner.run(request).then((report) => ({ report, completedAt: Date.now() - startedAt }));
    for (let elapsed = 0; elapsed < 120_000; elapsed += 50) {
      await vi.advanceTimersByTimeAsync(50);
      if (firstRowsAt === undefined && h.progress.some((event) => event.vacancies.length > 0)) {
        firstRowsAt = Date.now() - startedAt;
      }
      if (engine.persisted.length > 0) break;
    }
    const { report, completedAt } = await running;
    return { firstRowsAt, completedAt, rows: report.discoveryAudit.length, aiSessions: daemon.create.mock.calls.length };
  }

  it('AI disabled (baseline): first job-site rows at 1.0 s, completion at 2.8 s', async () => {
    expect(await measure(WITHOUT_AI)).toEqual({ firstRowsAt: 1_000, completedAt: 2_800, rows: 13, aiSessions: 0 });
  });

  it('AI enabled with a 60 s AI step: first job-site rows still at 1.0 s; completion waits for the AI step at 60 s', async () => {
    expect(await measure(WITH_AI)).toEqual({ firstRowsAt: 1_000, completedAt: 60_000, rows: 14, aiSessions: 1 });
  });
});
