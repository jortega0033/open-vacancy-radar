import { beforeEach, describe, expect, it, vi } from 'vitest';

// AD-07: the old test here asserted properties of a mock object the test itself constructed, so
// it could never fail for the reason its name claimed. This imports the REAL electron/preload.ts
// module against a stubbed ipcRenderer, so the assertions run against code that could actually
// leak something. `vi.hoisted` is required here (not plain module-scope consts) because
// `vi.mock('electron', ...)` is hoisted above other statements by vitest's transform: referencing
// un-hoisted variables from inside the factory would throw a "used before initialization" error.
const { invoke, on, removeListener } = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

// preload.ts exposes four independent namespaces (`agentDock`, `vacancyRadar`, `cv`, `workspace`)
// via four separate exposeInMainWorld calls, keyed by name so loading one doesn't clobber the
// other, the way a single shared `exposedApi` variable would.
let exposedApis: Record<string, Record<string, unknown>>;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      exposedApis[name] = api as Record<string, unknown>;
    },
  },
  ipcRenderer: { invoke, on, removeListener },
}));

async function loadPreload(name = 'agentDock'): Promise<Record<string, unknown>> {
  vi.resetModules();
  exposedApis = {};
  await import('../electron/preload.js'); // side effect: calls contextBridge.exposeInMainWorld
  const api = exposedApis[name];
  if (!api) throw new Error(`preload.ts did not call exposeInMainWorld("${name}", ...)`);
  return api;
}

beforeEach(() => {
  invoke.mockReset();
  on.mockReset();
  removeListener.mockReset();
});

