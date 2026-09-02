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

// preload.ts exposes six independent namespaces (`agentDock`, `vacancyRadar`, `cv`, `workspace`,
// `system`, and ADI-06's `workspaceGrant`) via six separate exposeInMainWorld calls, keyed by name
// so loading one doesn't clobber the other, the way a single shared `exposedApi` variable would.
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

// Every test in this file calls loadPreload(), which does a real `vi.resetModules()` + dynamic
// `import()` per call -- slow enough under a loaded test run (many files, jsdom setup) to
// occasionally exceed vitest's default 5000ms per-test timeout on a busy machine. This is a
// mitigation, not a fix: the real cost is re-executing the whole preload module graph on every
// single test instead of once per describe block (each block only ever loads one fixed namespace).
// Raising the ceiling buys headroom now without masking a *correctness* regression -- a genuine
// hang would still fail, just after longer -- but it does make a genuine multiple-times-slower
// regression in loadPreload() itself harder to notice. Caching the load per describe block would
// remove the cost outright instead of raising the ceiling on it; left as a follow-up rather than
// done here, since it touches every test in this file for a performance win, not a correctness one.
vi.setConfig({ testTimeout: 15_000 });

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

describe('electron/preload.ts: system bridge', () => {
  it('exposes exactly the three documented capability functions and nothing else', async () => {
    const api = await loadPreload('system');
    expect(Object.keys(api).sort()).toEqual(['getAppVersion', 'saveFile', 'setLaunchAtLogin'].sort());
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} should be a plain function`).toBe('function');
    }
  });

  it('setLaunchAtLogin passes true through for the real enable case', async () => {
    invoke.mockResolvedValue(undefined);
    const api = await loadPreload('system');
    await (api.setLaunchAtLogin as (enabled: boolean) => Promise<void>)(true);
    expect(invoke).toHaveBeenCalledWith('system:set-login-item', true);
  });

  it('setLaunchAtLogin coerces a non-boolean argument to a real boolean before sending it over IPC', async () => {
    invoke.mockResolvedValue(undefined);
    const api = await loadPreload('system');
    await (api.setLaunchAtLogin as (enabled: unknown) => Promise<void>)('yes' as unknown as boolean);
    expect(invoke).toHaveBeenCalledWith('system:set-login-item', false);
  });

  it('getAppVersion invokes system:get-app-version with no arguments', async () => {
    invoke.mockResolvedValue('1.2.3');
    const api = await loadPreload('system');
    expect(await (api.getAppVersion as () => Promise<unknown>)()).toBe('1.2.3');
    expect(invoke).toHaveBeenCalledWith('system:get-app-version');
  });

  it('saveFile passes the input through to system:save-file', async () => {
    invoke.mockResolvedValue({ saved: true, path: 'C:/Users/someone/Downloads/report.pdf' });
    const api = await loadPreload('system');
    const input = { suggestedName: 'report.pdf', data: 'aGVsbG8=', encoding: 'base64', filters: [] };
    const result = await (api.saveFile as (input: unknown) => Promise<unknown>)(input);
    expect(invoke).toHaveBeenCalledWith('system:save-file', input);
    expect(result).toEqual({ saved: true, path: 'C:/Users/someone/Downloads/report.pdf' });
  });
});

/*
 * ---------------------------------------------------------------------------------------------
 * ADI-06: the workspaceGrant namespace, and proof the other five did not move.
 * ---------------------------------------------------------------------------------------------
 */

/**
 * The exact key sets the five pre-ADI-06 namespaces had, copied here as literals.
 *
 * Deliberately duplicated rather than derived from the module: a check that reads the current
 * surface and compares it to itself cannot fail. These literals are the record of what shipped
 * before this ticket, so widening any of the five (rather than adding the sixth) breaks a test.
 */
const PRE_ADI_06_NAMESPACES: Record<string, string[]> = {
  agentDock: [
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
  ],
  vacancyRadar: [
    'getReport',
    'getStatus',
    'runScan',
    'getNetherlandsReport',
    'runNetherlandsScan',
    'getSearchProfile',
    'saveSearchProfile',
  ],
  workspace: [
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
  ],
  cv: ['getWorkspaceDir', 'selectAndRead'],
  system: ['getAppVersion', 'saveFile', 'setLaunchAtLogin'],
};

describe('electron/preload.ts: ADI-06 did not widen any existing namespace', () => {
  it('leaves all five pre-existing namespaces key-for-key unchanged', async () => {
    for (const [namespace, keys] of Object.entries(PRE_ADI_06_NAMESPACES)) {
      const api = await loadPreload(namespace);
      expect(Object.keys(api).sort(), namespace).toEqual([...keys].sort());
    }
  });

  it('adds no workspace-grant capability to agentDock', async () => {
    // `selectDirectory` is the one pre-v2 bridge that returns a path, and it stays grandfathered
    // per ADI-07's framing. This asserts ADI-06 did not add a second path-bearing capability
    // beside it, and did not fold the grant surface into this namespace.
    const api = await loadPreload('agentDock');
    for (const key of Object.keys(api)) {
      expect(key).not.toMatch(/grant|trust/i);
    }
  });
});

describe('electron/preload.ts: workspaceGrant bridge (ADI-06, extended by ADI-13)', () => {
  it('exposes exactly the four documented capability functions and nothing else', async () => {
    // ADI-13 added `startSession` and nothing else. This list is the whole renderer-facing workspace
    // surface, and widening it is a deliberate act that has to touch this line.
    const api = await loadPreload('workspaceGrant');
    expect(Object.keys(api).sort()).toEqual(
      ['consumeGrant', 'getGrantStatus', 'requestGrant', 'startSession'].sort(),
    );
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} should be a plain function`).toBe('function');
    }
  });

  it('exposes no generic IPC passthrough and no trust-setting verb', async () => {
    const api = await loadPreload('workspaceGrant');
    expect(api.invoke).toBeUndefined();
    expect(api.send).toBeUndefined();
    expect(api.ipcRenderer).toBeUndefined();
    // D3: there is no renderer-facing way to set trust, and no daemon route that would accept one.
    expect(api.trust).toBeUndefined();
    expect(api.setTrusted).toBeUndefined();
    expect(api.inspect).toBeUndefined();
  });

  it('sends only a provider id, dropping a path a caller tried to smuggle alongside it', async () => {
    invoke.mockResolvedValue(null);
    const api = await loadPreload('workspaceGrant');

    await (api.requestGrant as (p: unknown) => Promise<unknown>)('claude');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('workspace-grant:request', { provider: 'claude' });

    // The renderer must never be able to name the folder: only the user can, in the native picker
    // main opens. This is the same property `cv.selectAndRead` is tested for.
    invoke.mockReset();
    invoke.mockResolvedValue(null);
    await (api.requestGrant as (p: unknown) => Promise<unknown>)({
      provider: 'claude',
      path: 'C:/Users/someone/.ssh',
      cwd: 'C:/Users/someone',
    });
    const sent = JSON.stringify(invoke.mock.calls[0]);
    expect(sent).not.toContain('.ssh');
    expect(sent).not.toContain('Users');
    expect(sent).not.toContain('cwd');
  });

  it('rebuilds the grant offer, dropping a path the IPC payload carried', async () => {
    invoke.mockResolvedValue({
      grantHandle: 'x'.repeat(43),
      display: { name: 'my-project', branch: 'main', dirty: true, effects: 'unbounded_cli' },
      // Everything a future main-process change might accidentally attach.
      canonicalPath: 'C:/Users/someone/my-project',
      workspaceId: 'a'.repeat(64),
      incarnation: 'b'.repeat(64),
      token: 'leaked-token',
    });
    const api = await loadPreload('workspaceGrant');

    const offer = await (api.requestGrant as (p: string) => Promise<unknown>)('claude');

    expect(offer).toEqual({
      grantHandle: 'x'.repeat(43),
      display: { name: 'my-project', branch: 'main', dirty: true, effects: 'unbounded_cli' },
    });
    const serialized = JSON.stringify(offer);
    expect(serialized).not.toContain('canonicalPath');
    expect(serialized).not.toContain('Users');
    expect(serialized).not.toContain('a'.repeat(64));
    expect(serialized).not.toContain('b'.repeat(64));
    expect(serialized).not.toContain('leaked-token');
  });

  it('never echoes an effects value main sent: the literal is what this build can describe', async () => {
    invoke.mockResolvedValue({
      grantHandle: 'x'.repeat(43),
      display: { name: 'my-project', dirty: false, effects: 'read_only' },
    });
    const api = await loadPreload('workspaceGrant');
    const offer = (await (api.requestGrant as (p: string) => Promise<unknown>)('claude')) as {
      display: { effects: string };
    };
    // A narrowed effects claim reaching the UI would be exactly the false statement D4 exists to
    // prevent, so it is replaced, not passed through.
    expect(offer.display.effects).toBe('unbounded_cli');
  });

  it('returns null for a cancelled request and for a malformed payload', async () => {
    for (const payload of [null, undefined, {}, { grantHandle: 42 }, { grantHandle: 'x', display: 1 }]) {
      invoke.mockResolvedValue(payload);
      const api = await loadPreload('workspaceGrant');
      expect(await (api.requestGrant as (p: string) => Promise<unknown>)('claude')).toBeNull();
    }
  });

  it('sends the grant handle and nothing else when consuming', async () => {
    invoke.mockResolvedValue({ ok: true });
    const api = await loadPreload('workspaceGrant');
    const result = await (api.consumeGrant as (h: string) => Promise<unknown>)('y'.repeat(43));
    expect(invoke).toHaveBeenCalledWith('workspace-grant:consume', { grantHandle: 'y'.repeat(43) });
    expect(result).toEqual({ ok: true });
  });

  it('coerces a non-string handle to an empty one rather than forwarding an object', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'unknown_handle' });
    const api = await loadPreload('workspaceGrant');
    await (api.consumeGrant as (h: unknown) => Promise<unknown>)({
      toString: () => 'C:/Users/someone',
    });
    expect(invoke).toHaveBeenCalledWith('workspace-grant:consume', { grantHandle: '' });
  });

  it('rebuilds the consume result, so only ok and a reason string can cross', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'identity_drift', path: 'C:/Users/someone' });
    const api = await loadPreload('workspaceGrant');
    const result = await (api.consumeGrant as (h: string) => Promise<unknown>)('y'.repeat(43));
    expect(result).toEqual({ ok: false, reason: 'identity_drift' });
  });

  it('treats an unrecognized consume response as a refusal, never as a success', async () => {
    for (const payload of [null, undefined, {}, { ok: 'yes' }, 'ok']) {
      invoke.mockResolvedValue(payload);
      const api = await loadPreload('workspaceGrant');
      const result = await (api.consumeGrant as (h: string) => Promise<unknown>)('y'.repeat(43));
      expect(result).toEqual({ ok: false, reason: 'unknown_handle' });
    }
  });

  it('rebuilds the grant status, and reports "gone" for anything it does not recognize', async () => {
    invoke.mockResolvedValue({ state: 'active', expiresInMs: 1234, canonicalPath: 'C:/secret' });
    let api = await loadPreload('workspaceGrant');
    expect(await (api.getGrantStatus as (h: string) => Promise<unknown>)('z'.repeat(43))).toEqual({
      state: 'active',
      expiresInMs: 1234,
    });
    expect(invoke).toHaveBeenCalledWith('workspace-grant:status', { grantHandle: 'z'.repeat(43) });

    invoke.mockResolvedValue({ state: 'gone', reason: 'timeout' });
    api = await loadPreload('workspaceGrant');
    expect(await (api.getGrantStatus as (h: string) => Promise<unknown>)('z'.repeat(43))).toEqual({
      state: 'gone',
      reason: 'timeout',
    });

    invoke.mockResolvedValue({ nonsense: true });
    api = await loadPreload('workspaceGrant');
    expect(await (api.getGrantStatus as (h: string) => Promise<unknown>)('z'.repeat(43))).toEqual({
      state: 'gone',
      reason: 'unknown_handle',
    });
  });

  it('maps every capability to exactly one hard-coded channel', async () => {
    const cases: [name: string, channel: string][] = [
      ['requestGrant', 'workspace-grant:request'],
      ['consumeGrant', 'workspace-grant:consume'],
      ['getGrantStatus', 'workspace-grant:status'],
      ['startSession', 'workspace:start-session'],
    ];
    for (const [name, channel] of cases) {
      invoke.mockReset();
      invoke.mockResolvedValue(null);
      const api = await loadPreload('workspaceGrant');
      await (api[name] as (arg: unknown) => Promise<unknown>)('claude');
      expect(invoke, name).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0]?.[0], name).toBe(channel);
    }
  });

  it('passes a workspace session ref back from a successful consumption, and nothing else', async () => {
    invoke.mockResolvedValue({
      ok: true,
      workspaceSessionRef: 'r'.repeat(43),
      // What a future main-process change might accidentally attach to a success payload.
      canonicalPath: 'C:/Users/someone/my-project',
      workspaceId: 'a'.repeat(64),
    });
    const api = await loadPreload('workspaceGrant');

    const result = await (api.consumeGrant as (h: string) => Promise<unknown>)('y'.repeat(43));

    expect(result).toEqual({ ok: true, workspaceSessionRef: 'r'.repeat(43) });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Users');
    expect(serialized).not.toContain('a'.repeat(64));
  });
});

