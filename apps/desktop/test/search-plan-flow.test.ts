import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SEARCH_PLAN_ENVELOPE,
  EMPTY_CANDIDATE_PROFILE,
  ScanCancelledError,
  isScanCancelledError,
  resolveFocusedLeads,
  runSearchPlanVariantPasses,
  type CandidateProfile,
  type GlobalRemoteReport,
  type GlobalRemoteScanOptions,
  type GlobalRemoteScanResult,
} from '@open-vacancy-radar/vacancy-engine';
import { runGlobalRemoteDiscovery } from '../../../packages/vacancy-engine/src/global-remote/discovery.js';
import type { GlobalRemoteConfig } from '../../../packages/vacancy-engine/src/global-remote/models.js';
import { SyntheticMarket } from '../../../packages/vacancy-engine/test/fixtures/search-plan-market.js';
import { createScanGuard, isExpectedScanBusyError } from '../electron/scan-guard.js';
import { createSearchPlanStore } from '../electron/search-plan-store.js';
import { parseVacancyScanRequest, selectBackgroundScan } from '../electron/vacancy-scan-query.js';
import { createVacancyScanRunner } from '../electron/vacancy-scan-run.js';

// ---------------------------------------------------------------------------------------------
// #686: the reviewed search plan, from the person's approval to the report a run produces.
//
// Real here: the plan store (approval, persistence to a temp file, suggestions, snapshot), the run
// lifecycle (`createVacancyScanRunner`, what main.ts delegates to), background selection, the
// engine's own discovery adapters, variant passes, identity merge, shared OR filter and provenance
// (`runGlobalRemoteDiscovery`, `runSearchPlanVariantPasses`, `resolveFocusedLeads`).
// Fake: the upstream sites (the engine package's synthetic labelled market) and the engine's report
// writing and enrichment. No provider, job site or network is touched.
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
  const markets: SyntheticMarket[] = [];
  async function run(scanOptions: GlobalRemoteScanOptions): Promise<GlobalRemoteScanResult> {
    calls.push(scanOptions);
    if (scanOptions.signal?.aborted) throw new ScanCancelledError();
    const market = new SyntheticMarket();
    markets.push(market);
    const literal = scanOptions.query ?? '';
    const config = baseConfig(literal);
    const literalRun = await runGlobalRemoteDiscovery(market, config);
    if (options.hold && calls.length === 1) await options.hold.promise;
    const plan = scanOptions.searchPlan
      ? await runSearchPlanVariantPasses({
          http: market,
          config,
          literal,
          snapshot: scanOptions.searchPlan,
          literalRun,
          ...(scanOptions.searchPlanEnvelope ? { envelope: scanOptions.searchPlanEnvelope } : {}),
        })
      : null;
    const resolved = resolveFocusedLeads(
      plan?.run ?? literalRun,
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
    } as unknown as GlobalRemoteReport;
    return { report, files: {} as GlobalRemoteScanResult['files'] };
  }
  return { run, calls, markets };
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
    for (const unwanted of ['Backend Engineer', 'UI Designer', 'Sales Manager']) {
      expect(titlesOf(report)).not.toContain(unwanted);
    }
    const senior = report.discoveryAudit.find((lead) => lead.title === 'Senior UI Engineer')!;
    expect(senior.queryProvenance).toMatchObject({
      planRevision: 1,
      matchedLocally: [{ query: 'UI engineer', language: null }],
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
    expect(titlesOf(report).every((title) => /react developer/i.test(title))).toBe(true);
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

    const selection = selectBackgroundScan(PROFILE, await store.get());
    expect(selection).toEqual({ query: 'React developer', useSearchPlan: true });
    const report = await h.runner.run({ mode: 'query', query: selection!.query, ...(selection!.useSearchPlan ? { useSearchPlan: true } : {}) });

    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]!.query).toBe('React developer');
    expect(engine.calls[0]!.searchPlan!.variants).toHaveLength(4);
    // The saved roles (backend, data, design) were not searched on their own.
    expect(engine.markets[0]!.requests.map((request) => request.url).join(' ')).not.toMatch(/backend|data\+engineer|designer/i);
    // Same declared allowance as a manual planned run.
    expect(report.searchPlan!.envelope).toEqual(DEFAULT_SEARCH_PLAN_ENVELOPE);

    // Without a usable plan it is the first saved role, as before; suggestions alone are not a plan.
    expect(selectBackgroundScan(PROFILE, null)).toEqual({ query: 'Backend Engineer', useSearchPlan: false });
    await store.save({ primaryFunction: '', variants: [] });
    const empty = await store.addSuggestions([{ title: 'UI engineer' }]);
    expect(selectBackgroundScan(PROFILE, empty)).toEqual({ query: 'Backend Engineer', useSearchPlan: false });
    expect(selectBackgroundScan({ ...PROFILE, targetRoles: [], strongestSkills: [] }, empty)).toBeNull();
  });

  it('fails clearly, before any source is asked, when the saved plan cannot be read', async () => {
    const { store, file } = await newStore();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json', 'utf8');
    const engine = planAwareEngine();
    const h = harness(store, engine);

    await expect(h.runner.run(PLAN_RUN)).rejects.toThrow();
    expect(engine.calls).toHaveLength(0);
    expect(h.failed).toHaveLength(1);
    // A literal search is unaffected by the damaged plan file.
    await expect(h.runner.run(LITERAL_RUN)).resolves.toBeDefined();
    // Suggestions do not quietly replace a file the person may still want; approving a plan repairs it.
    await expect(store.addSuggestions([{ title: 'UI engineer' }])).rejects.toThrow();
    await store.save(DRAFT);
    const repaired = await h.runner.run(PLAN_RUN);
    expect(repaired.searchPlan!.planRevision).toBe(1);
  });
});