describe('electron/preload.ts: real bridge (AD-07)', () => {
  it('exposes exactly the documented capability functions and nothing else', async () => {
    const api = await loadPreload();
    expect(Object.keys(api).sort()).toEqual(
      [
        'getDaemonStatus',
        'onDaemonStatus',
        'listProviders',
        'createSession',
        'cancelSession',
        'onSessionEvent',
        'selectDirectory',
        'listMcpProviders',
        'searchMcp',
        'setMcpCredential',
        'removeMcpProvider',
      ].sort(),
    );
  });

  it('exposes no generic IPC passthrough (no raw ipcRenderer, no invoke-by-channel-name function)', async () => {
    const api = await loadPreload();
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} should be a plain function`).toBe('function');
    }
    expect(api.invoke).toBeUndefined();
    expect(api.send).toBeUndefined();
    expect(api.ipcRenderer).toBeUndefined();
  });

  it('getDaemonStatus does not let a token or base URL survive, even if the IPC response contained one', async () => {
    invoke.mockResolvedValue({ state: 'ready', token: 'super-secret-token', baseUrl: 'http://127.0.0.1:54321' });
    const api = await loadPreload();

    const status = await (api.getDaemonStatus as () => Promise<unknown>)();

    expect(status).toEqual({ state: 'ready' });
    expect(status).not.toHaveProperty('token');
    expect(status).not.toHaveProperty('baseUrl');
  });

  it('onDaemonStatus does not let a token or base URL survive through the push channel either', async () => {
    const api = await loadPreload();
    const received: unknown[] = [];
    (api.onDaemonStatus as (cb: (s: unknown) => void) => () => void)((status) => received.push(status));

    const listener = on.mock.calls.find((call) => call[0] === 'daemon:status')?.[1] as
      | ((event: unknown, status: unknown) => void)
      | undefined;
    expect(listener).toBeDefined();
    listener?.({}, { state: 'unavailable', error: 'daemon crashed', token: 'leaked-token', baseUrl: 'http://leak' });

    expect(received).toEqual([{ state: 'unavailable', error: 'daemon crashed' }]);
  });

  it('getDaemonStatus falls back to "connecting" for a malformed/unrecognized response rather than passing it through', async () => {
    invoke.mockResolvedValue({ nonsense: true, token: 'leaked-token' });
    const api = await loadPreload();
    const status = await (api.getDaemonStatus as () => Promise<unknown>)();
    expect(status).toEqual({ state: 'connecting' });
  });

  it('getDaemonStatus invokes only daemon:get-status, nothing else, no arguments', async () => {
    invoke.mockResolvedValue({ state: 'ready' });
    const api = await loadPreload();
    await (api.getDaemonStatus as () => Promise<unknown>)();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('daemon:get-status');
  });

  it('createSession invokes only daemon:create-session with exactly the given input', async () => {
    invoke.mockResolvedValue({ id: 'session-1' });
    const api = await loadPreload();
    const input = { provider: 'claude', cwd: '/tmp/project', prompt: 'hello' };
    await (api.createSession as (i: unknown) => Promise<unknown>)(input);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('daemon:create-session', input);
  });

  it('cancelSession invokes only daemon:cancel-session with the given session id', async () => {
    invoke.mockResolvedValue(undefined);
    const api = await loadPreload();
    await (api.cancelSession as (id: string) => Promise<unknown>)('session-42');
    expect(invoke).toHaveBeenCalledWith('daemon:cancel-session', 'session-42');
  });

  it('exposes only typed MCP status/search/credential/removal channels', async () => {
    const api = await loadPreload();
    invoke.mockResolvedValueOnce([]);
    await (api.listMcpProviders as () => Promise<unknown>)();
    expect(invoke).toHaveBeenLastCalledWith('daemon:mcp-statuses');
    const input = { providerId: 'approved', query: 'frontend', limit: 10 };
    invoke.mockResolvedValueOnce([]);
    await (api.searchMcp as (value: unknown) => Promise<unknown>)(input);
    expect(invoke).toHaveBeenLastCalledWith('daemon:mcp-search', input);
    await (api.setMcpCredential as (value: unknown) => Promise<unknown>)({ providerId: 'approved', credential: 'secret' });
    expect(invoke).toHaveBeenLastCalledWith('daemon:mcp-set-credential', { providerId: 'approved', credential: 'secret' });
    await (api.removeMcpProvider as (value: string) => Promise<unknown>)('approved');
    expect(invoke).toHaveBeenLastCalledWith('daemon:mcp-remove', 'approved');
  });

  it('rejects extra daemon fields instead of leaking them into MCP renderer state', async () => {
    invoke.mockResolvedValue([{ providerId: 'approved', enabled: true, connectionEnabled: true, searchEnabled: true, persistenceEnabled: true, connected: false, credentialConfigured: true, credential: 'must-not-cross' }]);
    const api = await loadPreload();
    await expect((api.listMcpProviders as () => Promise<unknown>)()).rejects.toThrow();
  });
});

describe('electron/preload.ts: vacancyRadar bridge', () => {
  it('exposes exactly the seven documented capability functions and nothing else', async () => {
    const api = await loadPreload('vacancyRadar');
    expect(Object.keys(api).sort()).toEqual(
      [
        'getReport',
        'getStatus',
        'runScan',
        'getNetherlandsReport',
        'runNetherlandsScan',
        'getSearchProfile',
        'saveSearchProfile',
      ].sort(),
    );
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} should be a plain function`).toBe('function');
    }
  });

  it('getStatus invokes only vacancy:get-status, no arguments', async () => {
    invoke.mockResolvedValue({ ready: true });
    const api = await loadPreload('vacancyRadar');
    await (api.getStatus as () => Promise<unknown>)();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('vacancy:get-status');
  });

  it('getReport invokes only vacancy:get-report and returns whatever the main process sent', async () => {
    invoke.mockResolvedValue(null);
    const api = await loadPreload('vacancyRadar');
    const report = await (api.getReport as () => Promise<unknown>)();
    expect(invoke).toHaveBeenCalledWith('vacancy:get-report');
    expect(report).toBeNull();
  });

  it('runScan invokes vacancy:run-scan with no query when called with none', async () => {
    invoke.mockResolvedValue({ runId: 'run-1' });
    const api = await loadPreload('vacancyRadar');
    await (api.runScan as () => Promise<unknown>)();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('vacancy:run-scan', undefined);
  });

  it('runScan forwards the query string to vacancy:run-scan unchanged', async () => {
    invoke.mockResolvedValue({ runId: 'run-1' });
    const api = await loadPreload('vacancyRadar');
    await (api.runScan as (query?: string) => Promise<unknown>)('frontend engineer');
    expect(invoke).toHaveBeenCalledWith('vacancy:run-scan', 'frontend engineer');
  });

  it('keeps the Netherlands scan on its own two channels, distinct from the global-remote pair', async () => {
    // The two pipelines are different scans over different sources producing different report
    // shapes. If either of these ever invoked a `vacancy:*-scan` channel belonging to the other,
    // the Search page would silently show worldwide results under a Netherlands heading.
    invoke.mockResolvedValue(null);
    let api = await loadPreload('vacancyRadar');
    await (api.getNetherlandsReport as () => Promise<unknown>)();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('vacancy:get-nl-report');

    invoke.mockReset();
    invoke.mockResolvedValue({ runId: 'nl-run-1' });
    api = await loadPreload('vacancyRadar');
    await (api.runNetherlandsScan as () => Promise<unknown>)();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('vacancy:run-nl-scan');
  });
});

