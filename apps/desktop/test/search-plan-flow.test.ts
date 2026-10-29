import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SEARCH_PLAN_ENVELOPE,
  EMPTY_CANDIDATE_PROFILE,
  ScanCancelledError,
  isScanCancelledError,
  resolveFocusedLeads,
  runSearchPlan,
  type SearchPlanRunResult,
  type CandidateProfile,
  type GlobalRemoteReport,
  type GlobalRemoteScanOptions,
  type GlobalRemoteScanResult,
} from '@open-vacancy-radar/vacancy-engine';
import { runGlobalRemoteDiscovery } from '../../../packages/vacancy-engine/src/global-remote/discovery.js';
import type { GlobalRemoteConfig } from '../../../packages/vacancy-engine/src/global-remote/models.js';
import { SyntheticTransport } from '../../../packages/vacancy-engine/test/fixtures/search-plan-market.js';
import { createScanGuard, isExpectedScanBusyError } from '../electron/scan-guard.js';
import { createSearchPlanStore } from '../electron/search-plan-store.js';
import { parseVacancyScanRequest, selectBackgroundScan } from '../electron/vacancy-scan-query.js';
import { createVacancyScanRunner } from '../electron/vacancy-scan-run.js';

// ---------------------------------------------------------------------------------------------
// #686: the reviewed search plan, from the person's approval to the report a run produces.
//
// Real here: the plan store (approval, persistence to a temp file, suggestions, snapshot), the run
// lifecycle (`createVacancyScanRunner`, what main.ts delegates to), background selection, the
// engine's own discovery adapters run through a real `SafeHttpClient`, the plan ledger and variant
// passes, identity merge, shared OR filter and provenance (`runSearchPlan`, `resolveFocusedLeads`).
// Fake: the upstream sites (the engine package's synthetic labelled corpus behind a scripted fetch)
// and the engine's report writing and enrichment. The engine's own `runGlobalRemoteScan` with a plan
// is covered end to end in packages/vacancy-engine/test/pipeline/global-remote-search-plan.test.ts.
// No provider, job site or network is touched.
// ---------------------------------------------------------------------------------------------

const PROFILE: CandidateProfile = {
  ...EMPTY_CANDIDATE_PROFILE,
  profileVersion: 'test',
  targetRoles: ['Backend Engineer', 'Data Engineer', 'Product Designer'],
  strongestSkills: ['TypeScript'],
};

function baseConfig(literal: string): GlobalRemoteConfig {
  return {
    version: 'test',
    minimumAnnualBaseUsd: null,
    discovery: {
      roleQuery: literal,
      himalayasQueries: [literal],
      himalayasCountry: '',
      himalayasMaxPagesPerQuery: 1,
      jobicyCount: 1,
      freehireLimit: 1,
      jobOpportunitiesLimit: 1,
      remoteLandersMaxPages: 1,
      jobgetherMaxPages: 1,
      remoteFirstMaxPages: 1,
      jobRemotelyMaxPages: 1,
      arbeitnowMaxPages: 1,
      diceMaxPages: 1,
      remooteRoleTitle: '',
      remooteCountry: '',
      remooteLimit: 10,
      aiDevJobsMaxPages: 1,
      taiwanJobsMaxCities: 1,
      museEnabled: false,
      museMaxPages: 1,
      adzunaAppId: '',
      adzunaAppKey: '',
      adzunaMaxPages: 1,
      joobleApiKey: '',
      reedApiKey: '',
      jobspipeApiKey: '',
      atsRosterConcurrency: 1,
      navArbeidsplassenApiKey: '',
      navArbeidsplassenMaxPages: 1,
    },
    officialSources: [],
  } as unknown as GlobalRemoteConfig;
}

interface Gate {
  promise: Promise<void>;
  open(): void;
}
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * The engine body as `runGlobalRemoteScan` runs it for these purposes: the literal pass over the
 * synthetic market, then (only when the run carries a plan) the variant passes inside the shared
 * envelope, then the one shared filter and provenance. `hold` pauses it after the literal pass so a
 * test can edit the saved plan while the run is active.
 */
