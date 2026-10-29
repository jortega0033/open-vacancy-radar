import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  approveSearchPlanDraft,
  captureSearchPlanSnapshot,
  EMPTY_SEARCH_PLAN,
  searchPlanDraftSchema,
  type SearchPlanSnapshot,
} from '../../src/candidate/search-plan.js';
import type { GlobalRemoteReport } from '../../src/global-remote/models.js';
import { SYNTHETIC_CORPUS, SyntheticTransport } from '../fixtures/search-plan-market.js';

/**
 * Issue #686 -- the REAL `runGlobalRemoteScan` with a search plan: literal pass, approved-title passes,
 * shared filter, provenance, classification, report writing. Hermetic: the network is the synthetic
 * corpus behind a real `SafeHttpClient` built from the hooks the scan's own composition root passes
 * (so this proves the root wires the plan's admission hook), and the database and side sources that
 * have nothing to do with a plan (official employer checks, Workable/MPSV bulk snapshots, the ATS
 * roster file, discovery-run bookkeeping) are stubbed.
 */
const harness = vi.hoisted(() => ({
  transport: undefined as unknown as SyntheticTransport,
  transportOptions: {} as ConstructorParameters<typeof SyntheticTransport>[1],
  // Assigned below, after imports: the factory must not import the fixture (which imports this module).
  create: undefined as unknown as (dependencies: Record<string, unknown>) => SyntheticTransport,
}));

vi.mock('../../src/pipeline/ats-http-client.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createDatabaseBackedHttpClients: (_config: unknown, _database: unknown, dependencies: Record<string, unknown> = {}) => {
    harness.transport = harness.create(dependencies);
    return { safeClient: harness.transport.safeClient, atsClient: harness.transport.http };
  },
}));
vi.mock('../../src/global-remote/official.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runOfficialGlobalRemoteSources: async () => ({ audits: [], requestCount: 0 }),
}));
vi.mock('../../src/global-remote/workable-global-discovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runWorkableGlobalDiscovery: async () => ({ sources: [], vacancies: [] }),
}));
vi.mock('../../src/global-remote/mpsv-cz-discovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runMpsvCzDiscovery: async () => ({ sources: [], vacancies: [] }),
}));
vi.mock('../../src/companies/ats-roster-repository.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadAtsRoster: async () => [],
}));
vi.mock('../../src/global-remote/discovery-runs-repository.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordDiscoveryRun: async () => undefined,
}));
vi.mock('../../src/global-remote/report.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  pruneGlobalRemoteReports: async () => undefined,
}));

const { runGlobalRemoteScan } = await import('../../src/pipeline/global-remote.js');

// Only the hooks the scan's composition root passes are wired: if the root forgot the admission hook,
// the plan ledger would see requests it could not count and the planned scan would fail.
harness.create = (dependencies) =>
  new SyntheticTransport(undefined, {
    ...harness.transportOptions,
    wiring: {
      ...(dependencies.admitNetworkRequest ? { admitNetworkRequest: dependencies.admitNetworkRequest as never } : {}),
      ...(dependencies.onNetworkRequest ? { onNetworkRequest: dependencies.onNetworkRequest as never } : {}),
    },
  });

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = new Date('2026-10-29T10:00:00.000Z');
const KEYED = {
  adzunaAppId: '', adzunaAppKey: '', joobleApiKey: '', reedApiKey: '', jobspipeApiKey: '', navArbeidsplassenApiKey: '',
  theirstackEnabled: false, theirstackApiKey: '', theirstackMaxCredits: 0, theirstackMaxPages: 0, theirstackPostedWithinDays: 0,
};
const logger = { warn: () => undefined, debug: () => undefined, info: () => undefined, error: () => undefined };

function snapshotOf(variants: { title: string; language?: string }[]): SearchPlanSnapshot {
  return captureSearchPlanSnapshot(
    approveSearchPlanDraft(EMPTY_SEARCH_PLAN, searchPlanDraftSchema.parse({ primaryFunction: 'Frontend', markets: ['Netherlands'], variants }), NOW),
  );
}