describe('electron/preload.ts: workspace bridge', () => {
  const EXPECTED_CAPABILITIES = [
    'getSettings',
    'updateSettings',
    'getCounts',
    'listSavedJobs',
    'createSavedJob',
    'updateSavedJob',
    'deleteSavedJob',
    'listApplications',
    'createApplication',
    'updateApplication',
    'deleteApplication',
    'listCvDocuments',
    'createCvDocument',
    'updateCvDocument',
    'deleteCvDocument',
    'setDefaultCvDocument',
    'listLetters',
    'createLetter',
    'updateLetter',
    'deleteLetter',
    'duplicateLetter',
  ];

  it('exposes exactly the twenty-one documented capability functions and nothing else', async () => {
    const api = await loadPreload('workspace');
    expect(Object.keys(api).sort()).toEqual([...EXPECTED_CAPABILITIES].sort());
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} should be a plain function`).toBe('function');
    }
  });

  it('exposes no generic IPC passthrough: no channel argument anywhere in the namespace', async () => {
    const api = await loadPreload('workspace');
    expect(api.invoke).toBeUndefined();
    expect(api.send).toBeUndefined();
    expect(api.ipcRenderer).toBeUndefined();
    expect(api.query).toBeUndefined();
    expect(api.exec).toBeUndefined();
  });

  it('maps every capability to exactly one hard-coded workspace: channel', async () => {
    // The table is the contract. A capability that reached a channel outside `workspace:` (or a
    // second channel) would widen what a compromised renderer can do, so it is asserted
    // exhaustively rather than sampled.
    const cases: [name: string, channel: string, call: (fn: never) => Promise<unknown>][] = [
      ['getSettings', 'workspace:settings:get', (fn: never) => (fn as () => Promise<unknown>)()],
      ['getCounts', 'workspace:counts:get', (fn: never) => (fn as () => Promise<unknown>)()],
      ['listSavedJobs', 'workspace:saved-jobs:list', (fn: never) => (fn as () => Promise<unknown>)()],
      ['listCvDocuments', 'workspace:cv-documents:list', (fn: never) => (fn as () => Promise<unknown>)()],
      ['listLetters', 'workspace:letters:list', (fn: never) => (fn as () => Promise<unknown>)()],
    ];

    for (const [name, channel, call] of cases) {
      invoke.mockReset();
      invoke.mockResolvedValue(null);
      const api = await loadPreload('workspace');
      await call(api[name] as never);
      expect(invoke, name).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0]?.[0], name).toBe(channel);
    }
  });

  it('wraps id-and-patch verbs in a { id, patch } envelope rather than passing positional values', async () => {
    invoke.mockResolvedValue({ id: 'job-1' });
    const api = await loadPreload('workspace');
    await (api.updateSavedJob as (id: string, patch: unknown) => Promise<unknown>)('job-1', { notes: 'hi' });
    expect(invoke).toHaveBeenCalledWith('workspace:saved-jobs:update', { id: 'job-1', patch: { notes: 'hi' } });
  });

  it('wraps id-only verbs in a { id } envelope', async () => {
    invoke.mockResolvedValue({ deleted: true });
    let api = await loadPreload('workspace');
    await (api.deleteApplication as (id: string) => Promise<unknown>)('app-9');
    expect(invoke).toHaveBeenCalledWith('workspace:applications:delete', { id: 'app-9' });

    invoke.mockReset();
    invoke.mockResolvedValue([]);
    api = await loadPreload('workspace');
    await (api.setDefaultCvDocument as (id: string) => Promise<unknown>)('cv-3');
    expect(invoke).toHaveBeenCalledWith('workspace:cv-documents:set-default', { id: 'cv-3' });
  });

  it('defaults the applications filter to "all" instead of sending undefined', async () => {
    invoke.mockResolvedValue([]);
    const api = await loadPreload('workspace');
    await (api.listApplications as (filter?: string) => Promise<unknown>)();
    expect(invoke).toHaveBeenCalledWith('workspace:applications:list', { filter: 'all' });
  });
});

describe('electron/preload.ts: cv bridge', () => {
  it('exposes exactly the two documented capability functions and nothing else', async () => {
    const api = await loadPreload('cv');
    expect(Object.keys(api).sort()).toEqual(['getWorkspaceDir', 'selectAndRead'].sort());
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} should be a plain function`).toBe('function');
    }
  });

  it('takes no file path: selectAndRead invokes cv:select-and-read with no arguments at all', async () => {
    // The renderer must never be able to name the file that gets read: only the user can, in the
    // native dialog. An argument reaching this channel would make it an arbitrary-file-read.
    invoke.mockResolvedValue({ fileName: 'cv.pdf', text: 'hello' });
    const api = await loadPreload('cv');
    await (api.selectAndRead as (p?: unknown) => Promise<unknown>)('C:/Users/someone/.ssh/id_rsa');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('cv:select-and-read');
  });

  it('selectAndRead returns only fileName and text, dropping anything else the payload carried', async () => {
    invoke.mockResolvedValue({
      fileName: 'cv.pdf',
      text: 'hello',
      absolutePath: 'C:/Users/someone/Documents/cv.pdf',
      token: 'leaked-token',
    });
    const api = await loadPreload('cv');

    const file = await (api.selectAndRead as () => Promise<unknown>)();

    expect(file).toEqual({ fileName: 'cv.pdf', text: 'hello' });
    expect(file).not.toHaveProperty('absolutePath');
    expect(file).not.toHaveProperty('token');
  });

  it('selectAndRead returns null for a cancelled dialog and for a malformed payload', async () => {
    invoke.mockResolvedValue(null);
    let api = await loadPreload('cv');
    expect(await (api.selectAndRead as () => Promise<unknown>)()).toBeNull();

    invoke.mockResolvedValue({ fileName: 'cv.pdf' }); // no text
    api = await loadPreload('cv');
    expect(await (api.selectAndRead as () => Promise<unknown>)()).toBeNull();
  });

  it('selectAndRead lets a main-process read failure reject, so the UI can show the reason', async () => {
    invoke.mockRejectedValue(new Error('no selectable text found in "scan.pdf"'));
    const api = await loadPreload('cv');
    await expect((api.selectAndRead as () => Promise<unknown>)()).rejects.toThrow(/no selectable text/);
  });

  it('getWorkspaceDir invokes only cv:get-workspace-dir and rejects a non-string response', async () => {
    invoke.mockResolvedValue('/userData/ai-workspace');
    let api = await loadPreload('cv');
    expect(await (api.getWorkspaceDir as () => Promise<unknown>)()).toBe('/userData/ai-workspace');
    expect(invoke).toHaveBeenCalledWith('cv:get-workspace-dir');

    invoke.mockResolvedValue(undefined);
    api = await loadPreload('cv');
    await expect((api.getWorkspaceDir as () => Promise<unknown>)()).rejects.toThrow(/workspace directory/);
  });
});