function planAwareEngine(options: { hold?: Gate } = {}) {
  const calls: GlobalRemoteScanOptions[] = [];
  const transports: SyntheticTransport[] = [];
  async function run(scanOptions: GlobalRemoteScanOptions): Promise<GlobalRemoteScanResult> {
    calls.push(scanOptions);
    if (scanOptions.signal?.aborted) throw new ScanCancelledError();
    const transport = new SyntheticTransport();
    transports.push(transport);
    const literal = scanOptions.query ?? '';
    const config = baseConfig(literal);
    const callNumber = calls.length;
    const literalPass = async (http: typeof transport.http) => {
      const literalRun = await runGlobalRemoteDiscovery(http, config);
      if (options.hold && callNumber === 1) await options.hold.promise;
      return literalRun;
    };
    const plan: SearchPlanRunResult | null = scanOptions.searchPlan
      ? await runSearchPlan({
          http: transport.http,
          config,
          literal,
          snapshot: scanOptions.searchPlan,
          ...(scanOptions.searchPlanEnvelope ? { envelope: scanOptions.searchPlanEnvelope } : {}),
          runLiteral: literalPass,
        })
      : null;
    const literalRun = plan ? null : await literalPass(transport.http);
    const resolved = resolveFocusedLeads(
      plan?.run ?? literalRun!,
      {
        role: literal,
        ...(plan ? { roleAlternatives: plan.report.queries.slice(1).map((query) => query.query) } : {}),
        country: null,
        employment: null,
      },
      plan,
    );
    const report = {
      runId: `report-${calls.length}`,
      generatedAt: new Date().toISOString(),
      discoveryAudit: resolved.focused.vacancies,
      discoverySources: resolved.discoverySources,
      ...(plan ? { searchPlan: plan.report } : {}),
      ...(scanOptions.searchPlanStatus ? { searchPlanStatus: scanOptions.searchPlanStatus } : {}),
    } as unknown as GlobalRemoteReport;
    return { report, files: {} as GlobalRemoteScanResult['files'] };
  }
  return { run, calls, transports };
}

let directory: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function newStore() {
  directory = await mkdtemp(path.join(tmpdir(), 'ovr-686-'));
  const file = path.join(directory, 'config', 'search-plan-v1.json');
  return { store: createSearchPlanStore({ filePath: async () => file }), file };
}

function harness(store: ReturnType<typeof createSearchPlanStore>, engine: ReturnType<typeof planAwareEngine>) {
  const guard = createScanGuard(() => undefined);
  const adopted: GlobalRemoteReport[] = [];
  const failed: string[] = [];
  const aiCalls: unknown[] = [];
  let scanNumber = 0;
  const runner = createVacancyScanRunner({
    beforeScan: async () => {},
    runExclusiveScan: (run) => guard.runExclusiveScan(run, { takeAdvisoryLock: false }),
    loadSearchPlanSnapshot: () => store.snapshot(),
    prepareRun: async () => ({
      loadProfile: async () => PROFILE,
      ensureAiWorkspace: async () => '/tmp/ai-686',
      runAiWebDiscovery: async (aiOptions) => {
        aiCalls.push(aiOptions);
        throw new Error('AI must not be used by these tests');
      },
      runGlobalRemoteScan: engine.run,
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
      browseAllResultCap: 5_000,
      aiStopGraceMs: 50,
    }),
    newScanId: () => `scan-${++scanNumber}`,
    now: () => Date.now(),
    progressSourceTotal: 13,
    sendProgress: () => undefined,
    adoptReport: (report) => adopted.push(report),
    notifyCompleted: () => undefined,
    notifyFailed: (detail) => failed.push(detail),
    isQuietError: (error) => isExpectedScanBusyError(error) || isScanCancelledError(error),
    throwCancelled: () => {
      throw new ScanCancelledError();
    },
  });
  return { runner, adopted, failed, aiCalls };
}

const DRAFT = {
  primaryFunction: 'Frontend engineering',
  variants: [
    { title: 'React developer' },
    { title: 'Frontend engineer' },
    { title: 'UI engineer' },
    { title: 'Frontend ontwikkelaar', language: 'Dutch' },
  ],
  markets: ['Netherlands'],
};
const PLAN_RUN = parseVacancyScanRequest({ mode: 'query', query: 'React developer', useSearchPlan: true });
const LITERAL_RUN = parseVacancyScanRequest({ mode: 'query', query: 'React developer' });

const titlesOf = (report: GlobalRemoteReport) => report.discoveryAudit.map((lead) => lead.title);