const PLAN = snapshotOf([
  { title: 'React developer' },
  { title: 'Frontend engineer' },
  { title: 'UI engineer' },
  { title: 'Frontend ontwikkelaar', language: 'Dutch' },
]);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ovr-686-scan-'));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await cp(path.join(ENGINE_ROOT, 'config', 'global-remote-profile-v1.json'), path.join(root, 'config', 'global-remote-profile-v1.json'));
  harness.transportOptions = {};
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function scan(options: Parameters<typeof runGlobalRemoteScan>[4], transportOptions: typeof harness.transportOptions = {}) {
  harness.transportOptions = transportOptions;
  const result = await runGlobalRemoteScan({} as never, { reportRetentionDays: 30, keyedDiscovery: KEYED } as never, logger as never, root, options);
  return { report: result.report, files: result.files, transport: harness.transport };
}

/** Fetches made by discovery sources: everything but the sponsor-registry enrichment lookups. */
const searchFetches = (transport: SyntheticTransport) => transport.fetchLog.filter((entry) => entry.host !== 'www.wikidata.org');

const equivalentUrls = new Set(SYNTHETIC_CORPUS.filter((job) => job.equivalent).map((job) => job.url));
const suitable = (report: GlobalRemoteReport) => new Set(report.discoveryAudit.filter((lead) => equivalentUrls.has(lead.url)).map((lead) => lead.url)).size;

