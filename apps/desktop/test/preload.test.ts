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
  it('exposes exactly the ten documented capability functions and nothing else', async () => {
    const api = await loadPreload('vacancyRadar');
    expect(Object.keys(api).sort()).toEqual(
      [
        'getReport',
        'getReportSummary',
        'getStatus',
        'runScan',
        'getScanStatus',
        'onScanProgress',
        'getSearchProfile',
        'saveSearchProfile',
        'getAtsRosterStatus',
        'refreshAtsRoster',
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

  it('getReportSummary invokes only vacancy:get-report-summary and returns whatever the main process sent', async () => {
    invoke.mockResolvedValue({ runId: 'run-1', generatedAt: '2026-09-11T12:00:00.000Z', vacancyCount: 20_000 });
    const api = await loadPreload('vacancyRadar');
    const summary = await (api.getReportSummary as () => Promise<unknown>)();
    expect(invoke).toHaveBeenCalledWith('vacancy:get-report-summary');
    expect(summary).toEqual({ runId: 'run-1', generatedAt: '2026-09-11T12:00:00.000Z', vacancyCount: 20_000 });
  });

  it('runScan forwards blank input to main so the scan guard can reject it before discovery', async () => {
    invoke.mockResolvedValue({ runId: 'run-1' });
    const api = await loadPreload('vacancyRadar');
    await (api.runScan as (query: string) => Promise<unknown>)('   ');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('vacancy:run-scan', '   ');
  });

  it('getScanStatus invokes only vacancy:get-scan-status, no arguments', async () => {
    invoke.mockResolvedValue({ scanning: true });
    const api = await loadPreload('vacancyRadar');
    const status = await (api.getScanStatus as () => Promise<{ scanning: boolean }>)();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('vacancy:get-scan-status');
    expect(status).toEqual({ scanning: true });
  });

  it('runScan forwards the query string to vacancy:run-scan unchanged', async () => {
    invoke.mockResolvedValue({ runId: 'run-1' });
    const api = await loadPreload('vacancyRadar');
    await (api.runScan as (query: string) => Promise<unknown>)('frontend engineer');
    expect(invoke).toHaveBeenCalledWith('vacancy:run-scan', 'frontend engineer');
  });

  it('onScanProgress subscribes to vacancy:scan-progress and forwards a well-formed payload', async () => {
    const api = await loadPreload('vacancyRadar');
    const received: unknown[] = [];
    (api.onScanProgress as (cb: (event: unknown) => void) => () => void)((event) => received.push(event));

    const listener = on.mock.calls.find((call) => call[0] === 'vacancy:scan-progress')?.[1] as
      | ((event: unknown, payload: unknown) => void)
      | undefined;
    expect(listener).toBeDefined();
    const vacancies = [{ key: 'himalayas:1', title: 'Frontend Engineer' }];
    listener?.({}, { sourceId: 'himalayas', vacancies });

    expect(received).toEqual([{ sourceId: 'himalayas', vacancies }]);
  });

  it('onScanProgress drops a malformed payload instead of forwarding it', async () => {
    const api = await loadPreload('vacancyRadar');
    const received: unknown[] = [];
    (api.onScanProgress as (cb: (event: unknown) => void) => () => void)((event) => received.push(event));

    const listener = on.mock.calls.find((call) => call[0] === 'vacancy:scan-progress')?.[1] as
      | ((event: unknown, payload: unknown) => void)
      | undefined;
    listener?.({}, { sourceId: 'himalayas' }); // vacancies missing
    listener?.({}, { vacancies: [] }); // sourceId missing
    listener?.({}, null);

    expect(received).toEqual([]);
  });

  it('onScanProgress returns an unsubscribe function that removes exactly its own listener', async () => {
    const api = await loadPreload('vacancyRadar');
    const unsubscribe = (api.onScanProgress as (cb: (event: unknown) => void) => () => void)(() => {});

    const listener = on.mock.calls.find((call) => call[0] === 'vacancy:scan-progress')?.[1];
    unsubscribe();

    expect(removeListener).toHaveBeenCalledWith('vacancy:scan-progress', listener);
  });

  it('getAtsRosterStatus invokes only vacancy:ats-roster:get-status, no arguments', async () => {
    invoke.mockResolvedValue(null);
    const api = await loadPreload('vacancyRadar');
    const status = await (api.getAtsRosterStatus as () => Promise<unknown>)();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('vacancy:ats-roster:get-status');
    expect(status).toBeNull();
  });

  it('refreshAtsRoster invokes only vacancy:ats-roster:refresh, no arguments, and returns whatever main sent', async () => {
    const result = { file: 'ats-roster-v1.json', importedAt: '2026-09-11T00:00:00.000Z', totalEntries: 3, providers: [] };
    invoke.mockResolvedValue(result);
    const api = await loadPreload('vacancyRadar');
    const received = await (api.refreshAtsRoster as () => Promise<unknown>)();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('vacancy:ats-roster:refresh');
    expect(received).toEqual(result);
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
    'exportCvDocument',
    'listLetters',
    'createLetter',
    'updateLetter',
    'deleteLetter',
    'duplicateLetter',
    'listApplicationAttempts',
    'getApplicationAttempt',
    'updateApplicationAttempt',
    'listApplicationArtifacts',
    'listAutomationGrants',
    'revokeAutomationGrant',
  ];

  it('exposes exactly the twenty-eight documented capability functions and nothing else', async () => {
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
      ['listApplicationAttempts', 'workspace:application-attempts:list', (fn: never) => (fn as () => Promise<unknown>)()],
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

  it('exportCvDocument (#156) sends an { id, format } envelope to workspace:cv-documents:export', async () => {
    invoke.mockResolvedValue({ saved: true, path: 'C:/Users/someone/Downloads/resume.pdf' });
    const api = await loadPreload('workspace');
    const result = await (api.exportCvDocument as (id: string, format: string) => Promise<unknown>)('cv-1', 'pdf');
    expect(invoke).toHaveBeenCalledWith('workspace:cv-documents:export', { id: 'cv-1', format: 'pdf' });
    expect(result).toEqual({ saved: true, path: 'C:/Users/someone/Downloads/resume.pdf' });

    invoke.mockReset();
    invoke.mockResolvedValue({ saved: false });
    const api2 = await loadPreload('workspace');
    await (api2.exportCvDocument as (id: string, format: string) => Promise<unknown>)('cv-2', 'docx');
    expect(invoke).toHaveBeenCalledWith('workspace:cv-documents:export', { id: 'cv-2', format: 'docx' });
  });

  it('defaults the applications filter to "all" instead of sending undefined', async () => {
    invoke.mockResolvedValue([]);
    const api = await loadPreload('workspace');
    await (api.listApplications as (filter?: string) => Promise<unknown>)();
    expect(invoke).toHaveBeenCalledWith('workspace:applications:list', { filter: 'all' });
  });

  it('application attempt/artifact capabilities (#202): id, id+patch, and attemptId envelopes', async () => {
    invoke.mockResolvedValue({ id: 'attempt-1' });
    let api = await loadPreload('workspace');
    await (api.getApplicationAttempt as (id: string) => Promise<unknown>)('attempt-1');
    expect(invoke).toHaveBeenCalledWith('workspace:application-attempts:get', { id: 'attempt-1' });

    invoke.mockReset();
    invoke.mockResolvedValue({ id: 'attempt-1', checkpoint: 'needs_user' });
    api = await loadPreload('workspace');
    await (api.updateApplicationAttempt as (id: string, patch: unknown) => Promise<unknown>)('attempt-1', {
      checkpoint: 'needs_user',
    });
    expect(invoke).toHaveBeenCalledWith('workspace:application-attempts:update', {
      id: 'attempt-1',
      patch: { checkpoint: 'needs_user' },
    });

    invoke.mockReset();
    invoke.mockResolvedValue([]);
    api = await loadPreload('workspace');
    await (api.listApplicationArtifacts as (attemptId: string) => Promise<unknown>)('attempt-1');
    expect(invoke).toHaveBeenCalledWith('workspace:application-artifacts:list', { attemptId: 'attempt-1' });
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
  // Added by issue #252, same reasoning as `workspace`'s own #202/#203 comment below:
  // `onScanProgress` is a legitimate widening of this namespace for progressive search results,
  // not something ADI-06/07 touched, so the literal grows here rather than blocking real growth.
  //
  // `getAtsRosterStatus`/`refreshAtsRoster` added wiring up issue #251/#264's ATS-roster import
  // trigger (the manual "Refresh company roster" Settings action), same reasoning again.
  // `getReportSummary` is a cheap metadata read for foreground resume: Search can avoid pulling
  // a 20k-row report over IPC when the stored report has not changed.
  vacancyRadar: [
    'getReport',
    'getReportSummary',
    'getStatus',
    'runScan',
    'getScanStatus',
    'onScanProgress',
    'getSearchProfile',
    'saveSearchProfile',
    'getAtsRosterStatus',
    'refreshAtsRoster',
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
    // Added by issue #156, same reasoning as #202/#203 below: `workspace` legitimately grows here
    // (a manual CV export action, alongside the CV library verbs it belongs next to), so the
    // literal is updated rather than left blocking real growth.
    'exportCvDocument',
    'listLetters',
    'createLetter',
    'updateLetter',
    'deleteLetter',
    'duplicateLetter',
    // Added by issue #202, unrelated to ADI-06/07's own scope-boundary concern (whether *those*
    // tickets leaked capability into the wrong namespace) -- `workspace` legitimately grows here,
    // so the literal below is updated rather than left blocking real growth.
    'listApplicationAttempts',
    'getApplicationAttempt',
    'updateApplicationAttempt',
    'listApplicationArtifacts',
    // Added by issue #203, same reasoning: read/revoke-only automation-grant access legitimately
    // belongs on this namespace (creating a grant is deliberately NOT here -- see
    // WorkspaceBridge's own comment on why that needs a native dialog instead).
    'listAutomationGrants',
    'revokeAutomationGrant',
  ],
  cv: ['getWorkspaceDir', 'selectAndRead'],
  system: ['getAppVersion', 'saveFile', 'setLaunchAtLogin'],
};

describe('electron/preload.ts: ADI-06 and ADI-07 did not widen any existing namespace', () => {
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

/*
 * ---------------------------------------------------------------------------------------------
 * ADI-07: the agentWorkspace namespace, the seventh.
 * ---------------------------------------------------------------------------------------------
 */

const V2_SESSION_ID = '11111111-2222-4333-8444-555555555555';

describe('electron/preload.ts: agentWorkspace bridge (ADI-07)', () => {
  it('exposes exactly the six documented capability functions and nothing else', async () => {
    const api = await loadPreload('agentWorkspace');
    expect(Object.keys(api).sort()).toEqual(
      ['listSessions', 'getSession', 'getSessionEvents', 'attachActivity', 'detachActivity', 'onActivity'].sort(),
    );
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} should be a plain function`).toBe('function');
    }
  });

  it('exposes no generic IPC passthrough, no cancel verb, and no way to name a folder', async () => {
    const api = await loadPreload('agentWorkspace');
    expect(api.invoke).toBeUndefined();
    expect(api.send).toBeUndefined();
    expect(api.ipcRenderer).toBeUndefined();
    // Cancelling goes through v1's existing `agentDock.cancelSession`; a second verb here would be
    // a second thing to keep in agreement with it for no capability gained.
    expect(api.cancel).toBeUndefined();
    expect(api.cancelSession).toBeUndefined();
    expect(api.selectDirectory).toBeUndefined();
    expect(api.getWorkspaceDir).toBeUndefined();
  });

  it('maps every capability to exactly one hard-coded agent-workspace: channel', async () => {
    const cases: [name: string, channel: string, call: (fn: never) => Promise<unknown>][] = [
      ['listSessions', 'agent-workspace:list', (fn: never) => (fn as () => Promise<unknown>)()],
      ['getSession', 'agent-workspace:get', (fn: never) => (fn as (i: string) => Promise<unknown>)(V2_SESSION_ID)],
      [
        'getSessionEvents',
        'agent-workspace:events',
        (fn: never) => (fn as (i: string) => Promise<unknown>)(V2_SESSION_ID),
      ],
      [
        'attachActivity',
        'agent-workspace:attach',
        (fn: never) => (fn as (i: string) => Promise<unknown>)(V2_SESSION_ID),
      ],
      [
        'detachActivity',
        'agent-workspace:detach',
        (fn: never) => (fn as (i: string) => Promise<unknown>)(V2_SESSION_ID),
      ],
    ];
    for (const [name, channel, call] of cases) {
      invoke.mockReset();
      invoke.mockResolvedValue(null);
      const api = await loadPreload('agentWorkspace');
      await call(api[name] as never);
      expect(invoke, name).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0]?.[0], name).toBe(channel);
    }
  });

  it('sends only paging fields, dropping a location a caller tried to smuggle alongside them', async () => {
    invoke.mockResolvedValue(null);
    const api = await loadPreload('agentWorkspace');

    await (api.listSessions as (p: unknown) => Promise<unknown>)({
      cursor: 'abc',
      limit: 10,
      cwd: 'C:/Users/someone/.ssh',
      path: '/etc/passwd',
      workspaceId: 'a'.repeat(64),
      provider: 'claude',
    });

    expect(invoke).toHaveBeenCalledWith('agent-workspace:list', { cursor: 'abc', limit: 10 });
    const sent = JSON.stringify(invoke.mock.calls[0]);
    expect(sent).not.toContain('Users');
    expect(sent).not.toContain('cwd');
    expect(sent).not.toContain('a'.repeat(64));
  });

  it('coerces a non-string session id to an empty one rather than forwarding an object', async () => {
    invoke.mockResolvedValue(null);
    const api = await loadPreload('agentWorkspace');
    await (api.getSession as (i: unknown) => Promise<unknown>)({ toString: () => 'C:/Users/someone' });
    expect(invoke).toHaveBeenCalledWith('agent-workspace:get', { sessionId: '' });
  });

  it('sends lastSeq only when it is a real index', async () => {
    const cases: Array<[unknown, Record<string, unknown>]> = [
      [0, { sessionId: V2_SESSION_ID, lastSeq: 0 }],
      [7, { sessionId: V2_SESSION_ID, lastSeq: 7 }],
      [-1, { sessionId: V2_SESSION_ID }],
      [1.5, { sessionId: V2_SESSION_ID }],
      ['3', { sessionId: V2_SESSION_ID }],
      [undefined, { sessionId: V2_SESSION_ID }],
    ];
    for (const [lastSeq, expected] of cases) {
      invoke.mockReset();
      invoke.mockResolvedValue({ ok: true });
      const api = await loadPreload('agentWorkspace');
      await (api.attachActivity as (i: string, s?: unknown) => Promise<unknown>)(V2_SESSION_ID, lastSeq);
      expect(invoke, String(lastSeq)).toHaveBeenCalledWith('agent-workspace:attach', expected);
    }
  });

  it('rebuilds a session summary independently, so a cwd main sent still cannot cross', async () => {
    // The second of the two rebuilds. Main already dropped these in agent-workspace-view.ts; this
    // is the assumption that main might one day be wrong.
    invoke.mockResolvedValue({
      sessions: [
        {
          id: 'ses-1',
          provider: 'claude',
          protocolVersion: 1,
          transportId: 'legacy-one-shot',
          status: 'running',
          acceptedWork: 'prompt',
          rootSessionId: 'ses-1',
          continuationKind: 'fresh',
          startedAt: 't',
          earliestSequence: 0,
          eventCount: 1,
          eventsTruncated: false,
          unknownFrameCount: 0,
          scope: {
            authenticated: 'authenticated',
            platform: 'win32',
            accountEvidence: 'cli_owned',
            executablePath: 'C:/Users/someone/npm/claude.cmd',
          },
          cwd: 'C:/Users/someone/my-project',
          providerSessionId: 'native-thread-abc',
        },
      ],
      capacity: { global: { active: 1, limit: 4 }, provider: { active: 1, limit: 2 } },
    });
    const api = await loadPreload('agentWorkspace');

    const page = (await (api.listSessions as () => Promise<unknown>)()) as {
      sessions: Array<Record<string, unknown>>;
    };

    expect(page.sessions[0]).not.toHaveProperty('cwd');
    expect(page.sessions[0]).not.toHaveProperty('providerSessionId');
    expect(page.sessions[0]?.scope).not.toHaveProperty('executablePath');
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('Users');
    expect(serialized).not.toContain('my-project');
    expect(serialized).not.toContain('native-thread-abc');
  });

  it('never echoes an accountEvidence value main sent', async () => {
    invoke.mockResolvedValue({
      id: 'ses-1',
      scope: { authenticated: 'a', platform: 'p', accountEvidence: 'verified_account' },
    });
    const api = await loadPreload('agentWorkspace');
    const summary = (await (api.getSession as (i: string) => Promise<unknown>)('ses-1')) as {
      scope: { accountEvidence: string };
    };
    expect(summary.scope.accountEvidence).toBe('cli_owned');
  });

  it('drops a session summary it cannot even name, rather than rendering a nameless row', async () => {
    invoke.mockResolvedValue({ sessions: [{ provider: 'claude' }, null, 'x', { id: '' }], capacity: {} });
    const api = await loadPreload('agentWorkspace');
    const page = (await (api.listSessions as () => Promise<unknown>)()) as { sessions: unknown[] };
    expect(page.sessions).toEqual([]);
    expect(await (api.getSession as (i: string) => Promise<unknown>)('x')).toBeNull();
  });

  it('rebuilds an activity entry per kind, dropping identifiers and prose main should have removed', async () => {
    invoke.mockResolvedValue({
      sessionId: 'ses-1',
      events: [
        {
          seq: 0,
          at: 't',
          origin: 'live',
          kind: 'tool.completed',
          toolName: 'Bash',
          toolAlias: 't1',
          // What a future main-process change might accidentally leave on the payload.
          toolCallId: 'native-call-1',
          providerSessionId: 'native-thread-abc',
          cwd: 'C:/Users/someone',
          detail: 'reading C:/Users/someone/.ssh',
        },
        { seq: 1, at: 't', kind: 'error', code: 'read C:/Users/someone failed', recoverable: false },
        { seq: 2, at: 't', kind: 'something.new' },
        { seq: -1, at: 't', kind: 'status', status: 'x' },
      ],
    });
    const api = await loadPreload('agentWorkspace');

    const page = (await (api.getSessionEvents as (i: string) => Promise<unknown>)('ses-1')) as {
      events: Array<Record<string, unknown>>;
    };

    // The unknown kind and the unorderable seq are dropped, fail-closed.
    expect(page.events).toHaveLength(2);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('native-call-1');
    expect(serialized).not.toContain('native-thread-abc');
    expect(serialized).not.toContain('Users');
    expect(page.events[0]).not.toHaveProperty('toolCallId');
    expect(page.events[0]).not.toHaveProperty('detail');
    // A code that is not already a clean identifier has no row to select in the copy table.
    expect(page.events[1]).not.toHaveProperty('code');
  });

  it('asserts history origin rather than reading it, so a mislabelled entry cannot win the merge', async () => {
    // A digest-only entry claiming `origin: 'live'` would displace real prose in the timeline
    // merge. A page's origin is a fact about which route answered, not about the payload.
    invoke.mockResolvedValue({
      sessionId: 'ses-1',
      events: [{ seq: 0, at: 't', origin: 'live', kind: 'assistant.message', text: 'not from history' }],
    });
    const api = await loadPreload('agentWorkspace');
    const page = (await (api.getSessionEvents as (i: string) => Promise<unknown>)('ses-1')) as {
      events: Array<{ origin: string }>;
    };
    expect(page.events[0]?.origin).toBe('history');
  });

  it('treats an unrecognized attach response as a refusal, never as a live attachment', async () => {
    for (const payload of [null, undefined, {}, { ok: 'yes' }, 'ok', { ok: false, reason: 'invented' }]) {
      invoke.mockResolvedValue(payload);
      const api = await loadPreload('agentWorkspace');
      const result = await (api.attachActivity as (i: string) => Promise<unknown>)('ses-1');
      expect(result).toEqual({ ok: false, reason: 'daemon_unavailable' });
    }
  });

  it('passes each known attach refusal reason through unchanged', async () => {
    for (const reason of ['attach_limit', 'daemon_unavailable', 'invalid_session_id']) {
      invoke.mockResolvedValue({ ok: false, reason, path: 'C:/Users/someone' });
      const api = await loadPreload('agentWorkspace');
      expect(await (api.attachActivity as (i: string) => Promise<unknown>)('ses-1')).toEqual({ ok: false, reason });
    }
  });

  it('rebuilds every push before handing it to the renderer, and drops what it cannot read', async () => {
    const api = await loadPreload('agentWorkspace');
    const received: unknown[] = [];
    const unsubscribe = (api.onActivity as (cb: (p: unknown) => void) => () => void)((push) => received.push(push));

    const listener = on.mock.calls.find((call) => call[0] === 'agent-workspace:activity')?.[1] as
      | ((event: unknown, payload: unknown) => void)
      | undefined;
    expect(listener).toBeDefined();

    listener?.(
      {},
      {
        sessionId: 'ses-1',
        entry: {
          seq: 0,
          at: 't',
          origin: 'live',
          kind: 'assistant.message',
          text: 'hello',
          providerSessionId: 'native-thread-abc',
        },
        cwd: 'C:/Users/someone',
      },
    );
    listener?.({}, { sessionId: 'ses-1', closed: { reason: 'stream_ended' } });
    listener?.({}, { sessionId: 'ses-1', closed: { reason: 'invented' } });
    // Each of these must be dropped, not delivered as a half-built push.
    listener?.({}, { entry: { seq: 0, kind: 'status', status: 'x' } });
    listener?.({}, { sessionId: '', entry: { seq: 0, kind: 'status', status: 'x' } });
    listener?.({}, { sessionId: 'ses-1', entry: { seq: 0, kind: 'something.new' } });
    listener?.({}, null);

    expect(received).toEqual([
      { sessionId: 'ses-1', entry: { seq: 0, at: 't', origin: 'live', kind: 'assistant.message', text: 'hello' } },
      { sessionId: 'ses-1', closed: { reason: 'stream_ended' } },
      // Fail-closed: an unrecognized close reason still closes the stream.
      { sessionId: 'ses-1', closed: { reason: 'stream_unavailable' } },
    ]);
    expect(JSON.stringify(received)).not.toContain('native-thread-abc');
    expect(JSON.stringify(received)).not.toContain('Users');

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith('agent-workspace:activity', listener);
  });
});

describe('electron/preload.ts: ADI-07 left the six earlier namespaces alone', () => {
  it('leaves the five pre-ADI-06 namespaces key-for-key unchanged', async () => {
    // Same literals as the ADI-06 block above, re-asserted after the seventh namespace was added.
    for (const [namespace, keys] of Object.entries(PRE_ADI_06_NAMESPACES)) {
      const api = await loadPreload(namespace);
      expect(Object.keys(api).sort(), namespace).toEqual([...keys].sort());
    }
  });

  it('leaves workspaceGrant at exactly its four keys', async () => {
    // ADI-07 is the first renderer consumer of this namespace and deliberately does not widen it:
    // reading a session list is not a filesystem trust decision.
    const api = await loadPreload('workspaceGrant');
    expect(Object.keys(api).sort()).toEqual(['consumeGrant', 'getGrantStatus', 'requestGrant', 'startSession'].sort());
  });

  it('adds no session-reading or activity capability to agentDock', async () => {
    const api = await loadPreload('agentDock');
    for (const key of Object.keys(api)) {
      expect(key).not.toMatch(/activity|attach|workspaceSession/i);
    }
  });
});

const ENTRY = { attemptId: 'attempt-1', state: 'queued', queuedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

describe('electron/preload.ts: applicationQueue bridge (#200)', () => {
  it('exposes exactly the six documented capability functions and nothing else', async () => {
    const api = await loadPreload('applicationQueue');
    expect(Object.keys(api).sort()).toEqual(
      ['enqueue', 'pause', 'resume', 'skip', 'cancel', 'getStatus', 'onActivity'].sort(),
    );
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} should be a plain function`).toBe('function');
    }
  });

  it('exposes no generic IPC passthrough', async () => {
    const api = await loadPreload('applicationQueue');
    expect(api.invoke).toBeUndefined();
    expect(api.send).toBeUndefined();
    expect(api.ipcRenderer).toBeUndefined();
  });

  it('maps every verb to exactly one hard-coded application-queue: channel, passing the id straight through', async () => {
    const cases: [name: string, channel: string][] = [
      ['enqueue', 'application-queue:enqueue'],
      ['pause', 'application-queue:pause'],
      ['resume', 'application-queue:resume'],
      ['skip', 'application-queue:skip'],
      ['cancel', 'application-queue:cancel'],
    ];
    for (const [name, channel] of cases) {
      invoke.mockReset();
      invoke.mockResolvedValue(ENTRY);
      const api = await loadPreload('applicationQueue');
      await (api[name] as (id: string) => Promise<unknown>)('attempt-1');
      expect(invoke, name).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith(channel, 'attempt-1');
    }
  });

  it('throws rather than returning a fabricated entry when main sends an unexpected shape', async () => {
    invoke.mockResolvedValue({ nonsense: true });
    const api = await loadPreload('applicationQueue');
    await expect((api.enqueue as (id: string) => Promise<unknown>)('attempt-1')).rejects.toThrow(
      /unexpected response/,
    );
  });

  it('getStatus rebuilds entries and lease independently, dropping an unrecognized entry rather than the whole list', async () => {
    invoke.mockResolvedValue({
      entries: [ENTRY, { attemptId: 'bad' /* missing state/queuedAt/updatedAt */ }],
      lease: { leaseId: 'lease-1', attemptId: 'attempt-1', acquiredAt: '2026-01-01T00:00:00.000Z' },
    });
    const api = await loadPreload('applicationQueue');
    const status = await (api.getStatus as () => Promise<{ entries: unknown[]; lease: unknown }>)();
    expect(status.entries).toEqual([ENTRY]);
    expect(status.lease).toEqual({ leaseId: 'lease-1', attemptId: 'attempt-1', acquiredAt: '2026-01-01T00:00:00.000Z' });
  });

  it('getStatus reports lease: null for both an absent and a malformed lease', async () => {
    invoke.mockResolvedValueOnce({ entries: [], lease: null });
    const api = await loadPreload('applicationQueue');
    expect((await (api.getStatus as () => Promise<{ lease: unknown }>)()).lease).toBeNull();

    invoke.mockResolvedValueOnce({ entries: [], lease: { leaseId: 'only-one-field' } });
    const api2 = await loadPreload('applicationQueue');
    expect((await (api2.getStatus as () => Promise<{ lease: unknown }>)()).lease).toBeNull();
  });

  it('onActivity delivers a well-formed event and can be unsubscribed', async () => {
    const api = await loadPreload('applicationQueue');
    const received: unknown[] = [];
    const unsubscribe = (api.onActivity as (cb: (e: unknown) => void) => () => void)((event) => received.push(event));

    expect(on).toHaveBeenCalledWith('application-queue:activity', expect.any(Function));
    const listener = on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;
    listener({}, { seq: 3, at: '2026-01-01T00:00:00.000Z', type: 'lease_acquired', attemptId: 'attempt-1' });

    expect(received).toEqual([{ seq: 3, at: '2026-01-01T00:00:00.000Z', type: 'lease_acquired', attemptId: 'attempt-1' }]);

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith('application-queue:activity', listener);
  });

  it('onActivity drops a malformed payload rather than delivering a fabricated event', async () => {
    const api = await loadPreload('applicationQueue');
    const received: unknown[] = [];
    (api.onActivity as (cb: (e: unknown) => void) => () => void)((event) => received.push(event));
    const listener = on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;

    listener({}, { seq: 'not-a-number', at: 'x', type: 'lease_acquired', attemptId: 'a' });
    listener({}, { seq: 1, at: 'x', type: 'not-a-real-type', attemptId: 'a' });
    listener({}, null);

    expect(received).toEqual([]);
  });
});

const READINESS_RESULT = {
  ready: true,
  verifiedFilledCount: 2,
  discoveredFieldCount: 2,
  requiredFieldCount: 2,
  requiredFieldsSatisfied: 2,
  blockers: [],
};

const SNAPSHOT_RESULT = {
  snapshot: {
    generation: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
    challengeDetected: false,
    activeFrameId: 0,
    pageStateFingerprint: 'a'.repeat(64),
    fields: [
      { fieldRef: 'f0000000000000001', label: 'fullName', controlType: 'text', required: true, frameId: 0, active: true },
      {
        fieldRef: 'f0000000000000002',
        label: 'workAuthorization',
        controlType: 'select',
        required: true,
        frameId: 0,
        active: true,
        options: [{ optionRef: 'o0000000000000001', label: 'Yes' }],
      },
    ],
    submitControls: [{ controlRef: 'c0000000000000001', label: 'Submit Application' }],
  },
  screenshotBase64: 'ZmFrZQ==',
  readiness: READINESS_RESULT,
  handoffShown: false,
};

describe('electron/preload.ts: applicationExecutor bridge (#201)', () => {
  it('exposes exactly the ten documented capability functions and nothing else', async () => {
    const api = await loadPreload('applicationExecutor');
    expect(Object.keys(api).sort()).toEqual(
      [
        'openReview',
        'applyFieldMap',
        'submitReview',
        'closeReview',
        'resolveTargetPolicyId',
        'requestAutomationGrant',
        'scheduleAutomaticSubmission',
        'cancelScheduledAutomaticSubmission',
        // #277's live handoff. Both take an attempt id and nothing else: the renderer cannot name a
        // window, supply bounds, or reach a view for an attempt with no open review.
        'showHandoff',
        'hideHandoff',
      ].sort(),
    );
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} should be a plain function`).toBe('function');
    }
  });

  it('exposes no generic IPC passthrough', async () => {
    const api = await loadPreload('applicationExecutor');
    expect(api.invoke).toBeUndefined();
    expect(api.send).toBeUndefined();
    expect(api.ipcRenderer).toBeUndefined();
  });

  it('openReview invokes the hard-coded open-review channel and rebuilds a well-formed snapshot', async () => {
    invoke.mockResolvedValue(SNAPSHOT_RESULT);
    const api = await loadPreload('applicationExecutor');
    const input = { attemptId: 'attempt-1', policyId: 'ashby-fixture-test-only', targetUrl: 'file:///fixture.html' };
    const result = await (api.openReview as (i: unknown) => Promise<unknown>)(input);
    expect(invoke).toHaveBeenCalledWith('application-executor:open-review', input);
    expect(result).toEqual(SNAPSHOT_RESULT);
  });

  it('openReview throws rather than returning a fabricated snapshot when main sends an unexpected shape', async () => {
    invoke.mockResolvedValue({ nonsense: true });
    const api = await loadPreload('applicationExecutor');
    await expect((api.openReview as (i: unknown) => Promise<unknown>)({})).rejects.toThrow(/unexpected response/);
  });

  it('openReview rejects a field with an unrecognized control type rather than passing it through', async () => {
    invoke.mockResolvedValue({
      snapshot: {
        generation: 1,
        capturedAt: '2026-01-01T00:00:00.000Z',
        challengeDetected: false,
        activeFrameId: 0,
        pageStateFingerprint: 'b'.repeat(64),
        fields: [{ fieldRef: 'f1', label: 'x', controlType: 'not-a-real-type', required: false, frameId: 0, active: true }],
        submitControls: [],
      },
      screenshotBase64: 'ZmFrZQ==',
      readiness: READINESS_RESULT,
      handoffShown: false,
    });
    const api = await loadPreload('applicationExecutor');
    await expect((api.openReview as (i: unknown) => Promise<unknown>)({})).rejects.toThrow(/unrecognized control type/);
  });

  it('openReview throws rather than downgrading an unreadable readiness reading to an empty one (#277)', async () => {
    // The single worst direction for this value to fail in: a dropped readiness object would read
    // as zero blockers, which is indistinguishable from "ready to submit".
    invoke.mockResolvedValue({ ...SNAPSHOT_RESULT, readiness: { ready: true } });
    const api = await loadPreload('applicationExecutor');
    await expect((api.openReview as (i: unknown) => Promise<unknown>)({})).rejects.toThrow(/unexpected readiness response/);
  });

  it('showHandoff invokes the hard-coded show-handoff channel with nothing but the attempt id (#277)', async () => {
    invoke.mockResolvedValue({ ok: true, company: 'Acme Corp', role: 'Senior Engineer' });
    const api = await loadPreload('applicationExecutor');
    const result = await (api.showHandoff as (i: string) => Promise<unknown>)('attempt-1');
    expect(invoke).toHaveBeenCalledWith('application-executor:show-handoff', 'attempt-1');
    expect(result).toEqual({ ok: true, company: 'Acme Corp', role: 'Senior Engineer' });
  });

  it('showHandoff rejects an unrecognized refusal reason rather than passing it through', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'something-new' });
    const api = await loadPreload('applicationExecutor');
    await expect((api.showHandoff as (i: string) => Promise<unknown>)('attempt-1')).rejects.toThrow(/unrecognized handoff refusal reason/);
  });

  it('hideHandoff invokes the hard-coded hide-handoff channel with nothing but the attempt id', async () => {
    invoke.mockResolvedValue(undefined);
    const api = await loadPreload('applicationExecutor');
    await (api.hideHandoff as (i: string) => Promise<void>)('attempt-1');
    expect(invoke).toHaveBeenCalledWith('application-executor:hide-handoff', 'attempt-1');
  });

  it('applyFieldMap invokes the hard-coded apply-field-map channel and passes the result through', async () => {
    invoke.mockResolvedValue({ ok: true, appliedCount: 2 });
    const api = await loadPreload('applicationExecutor');
    const input = { attemptId: 'attempt-1', fieldMap: { fake: true }, valueTable: [] };
    const result = await (api.applyFieldMap as (i: unknown) => Promise<unknown>)(input);
    expect(invoke).toHaveBeenCalledWith('application-executor:apply-field-map', input);
    expect(result).toEqual({ ok: true, appliedCount: 2 });
  });

  it('applyFieldMap surfaces a refusal reason/detail without fabricating success', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'stale_snapshot_generation', detail: 'targets generation 1, current is 2' });
    const api = await loadPreload('applicationExecutor');
    const result = await (api.applyFieldMap as (i: unknown) => Promise<unknown>)({});
    expect(result).toEqual({ ok: false, reason: 'stale_snapshot_generation', detail: 'targets generation 1, current is 2' });
  });

  it('applyFieldMap passes confirmed attachments through, and drops anything path-shaped main did not promise (#273)', async () => {
    invoke.mockResolvedValue({
      ok: true,
      appliedCount: 1,
      attachments: [
        {
          artifactId: 'artifact-1',
          fieldRef: 'f0000000000000001',
          fileName: 'resume.pdf',
          attachedFileName: 'abc123-resume.pdf',
          // Not part of the contract: a path must never survive this bridge even if main sent one.
          localFilePath: '/staged/attempt-1/abc123-resume.pdf',
        },
      ],
    });
    const api = await loadPreload('applicationExecutor');
    const result = await (api.applyFieldMap as (i: unknown) => Promise<unknown>)({});
    expect(result).toEqual({
      ok: true,
      appliedCount: 1,
      attachments: [{ artifactId: 'artifact-1', fieldRef: 'f0000000000000001', fileName: 'resume.pdf', attachedFileName: 'abc123-resume.pdf' }],
    });
  });

  it('applyFieldMap surfaces a manual upload handoff rather than a bare refusal (#273)', async () => {
    invoke.mockResolvedValue({
      ok: false,
      reason: 'attachment_requires_manual_handoff',
      detail: 'target policy "x" does not permit automated uploads',
      manualHandoff: { fieldRef: 'f0000000000000001', artifactId: 'artifact-1', fileName: 'resume.pdf', reason: 'unsupported_control' },
    });
    const api = await loadPreload('applicationExecutor');
    const result = await (api.applyFieldMap as (i: unknown) => Promise<unknown>)({});
    expect(result).toEqual({
      ok: false,
      reason: 'attachment_requires_manual_handoff',
      detail: 'target policy "x" does not permit automated uploads',
      manualHandoff: { fieldRef: 'f0000000000000001', artifactId: 'artifact-1', fileName: 'resume.pdf', reason: 'unsupported_control' },
    });
  });

  it('applyFieldMap throws rather than returning a fabricated result when main sends an unexpected shape', async () => {
    invoke.mockResolvedValue({ nonsense: true });
    const api = await loadPreload('applicationExecutor');
    await expect((api.applyFieldMap as (i: unknown) => Promise<unknown>)({})).rejects.toThrow(/unexpected response/);
  });

  it('submitReview invokes the hard-coded submit-review channel and passes a successful result through', async () => {
    invoke.mockResolvedValue({ ok: true });
    const api = await loadPreload('applicationExecutor');
    const result = await (api.submitReview as (id: string) => Promise<unknown>)('attempt-1');
    expect(invoke).toHaveBeenCalledWith('application-executor:submit-review', 'attempt-1');
    expect(result).toEqual({ ok: true });
  });

  it('submitReview surfaces a refusal reason/detail without fabricating success', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'company_not_found_in_documents', detail: '"Acme" does not appear in the rendered documents' });
    const api = await loadPreload('applicationExecutor');
    const result = await (api.submitReview as (id: string) => Promise<unknown>)('attempt-1');
    expect(result).toEqual({ ok: false, reason: 'company_not_found_in_documents', detail: '"Acme" does not appear in the rendered documents' });
  });

  it('submitReview throws rather than returning a fabricated result when main sends an unexpected shape', async () => {
    invoke.mockResolvedValue({ nonsense: true });
    const api = await loadPreload('applicationExecutor');
    await expect((api.submitReview as (id: string) => Promise<unknown>)('attempt-1')).rejects.toThrow(/unexpected response/);
  });

  it('closeReview invokes the hard-coded close-review channel with the attemptId', async () => {
    invoke.mockResolvedValue(undefined);
    const api = await loadPreload('applicationExecutor');
    await (api.closeReview as (id: string) => Promise<void>)('attempt-1');
    expect(invoke).toHaveBeenCalledWith('application-executor:close-review', 'attempt-1');
  });

  it('resolveTargetPolicyId invokes the hard-coded resolve-target-policy channel and passes a real id through', async () => {
    invoke.mockResolvedValue('ashby-fixture-test-only');
    const api = await loadPreload('applicationExecutor');
    const result = await (api.resolveTargetPolicyId as (url: string) => Promise<string | null>)('file:///fixture.html');
    expect(invoke).toHaveBeenCalledWith('application-executor:resolve-target-policy', 'file:///fixture.html');
    expect(result).toBe('ashby-fixture-test-only');
  });

  it('resolveTargetPolicyId returns null rather than fabricating an id when main finds no matching policy', async () => {
    invoke.mockResolvedValue(null);
    const api = await loadPreload('applicationExecutor');
    const result = await (api.resolveTargetPolicyId as (url: string) => Promise<string | null>)('https://example.com/careers/apply');
    expect(result).toBeNull();
  });

  it('requestAutomationGrant invokes the hard-coded request-automation-grant channel with the input, passing a real result through', async () => {
    invoke.mockResolvedValue({ ok: true, expiresAt: '2026-03-01T00:00:00.000Z' });
    const api = await loadPreload('applicationExecutor');
    const input = { policyId: 'workable-jobs-board', durationMs: 86_400_000 };
    const result = await (api.requestAutomationGrant as (i: unknown) => Promise<unknown>)(input);
    expect(invoke).toHaveBeenCalledWith('application-executor:request-automation-grant', input);
    expect(result).toEqual({ ok: true, expiresAt: '2026-03-01T00:00:00.000Z' });
  });

  it('requestAutomationGrant surfaces a refusal reason without fabricating success', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'declined' });
    const api = await loadPreload('applicationExecutor');
    const result = await (api.requestAutomationGrant as (i: unknown) => Promise<unknown>)({ policyId: 'x', durationMs: 1000 });
    expect(result).toEqual({ ok: false, reason: 'declined' });
  });

  it('requestAutomationGrant throws rather than returning a fabricated result when main sends an unexpected shape', async () => {
    invoke.mockResolvedValue({ nonsense: true });
    const api = await loadPreload('applicationExecutor');
    await expect((api.requestAutomationGrant as (i: unknown) => Promise<unknown>)({ policyId: 'x', durationMs: 1000 })).rejects.toThrow(/unexpected response/);
  });

  it('scheduleAutomaticSubmission invokes the hard-coded schedule-automatic-submission channel with the attemptId', async () => {
    invoke.mockResolvedValue({ ok: true, scheduledAutomaticSubmitAt: '2026-01-01T00:03:00.000Z' });
    const api = await loadPreload('applicationExecutor');
    const result = await (api.scheduleAutomaticSubmission as (id: string) => Promise<unknown>)('attempt-1');
    expect(invoke).toHaveBeenCalledWith('application-executor:schedule-automatic-submission', 'attempt-1');
    expect(result).toEqual({ ok: true, scheduledAutomaticSubmitAt: '2026-01-01T00:03:00.000Z' });
  });

  it('scheduleAutomaticSubmission surfaces a refusal reason/detail without fabricating success', async () => {
    invoke.mockResolvedValue({ ok: false, reason: 'no_active_grant', detail: 'no grant found' });
    const api = await loadPreload('applicationExecutor');
    const result = await (api.scheduleAutomaticSubmission as (id: string) => Promise<unknown>)('attempt-1');
    expect(result).toEqual({ ok: false, reason: 'no_active_grant', detail: 'no grant found' });
  });

  it('scheduleAutomaticSubmission throws rather than returning a fabricated result when main sends an unexpected shape', async () => {
    invoke.mockResolvedValue({ nonsense: true });
    const api = await loadPreload('applicationExecutor');
    await expect((api.scheduleAutomaticSubmission as (id: string) => Promise<unknown>)('attempt-1')).rejects.toThrow(/unexpected response/);
  });

  it('cancelScheduledAutomaticSubmission invokes the hard-coded cancel channel with the attemptId', async () => {
    invoke.mockResolvedValue(undefined);
    const api = await loadPreload('applicationExecutor');
    await (api.cancelScheduledAutomaticSubmission as (id: string) => Promise<void>)('attempt-1');
    expect(invoke).toHaveBeenCalledWith('application-executor:cancel-scheduled-automatic-submission', 'attempt-1');
  });
});

describe('electron/preload.ts: applicationPipeline bridge (#272)', () => {
  it('exposes exactly one capability function and nothing else', async () => {
    const api = await loadPreload('applicationPipeline');
    expect(Object.keys(api)).toEqual(['start']);
    expect(typeof api.start).toBe('function');
  });

  it('exposes no generic IPC passthrough', async () => {
    const api = await loadPreload('applicationPipeline');
    expect(api.invoke).toBeUndefined();
    expect(api.send).toBeUndefined();
    expect(api.ipcRenderer).toBeUndefined();
  });

  it('start invokes the hard-coded channel with only the saved-job id', async () => {
    invoke.mockResolvedValue({ ok: true, attemptId: 'attempt-1' });
    const api = await loadPreload('applicationPipeline');
    const result = await (api.start as (id: string) => Promise<unknown>)('saved-1');
    expect(invoke).toHaveBeenCalledWith('application-pipeline:start', { savedJobId: 'saved-1' });
    expect(result).toEqual({ ok: true, attemptId: 'attempt-1' });
  });

  it('carries a refusal and the attempt already in progress back unchanged', async () => {
    invoke.mockResolvedValue({
      ok: false,
      reason: 'attempt_already_in_progress',
      attemptId: 'attempt-existing',
      detail: 'an application for this vacancy is already in progress',
    });
    const api = await loadPreload('applicationPipeline');
    expect(await (api.start as (id: string) => Promise<unknown>)('saved-1')).toEqual({
      ok: false,
      reason: 'attempt_already_in_progress',
      attemptId: 'attempt-existing',
      detail: 'an application for this vacancy is already in progress',
    });
  });

  it('fails closed on a shape this build cannot interpret rather than reporting success', async () => {
    invoke.mockResolvedValue({ nonsense: true, reason: 'something_new', extra: 'should not cross' });
    const api = await loadPreload('applicationPipeline');
    expect(await (api.start as (id: string) => Promise<unknown>)('saved-1')).toEqual({ ok: false });
  });
});