describe('reviewed search plan, from approval to report (#686)', () => {
  it('an approved plan reaches the run as a frozen snapshot and recovers the equivalent titles with their origin', async () => {
    const { store } = await newStore();
    await store.save(DRAFT);
    const engine = planAwareEngine();
    const h = harness(store, engine);

    const report = await h.runner.run(PLAN_RUN);

    expect(engine.calls).toHaveLength(1);
    const options = engine.calls[0]!;
    expect(options.query).toBe('React developer');
    expect(options.searchPlan).toMatchObject({ revision: 1, workingLanguages: ['Dutch'], markets: ['Netherlands'] });
    expect(options.searchPlan!.variants.map((variant) => variant.title)).toEqual([
      'React developer',
      'Frontend engineer',
      'UI engineer',
      'Frontend ontwikkelaar',
    ]);
    expect(Object.isFrozen(options.searchPlan)).toBe(true);

    for (const title of ['React Developer', 'Frontend Engineer', 'UI Engineer', 'Senior UI Engineer', 'Frontend ontwikkelaar']) {
      expect(titlesOf(report)).toContain(title);
    }
    for (const unwanted of ['UI Designer', 'Sales Manager', 'Sales Engineer', 'Data Scientist']) {
      expect(titlesOf(report)).not.toContain(unwanted);
    }
    const senior = report.discoveryAudit.find((lead) => lead.title === 'Senior UI Engineer')!;
    expect(senior.queryProvenance).toMatchObject({
      planRevision: 1,
      matchedLocally: [{ query: 'UI engineer', language: null, field: 'title' }],
      fetchedBy: [{ query: 'UI engineer', provider: 'jobicy' }],
    });
    const dutch = report.discoveryAudit.find((lead) => lead.title === 'Frontend ontwikkelaar')!;
    expect(dutch.queryProvenance!.matchedLocally.map((query) => [query.query, query.language])).toEqual([
      ['Frontend ontwikkelaar', 'Dutch'],
    ]);
    // The report carries its own copy of the plan, the shared allowance and the coverage.
    expect(report.searchPlan).toMatchObject({ planRevision: 1, workingLanguages: ['Dutch'], coverage: expect.any(String) });
    expect(report.searchPlan!.envelope).toEqual(DEFAULT_SEARCH_PLAN_ENVELOPE);
    expect(h.adopted).toEqual([report]);
    expect(h.aiCalls).toHaveLength(0);
  });

  it('keeps the literal single-query run exactly as it was, even with a saved plan', async () => {
    const { store } = await newStore();
    await store.save(DRAFT);
    const engine = planAwareEngine();
    const h = harness(store, engine);

    const report = await h.runner.run(LITERAL_RUN);

    expect(Object.keys(engine.calls[0]!)).not.toContain('searchPlan');
    expect(report.searchPlan).toBeUndefined();
    // The typed query keeps its title-and-description rule: labelled hard negatives that mention it in the
    // description stay in a literal run, exactly as before #686.
    expect(titlesOf(report).filter((title) => !/react developer/i.test(title)).sort()).toEqual(['Backend Engineer', 'Technical Recruiter']);
    expect(report.discoveryAudit.every((lead) => lead.queryProvenance === undefined)).toBe(true);
  });

  it('editing or removing a title while a run is active changes only the next run', async () => {
    const { store } = await newStore();
    await store.save(DRAFT);
    const hold = gate();
    const engine = planAwareEngine({ hold });
    const h = harness(store, engine);

    const first = h.runner.run(PLAN_RUN);
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
    const activeIntent = h.runner.status()!.intent!;
    expect(activeIntent).toContain('Search plan: 4 approved titles (revision 1)');

    // While run 1 is active the person removes "UI engineer" and adds a different title.
    const edited = await store.save({
      ...DRAFT,
      variants: [{ title: 'React developer' }, { title: 'Frontend engineer' }, { title: 'Frontend ontwikkelaar', language: 'Dutch' }, { title: 'Web developer' }],
    });
    expect(edited.revision).toBe(2);
    expect(h.runner.status()!.intent).toBe(activeIntent);

    hold.open();
    const firstReport = await first;
    // Run 1 still searched what it was started with.
    expect(engine.calls[0]!.searchPlan!.revision).toBe(1);
    expect(engine.calls[0]!.searchPlan!.variants.map((variant) => variant.title)).toContain('UI engineer');
    expect(firstReport.searchPlan!.planRevision).toBe(1);
    expect(titlesOf(firstReport)).toContain('UI Engineer');
    const frozenCopy = JSON.stringify(firstReport);

    // The next run uses the edited plan.
    const secondReport = await h.runner.run(PLAN_RUN);
    expect(engine.calls[1]!.searchPlan!.revision).toBe(2);
    expect(titlesOf(secondReport)).not.toContain('UI Engineer');
    expect(secondReport.searchPlan!.planRevision).toBe(2);
    // The finished first report (what a saved job or application would reference) did not change.
    expect(JSON.stringify(firstReport)).toBe(frozenCopy);
    const senior = firstReport.discoveryAudit.find((lead) => lead.title === 'Senior UI Engineer')!;
    expect(senior.queryProvenance!.matchedLocally[0]!.query).toBe('UI engineer');
  });

  it('works by hand with no AI, and a suggestion never changes a search until the person approves it', async () => {
    const { store } = await newStore();
    await store.save({ primaryFunction: '', variants: [{ title: 'React developer' }, { title: 'Frontend engineer' }] });
    const engine = planAwareEngine();
    const h = harness(store, engine);

    const suggested = await store.addSuggestions([{ title: 'UI engineer' }, { title: 'Frontend engineer' }]);
    expect(suggested.suggestions.map((suggestion) => suggestion.title)).toEqual(['UI engineer']);
    expect(suggested.revision).toBe(1);

    const before = await h.runner.run(PLAN_RUN);
    expect(engine.calls[0]!.searchPlan!.variants.map((variant) => variant.title)).toEqual(['React developer', 'Frontend engineer']);
    expect(titlesOf(before)).not.toContain('Senior UI Engineer');

    await store.save({
      primaryFunction: '',
      variants: [...suggested.variants.map((variant) => ({ title: variant.title })), { title: 'UI engineer' }],
    });
    const after = await h.runner.run(PLAN_RUN);
    expect(engine.calls[1]!.searchPlan!.revision).toBe(2);
    expect(titlesOf(after)).toContain('Senior UI Engineer');
    expect(h.aiCalls).toHaveLength(0);
  });

  it('background selection runs ONE scan with the approved plan instead of scanning every saved role', async () => {
    const { store } = await newStore();
    await store.save(DRAFT);
    const engine = planAwareEngine();
    const h = harness(store, engine);

    const loaded = await store.load();
    const selection = selectBackgroundScan(PROFILE, loaded.status === 'ok' ? loaded.plan : 'unreadable');
    expect(selection).toEqual({ query: 'React developer', fallbackQuery: 'Backend Engineer', useSearchPlan: true });
    const report = await h.runner.run({ mode: 'query', query: selection!.fallbackQuery, useSearchPlan: true, queryFromSearchPlan: true });

    expect(engine.calls).toHaveLength(1);
    // The run took its query from the snapshot it captured itself: the first approved title.
    expect(engine.calls[0]!.query).toBe('React developer');
    expect(engine.calls[0]!.searchPlan!.variants).toHaveLength(4);
    // The saved roles (backend, data, design) were not searched on their own.
    expect(engine.transports[0]!.fetchLog.map((request) => request.url).join(' ')).not.toMatch(/backend|data\+engineer|designer/i);
    expect(report.searchPlan!.envelope).toEqual(DEFAULT_SEARCH_PLAN_ENVELOPE);

    // Without a usable plan it is the first saved role, as before; suggestions alone are not a plan.
    expect(selectBackgroundScan(PROFILE, null)).toEqual({ query: 'Backend Engineer', fallbackQuery: 'Backend Engineer', useSearchPlan: false });
    await store.save({ primaryFunction: '', variants: [] });
    const empty = await store.addSuggestions([{ title: 'UI engineer' }]);
    expect(selectBackgroundScan(PROFILE, empty)).toEqual({ query: 'Backend Engineer', fallbackQuery: 'Backend Engineer', useSearchPlan: false });
    expect(selectBackgroundScan({ ...PROFILE, targetRoles: [], strongestSkills: [] }, empty)).toBeNull();
  });

  it('reads the plan once per background run: a title removed after selection is not searched, and an emptied plan is reported', async () => {
    const { store } = await newStore();
    await store.save(DRAFT);
    const engine = planAwareEngine();
    const h = harness(store, engine);
    const loaded = await store.load();
    const selection = selectBackgroundScan(PROFILE, loaded.status === 'ok' ? loaded.plan : 'unreadable')!;

    // Between selection and the run starting, the person removes the first title.
    await store.save({ ...DRAFT, variants: DRAFT.variants.slice(1) });
    await h.runner.run({ mode: 'query', query: selection.fallbackQuery, useSearchPlan: true, queryFromSearchPlan: true });
    expect(engine.calls[0]!.query).toBe('Frontend engineer');
    expect(engine.calls[0]!.searchPlan!.variants.map((variant) => variant.title)).not.toContain('React developer');

    // And when the plan is emptied before the run starts, the run says what it searched instead.
    await store.save({ ...DRAFT, variants: [] });
    const fallback = await h.runner.run({ mode: 'query', query: selection.fallbackQuery, useSearchPlan: true, queryFromSearchPlan: true });
    expect(engine.calls[1]!.query).toBe('Backend Engineer');
    expect(engine.calls[1]!.searchPlan).toBeUndefined();
    expect(fallback.searchPlanStatus).toEqual({
      state: 'empty_at_start',
      message: 'Your search plan had no approved titles when this background search started, so it searched your saved role or skill "Backend Engineer" only.',
    });
  });

  it('a person-started planned run whose plan emptied before it began says so instead of silently searching one query', async () => {
    const { store } = await newStore();
    await store.save({ primaryFunction: '', variants: [] });
    const engine = planAwareEngine();
    const h = harness(store, engine);
    const report = await h.runner.run(PLAN_RUN);
    expect(engine.calls[0]!.searchPlan).toBeUndefined();
    expect(report.searchPlanStatus).toEqual({
      state: 'empty_at_start',
      message: 'Your search plan had no approved titles when this search started, so only the typed query was searched.',
    });
    expect(h.runner.status()).toBeUndefined();
  });

  it('a damaged or newer-version plan fails a person-started planned run clearly, is never overwritten by a save, and resets only with confirmation and a byte-exact backup', async () => {
    const { store, file } = await newStore();
    await mkdir(path.dirname(file), { recursive: true });
    const future = `${JSON.stringify({ schemaVersion: 2, revision: 7, variants: [{ id: 'x', title: 'Future title', weight: 2 }] })}\n`;
    await writeFile(file, future, 'utf8');
    const engine = planAwareEngine();
    const h = harness(store, engine);

    const loaded = await store.load();
    expect(loaded).toEqual({
      status: 'unreadable',
      reason: 'newer_version',
      message: 'Your search plan was saved by a newer version of Open Vacancy Radar (plan format 2). This version cannot read it and will not change it.',
      fileName: 'search-plan-v1.json',
    });
    await expect(h.runner.run(PLAN_RUN)).rejects.toThrow(/newer version/);
    expect(engine.calls).toHaveLength(0);
    expect(h.failed).toHaveLength(1);
    // A literal search is unaffected.
    await expect(h.runner.run(LITERAL_RUN)).resolves.toBeDefined();

    // Ordinary saves and suggestions refuse and leave the file byte-for-byte as it was.
    await expect(store.save(DRAFT)).rejects.toThrow(/newer version/);
    await expect(store.addSuggestions([{ title: 'UI engineer' }])).rejects.toThrow(/newer version/);
    expect(await readFile(file, 'utf8')).toBe(future);

    // A background run falls back to the saved role and reports why, on the report.
    const background = await h.runner.run({ mode: 'query', query: 'Backend Engineer', useSearchPlan: true, queryFromSearchPlan: true });
    expect(background.searchPlanStatus?.state).toBe('unreadable');
    expect(background.searchPlanStatus?.message).toMatch(/newer version.*This background search used your saved role or skill "Backend Engineer" instead\./);

    // Reset needs explicit confirmation, then keeps the exact bytes before starting an empty plan.
    await expect(store.resetUnreadable({})).rejects.toThrow(/confirmation/);
    expect(await readFile(file, 'utf8')).toBe(future);
    const reset = await store.resetUnreadable({ confirm: true });
    expect(reset.plan.variants).toEqual([]);
    const backup = path.join(path.dirname(file), reset.backupFileName);
    expect(reset.backupFileName).toMatch(/^search-plan-v1\.json\.unreadable-.*\.bak$/);
    expect(await readFile(backup, 'utf8')).toBe(future);
    expect((await store.load()).status).toBe('ok');
    await expect(store.resetUnreadable({ confirm: true })).rejects.toThrow(/nothing to reset/);
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith('.bak'))).toEqual([reset.backupFileName]);

    // Now the person can approve a plan again.
    await store.save(DRAFT);
    const repaired = await h.runner.run(PLAN_RUN);
    expect(repaired.searchPlan!.planRevision).toBe(1);
  });

  it('a damaged plan is reported as damaged, not as a newer version', async () => {
    const { store, file } = await newStore();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json', 'utf8');
    const loaded = await store.load();
    expect(loaded.status === 'unreadable' && loaded.reason).toBe('damaged');
    await expect(store.save(DRAFT)).rejects.toThrow(/damaged/);
    expect(await readFile(file, 'utf8')).toBe('{ not json');
  });

  it('refuses an unusable title with a readable message instead of a raw validation error', async () => {
    const { store } = await newStore();
    await expect(store.save({ primaryFunction: '', variants: [{ title: 'React developer' }, { title: '##' }] })).rejects.toThrow(
      'Title 2 ("##") has no letters or numbers, so no source can search for it. Change it or remove it.',
    );
    await expect(store.save({ variants: 'nope' })).rejects.toThrow(/not in the expected form/);
  });
});