describe('runGlobalRemoteScan with a reviewed search plan (#686)', () => {
  it('runs the plan through the real scan, writes it to the report and keeps each lead traceable', async () => {
    const literal = await scan({ query: 'React developer' });
    const planned = await scan({ query: 'React developer', searchPlan: PLAN }, { transientFailuresPerUrl: 1, redirectHosts: ['himalayas.app'] });

    expect(literal.report.searchPlan).toBeUndefined();
    expect(literal.report.discoverySources.every((source) => source.searchPlanAdmission === undefined)).toBe(true);
    expect(suitable(planned.report)).toBeGreaterThan(suitable(literal.report));

    const plan = planned.report.searchPlan!;
    expect(plan.planRevision).toBe(1);
    expect(plan.queries.map((query) => query.query)).toEqual(['React developer', 'Frontend engineer', 'UI engineer', 'Frontend ontwikkelaar']);
    // The composition root wired the admission hook: every physical attempt was charged, none missed.
    // Sponsor-registry lookups (Wikidata) are outside the declared envelope (`budgetScope.excludes`) and
    // are the only requests the plan does not charge.
    expect(plan.budgetScope.excludes).toMatch(/sponsor-registry lookups/);
    expect(searchFetches(planned.transport).length).toBe(plan.usage.attempts);
    expect(plan.usage.attempts).toBeLessThanOrEqual(plan.envelope.maxRequests);
    expect(planned.report.statistics.discoveryNetworkAttempts).toBe(plan.usage.attempts);
    // OR filter: a lead found only under an approved title is kept, with its origin.
    const ui = planned.report.discoveryAudit.find((lead) => lead.title === 'Senior UI Engineer')!;
    expect(ui.queryProvenance!.fetchedBy.map((origin) => [origin.query, origin.provider])).toEqual([['UI engineer', 'jobicy']]);
    // An approved title is in scope for classification: no role_mismatch for "React Developer".
    const react = planned.report.discoveryAudit.find((lead) => lead.company === 'Acme Labs')!;
    expect(react.decision).not.toBe('role_mismatch');
    // Markets are reported as not applied, on the report and on the source rows.
    expect(plan.criteria.some((entry) => entry.criterion === 'markets' && entry.treatment === 'not_applied')).toBe(true);
    expect(planned.report.discoverySources.every((source) => source.focusedScan?.searchPlanCriteria !== undefined)).toBe(true);
    expect(planned.report.methodology.some((line) => /One shared allowance covered the whole plan/.test(line))).toBe(true);

    // What was written to disk is what the run returned.
    const written = JSON.parse(await readFile(planned.files.latestJson, 'utf8')) as GlobalRemoteReport;
    expect(written.searchPlan).toEqual(plan);
    expect(written.discoveryAudit.find((lead) => lead.title === 'Senior UI Engineer')!.queryProvenance).toEqual(ui.queryProvenance);
    // The HTML report's listing table no longer drops approved-title rows as role mismatches.
    const html = await readFile(planned.files.latestHtml, 'utf8');
    expect(html).toContain('Frontend ontwikkelaar');
    expect(html).toContain('Acme Labs');
  });

  it('enforces the envelope inside the real scan and reports refused sources truthfully', async () => {
    const tight = await scan(
      { query: 'React developer', searchPlan: snapshotOf(Array.from({ length: 12 }, (_, index) => ({ title: `Frontend title ${index + 1}` }))), searchPlanEnvelope: { maxRequests: 40 } },
      { transientFailuresPerUrl: 1 },
    );
    const plan = tight.report.searchPlan!;
    expect(searchFetches(tight.transport).length).toBeLessThanOrEqual(40);
    expect(searchFetches(tight.transport).length).toBe(plan.usage.attempts);
    expect(plan.coverage).toBe('partial');
    // Request totals hold only calls that reached the network: no phantom refused calls.
    const sent = tight.report.discoverySources.reduce((sum, source) => sum + (source.searchPlanAdmission?.sentCalls ?? 0), 0);
    expect(tight.report.statistics.discoveryRequests).toBeLessThanOrEqual(sent);
    for (const source of tight.report.discoverySources) {
      for (const entry of source.focusedScan?.searchPlan ?? []) {
        if (entry.handling === 'sent_upstream') expect(source.searchPlanAdmission?.sentCalls ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('an explicit country still reaches the upstream request, for the typed query and the approved titles', async () => {
    const { transport, report } = await scan({ query: 'React developer', country: 'Netherlands', searchPlan: PLAN });
    const himalayas = transport.fetchesTo('himalayas.app').map((entry) => new URL(entry.url));
    expect(himalayas.length).toBe(4);
    expect(himalayas.every((url) => url.searchParams.get('country') !== null && url.searchParams.get('country') !== '')).toBe(true);
    expect(report.searchPlan).toBeDefined();
  });

  it('browse-all and an official-only rerun ignore the plan; a scan without one is unchanged', async () => {
    const browse = await scan({ query: '', browseAll: true, browseAllResultCap: 50, searchPlan: PLAN });
    expect(browse.report.searchPlan).toBeUndefined();
    expect(browse.report.discoverySources.every((source) => source.searchPlanAdmission === undefined)).toBe(true);

    await scan({ query: 'React developer' });
    const officialOnly = await scan({ query: 'React developer', officialOnly: true, searchPlan: PLAN });
    expect(officialOnly.report.searchPlan).toBeUndefined();
    expect(searchFetches(officialOnly.transport)).toHaveLength(0);

    const literalA = await scan({ query: 'React developer' });
    const literalB = await scan({ query: 'React developer' });
    expect(searchFetches(literalA.transport).map((entry) => entry.url).sort()).toEqual(
      searchFetches(literalB.transport).map((entry) => entry.url).sort(),
    );
    expect(literalA.report.discoveryAudit.every((lead) => lead.queryProvenance === undefined)).toBe(true);
  });

  it('copies a "plan asked for but not used" status onto the report', async () => {
    const { report } = await scan({
      query: 'React developer',
      searchPlanStatus: { state: 'empty_at_start', message: 'Your search plan had no approved titles when this search started.' },
    });
    expect(report.searchPlan).toBeUndefined();
    expect(report.searchPlanStatus).toEqual({ state: 'empty_at_start', message: 'Your search plan had no approved titles when this search started.' });
  });
});
