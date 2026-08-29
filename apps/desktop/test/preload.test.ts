import { beforeEach, describe, expect, it, vi } from 'vitest';

// AD-07: the old test here asserted properties of a mock object the test itself constructed, so
// it could never fail for the reason its name claimed. This imports the REAL electron/preload.ts
// module against a stubbed ipcRenderer, so the assertions run against code that could actually
// leak something. `vi.hoisted` is required here (not plain module-scope consts) because
// `vi.mock('electron', ...)` is hoisted above other statements by vitest's transform — referencing
// un-hoisted variables from inside the factory would throw a "used before initialization" error.
const { invoke, on, removeListener } = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

// preload.ts exposes two independent namespaces (`agentDock` and `vacancyRadar`) via two separate
// exposeInMainWorld calls — keyed by name so loading one doesn't clobber the other, the way a
// single shared `exposedApi` variable would.
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

describe('electron/preload.ts — real bridge (AD-07)', () => {
  it('exposes exactly the seven documented capability functions and nothing else', async () => {
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
});

describe('electron/preload.ts — vacancyRadar bridge', () => {
  it('exposes exactly the three documented capability functions and nothing else', async () => {
    const api = await loadPreload('vacancyRadar');
    expect(Object.keys(api).sort()).toEqual(['getReport', 'getStatus', 'runScan'].sort());
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

  it('runScan invokes only vacancy:run-scan, no arguments', async () => {
    invoke.mockResolvedValue({ runId: 'run-1' });
    const api = await loadPreload('vacancyRadar');
    await (api.runScan as () => Promise<unknown>)();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('vacancy:run-scan');
  });
});

describe('electron/preload.ts — cv bridge', () => {
  it('exposes exactly the two documented capability functions and nothing else', async () => {
    const api = await loadPreload('cv');
    expect(Object.keys(api).sort()).toEqual(['getWorkspaceDir', 'selectAndRead'].sort());
    for (const [name, value] of Object.entries(api)) {
      expect(typeof value, `${name} should be a plain function`).toBe('function');
    }
  });

  it('takes no file path: selectAndRead invokes cv:select-and-read with no arguments at all', async () => {
    // The renderer must never be able to name the file that gets read — only the user can, in the
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
