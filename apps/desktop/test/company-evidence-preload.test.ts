import { beforeEach, describe, expect, it, vi } from 'vitest';

// The REAL electron/preload.ts against a stubbed ipcRenderer (same approach as preload.test.ts):
// what the renderer can send to, and trust from, the company-evidence handlers.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

let exposedApis: Record<string, Record<string, unknown>>;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      exposedApis[name] = api as Record<string, unknown>;
    },
  },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
}));

vi.setConfig({ testTimeout: 15_000 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only view of untyped bridge results
type Result = Record<string, any>;

async function loadBridge(): Promise<Record<string, (...args: unknown[]) => Promise<Result>>> {
  vi.resetModules();
  exposedApis = {};
  await import('../electron/preload.js');
  const api = exposedApis.companyEvidence;
  if (!api) throw new Error('preload.ts did not expose companyEvidence');
  return api as Record<string, (...args: unknown[]) => Promise<Result>>;
}

const FACT = {
  id: 'f1',
  recordId: 'r1',
  scope: 'company',
  roleKey: '',
  roleLabel: '',
  topic: 'size',
  claim: 'Northwind Freight operates 14 depots.',
  sourceUrl: 'https://northwind.example/about',
  sourceKind: 'public_web',
  quote: 'operates 14 depots',
  retrievedAt: '2026-10-01T09:00:00.000Z',
  observedAt: '2026-10-01T09:00:00.000Z',
  expiresAt: '2026-12-30T09:00:00.000Z',
  verification: 'source_confirmed',
  origin: 'user',
  status: 'active',
  lastRefreshAt: null,
  lastRefreshOutcome: null,
  lastRefreshReason: null,
  correction: null,
  contradictedBy: [],
  viaLink: null,
  support: 'supported',
  reasons: [],
  official: false,
};

const VIEW = {
  state: 'ready',
  identity: { verifiedKey: 'ats:greenhouse:northwind', keyKind: 'ats_tenant', host: 'job-boards.greenhouse.io', displayName: 'Northwind Freight', nameKey: 'northwind-freight' },
  recordId: 'r1',
  entityRef: '',
  roleKey: 'req:1001',
  roleLabel: 'Platform Engineer',
  facts: [FACT],
  contradictions: [],
  links: [],
  research: null,
  lettersUsed: [],
  supportedCount: 1,
  leadCount: 0,
  generatedAt: '2026-10-05T10:00:00.000Z',
};

beforeEach(() => {
  invoke.mockReset();
});

describe('electron/preload.ts: companyEvidence bridge (#689)', () => {
  it('exposes the documented methods and no generic IPC passthrough', async () => {
    const api = await loadBridge();
    expect(Object.keys(api).sort()).toEqual(
      [
        'addFact',
        'cancel',
        'confirmDomain',
        'confirmFact',
        'correctFact',
        'decideLink',
        'deleteRecord',
        'get',
        'prose',
        'refresh',
        'research',
        'resolveContradiction',
        'withdrawFact',
      ].sort(),
    );
    expect(api.invoke).toBeUndefined();
    expect(api.send).toBeUndefined();
  });

  it('sends hard-coded channels with only ids and the person\'s own evidence input', async () => {
    const api = await loadBridge();
    invoke.mockResolvedValue({ ok: true, view: VIEW, notice: '' });
    await api.get!({ attemptId: 'a1' });
    await api.research!({ applicationId: 'p1' }, { topics: ['size'], includeRole: false });
    await api.addFact!(
      { attemptId: 'a1' },
      { claim: 'Northwind Freight operates 14 depots.', sourceUrl: 'https://northwind.example/about', quote: 'operates 14 depots', scope: 'company', topic: 'size', cv: 'CV-SENTINEL' },
    );
    await api.cancel!({ attemptId: 'a1' });
    expect(invoke).toHaveBeenNthCalledWith(1, 'company-evidence:get', { attemptId: 'a1' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'company-evidence:research', { applicationId: 'p1', topics: ['size'], includeRole: false });
    // Unknown keys are never forwarded, so a CV or note cannot be smuggled through this bridge.
    expect(invoke).toHaveBeenNthCalledWith(3, 'company-evidence:add-fact', {
      attemptId: 'a1',
      claim: 'Northwind Freight operates 14 depots.',
      sourceUrl: 'https://northwind.example/about',
      quote: 'operates 14 depots',
      scope: 'company',
      topic: 'size',
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('CV-SENTINEL');
    expect(invoke).toHaveBeenNthCalledWith(4, 'company-evidence:cancel', { attemptId: 'a1' });
  });

  it('rebuilds a result from known fields and drops everything else', async () => {
    const api = await loadBridge();
    invoke.mockResolvedValue({ ok: true, view: { ...VIEW, extra: 'NOT-PASSED', facts: [{ ...FACT, injected: '<script>' }] }, notice: 'ok', secret: 'x' });
    const result = await api.get!({ attemptId: 'a1' });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('NOT-PASSED');
    expect(JSON.stringify(result)).not.toContain('<script>');
    expect(result.view.supportedCount).toBe(1);
  });

  it('fails closed: unknown statuses drop the fact, a malformed view refuses, and a rejection is never "supported"', async () => {
    const api = await loadBridge();
    invoke.mockResolvedValueOnce({ ok: true, view: { ...VIEW, facts: [{ ...FACT, support: 'definitely' }, { ...FACT, id: 'f2', verification: 'trusted' }, FACT] }, notice: '' });
    const filtered = await api.get!({ attemptId: 'a1' });
    expect(filtered.view.facts.map((fact: { id: string }) => fact.id)).toEqual(['f1']);

    invoke.mockResolvedValueOnce({ ok: true, view: { identity: 'nope' }, notice: '' });
    expect(await api.get!({ attemptId: 'a1' })).toMatchObject({ ok: false, code: 'invalid_response' });
    invoke.mockResolvedValueOnce('garbage');
    expect(await api.get!({ attemptId: 'a1' })).toMatchObject({ ok: false });
    invoke.mockResolvedValueOnce({ ok: false, code: 'busy', message: 'This company is already being researched.' });
    expect(await api.research!({ attemptId: 'a1' })).toEqual({ ok: false, code: 'busy', message: 'This company is already being researched.' });
  });

  it('only lets confirmed, current-shaped facts through the interview list', async () => {
    const api = await loadBridge();
    const good = {
      id: 'f1',
      claim: 'Northwind Freight operates 14 depots.',
      scope: 'company',
      topic: 'size',
      sourceUrl: 'https://northwind.example/about',
      observedAt: '2026-10-01T09:00:00.000Z',
      retrievedAt: '2026-10-01T09:00:00.000Z',
      expiresAt: '2026-12-30T09:00:00.000Z',
      verification: 'source_confirmed',
      viaLink: null,
    };
    invoke.mockResolvedValueOnce({ ok: true, facts: [good, { ...good, id: 'f2', verification: 'unverified' }, { ...good, id: 'f3', expiresAt: undefined }, 'x'] });
    expect((await api.prose!({ applicationId: 'p1' })).facts.map((fact: { id: string }) => fact.id)).toEqual(['f1']);
    expect(invoke).toHaveBeenCalledWith('company-evidence:prose', { applicationId: 'p1' });
    invoke.mockResolvedValueOnce({ ok: false, facts: [good] });
    expect(await api.prose!({ applicationId: 'p1' })).toEqual({ ok: false, facts: [] });
    expect(await (async () => { invoke.mockResolvedValueOnce(null); return api.cancel!({ attemptId: 'a1' }); })()).toEqual({ ok: false, cancelled: false });
  });
});
