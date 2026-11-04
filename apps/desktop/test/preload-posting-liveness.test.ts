import { beforeEach, describe, expect, it, vi } from 'vitest';

// #720: the search-result liveness bridge. Imports the REAL preload against a stubbed ipcRenderer, the
// same way `preload.test.ts` does, and pins the fail-closed parsing: an unknown or mismatched answer is
// "not checked yet", never open or closed, and open/closed without a real check time is not believed.

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
let exposed: Record<string, Record<string, unknown>>;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      exposed[name] = api as Record<string, unknown>;
    },
  },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
}));

async function pipelineBridge() {
  vi.resetModules();
  exposed = {};
  await import('../electron/preload.js');
  return exposed.applicationPipeline as {
    postingLiveness(keys: string[]): Promise<unknown[]>;
    checkPostingLiveness(key: string): Promise<Record<string, unknown>>;
  };
}

const OPEN = {
  vacancyKey: 'vac-1',
  state: 'open',
  checkedAt: '2026-10-30T09:00:00.000Z',
  source: 'ashby',
  sourceRef: 'api.ashbyhq.com/posting-api/job-board/{board}',
  reason: 'verified_open',
  checkable: true,
};

beforeEach(() => invoke.mockReset());

describe('applicationPipeline posting liveness (#720)', () => {
  it('reads through a fixed channel carrying only vacancy keys', async () => {
    const bridge = await pipelineBridge();
    invoke.mockResolvedValueOnce([OPEN]);
    expect(await bridge.postingLiveness(['vac-1'])).toEqual([OPEN]);
    expect(invoke).toHaveBeenCalledWith('application-pipeline:posting-liveness', { vacancyKeys: ['vac-1'] });
  });

  it('checks one result through a fixed channel carrying only its key', async () => {
    const bridge = await pipelineBridge();
    invoke.mockResolvedValueOnce({ ...OPEN, state: 'closed', reason: 'not_listed', extra: 'dropped' });
    expect(await bridge.checkPostingLiveness('vac-1')).toEqual({ ...OPEN, state: 'closed', reason: 'not_listed' });
    expect(invoke).toHaveBeenCalledWith('application-pipeline:check-posting-liveness', { vacancyKey: 'vac-1' });
  });

  it('fails closed: unknown states, other keys and open/closed without a real time read "not checked yet"', async () => {
    const bridge = await pipelineBridge();
    for (const answer of [
      { ...OPEN, state: 'probably_open' },
      { ...OPEN, vacancyKey: 'someone-else' },
      { ...OPEN, checkedAt: null },
      { ...OPEN, state: 'closed', checkedAt: 'yesterday' },
      'nonsense',
      null,
    ]) {
      invoke.mockResolvedValueOnce(answer);
      expect(await bridge.checkPostingLiveness('vac-1'), JSON.stringify(answer)).toMatchObject({
        vacancyKey: 'vac-1',
        state: 'not_checked',
        checkedAt: null,
        checkable: false,
      });
    }
  });

  it('drops read answers for keys it did not ask about', async () => {
    const bridge = await pipelineBridge();
    invoke.mockResolvedValueOnce([OPEN, { ...OPEN, vacancyKey: 'vac-9' }]);
    expect(await bridge.postingLiveness(['vac-1'])).toEqual([OPEN]);
    invoke.mockResolvedValueOnce({ not: 'an array' });
    expect(await bridge.postingLiveness(['vac-1'])).toEqual([]);
  });
});