/*
 * ---------------------------------------------------------------------------------------------
 * ADI-13: workspaceGrant.startSession.
 * ---------------------------------------------------------------------------------------------
 */

describe('electron/preload.ts: workspaceGrant.startSession (ADI-13)', () => {
  it('forwards only the four documented fields, dropping any location a caller attached', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'unknown_workspace_ref' });
    const api = await loadPreload('workspaceGrant');

    await (api.startSession as (input: unknown) => Promise<unknown>)({
      workspaceSessionRef: 'r'.repeat(43),
      prompt: 'summarize the repo',
      // Everything a renderer might try to smuggle. None of these has a reader in the bridge.
      cwd: 'C:/Users/someone/.ssh',
      path: 'C:/Users/someone',
      workspaceId: 'a'.repeat(64),
      incarnation: 'b'.repeat(64),
    });

    expect(invoke).toHaveBeenCalledWith('workspace:start-session', {
      workspaceSessionRef: 'r'.repeat(43),
      prompt: 'summarize the repo',
    });
    const sent = JSON.stringify(invoke.mock.calls[0]);
    expect(sent).not.toContain('Users');
    expect(sent).not.toContain('cwd');
    expect(sent).not.toContain('a'.repeat(64));
    expect(sent).not.toContain('b'.repeat(64));
  });

  it('coerces a non-string ref and prompt rather than forwarding an object', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'invalid_request' });
    const api = await loadPreload('workspaceGrant');

    await (api.startSession as (input: unknown) => Promise<unknown>)({
      workspaceSessionRef: { toString: () => 'C:/Users/someone' },
      prompt: { toString: () => 'C:/Users/someone' },
    });

    expect(invoke).toHaveBeenCalledWith('workspace:start-session', {
      workspaceSessionRef: '',
      prompt: '',
    });
  });

  it('forwards a resume target and a capability list when they are well-shaped', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'refused' });
    const api = await loadPreload('workspaceGrant');

    await (api.startSession as (input: unknown) => Promise<unknown>)({
      workspaceSessionRef: 'r'.repeat(43),
      prompt: 'continue',
      resumeProviderSessionId: 'thread-1',
      capabilities: [{ id: 'ext.open_vacancy_radar.model_select', constraints: {} }],
    });

    expect(invoke.mock.calls[0]?.[1]).toEqual({
      workspaceSessionRef: 'r'.repeat(43),
      prompt: 'continue',
      resumeProviderSessionId: 'thread-1',
      capabilities: [{ id: 'ext.open_vacancy_radar.model_select', constraints: {} }],
    });
  });

  it('rebuilds the started session, so a cwd in the payload cannot cross', async () => {
    invoke.mockResolvedValue({
      ok: true,
      session: {
        sessionId: '11111111-2222-4333-8444-555555555555',
        provider: 'claude',
        status: 'starting',
        model: 'opus',
        // The daemon's own v2 view carries this. Main strips it; this is the second place that must.
        cwd: 'C:/Users/someone/my-project',
        rootSessionId: '11111111-2222-4333-8444-555555555555',
      },
    });
    const api = await loadPreload('workspaceGrant');

    const result = await (api.startSession as (input: unknown) => Promise<unknown>)({
      workspaceSessionRef: 'r'.repeat(43),
      prompt: 'go',
    });

    expect(result).toEqual({
      ok: true,
      session: {
        sessionId: '11111111-2222-4333-8444-555555555555',
        provider: 'claude',
        status: 'starting',
        model: 'opus',
      },
    });
    expect(JSON.stringify(result)).not.toContain('Users');
    expect(JSON.stringify(result)).not.toContain('cwd');
  });

  it('treats an unrecognized response as a refusal, never as a success', async () => {
    for (const payload of [null, undefined, {}, { ok: 'yes' }, { ok: true }, { ok: true, session: {} }, 'ok']) {
      invoke.mockResolvedValue(payload);
      const api = await loadPreload('workspaceGrant');
      const result = await (api.startSession as (input: unknown) => Promise<unknown>)({
        workspaceSessionRef: 'r'.repeat(43),
        prompt: 'go',
      });
      expect(result).toEqual({ ok: false, reason: 'refused' });
    }
  });

  it('passes a refusal reason through as a bare string', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'workspace_lease_conflict', path: 'C:/Users/someone' });
    const api = await loadPreload('workspaceGrant');
    const result = await (api.startSession as (input: unknown) => Promise<unknown>)({
      workspaceSessionRef: 'r'.repeat(43),
      prompt: 'go',
    });
    expect(result).toEqual({ ok: false, reason: 'workspace_lease_conflict' });
  });
});
