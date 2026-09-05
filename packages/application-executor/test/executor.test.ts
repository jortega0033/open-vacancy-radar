import { describe, expect, it, vi } from 'vitest';
import { ApplicationExecutor, ExecutorPolicyError, type CdpTransport } from '../src/executor.js';
import type { ApplicationTargetPolicy } from '../src/target-policy.js';

function fakeTransport(responses: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const transport: CdpTransport = {
    async sendCommand(method, params) {
      calls.push({ method, params });
      return responses[method] ?? {};
    },
  };
  return { transport, calls };
}

function fullPolicy(overrides: Partial<ApplicationTargetPolicy> = {}): ApplicationTargetPolicy {
  return {
    id: 'fixture-ats',
    displayName: 'Fixture ATS',
    origins: ['https://fixture.example.invalid'],
    adapter: 'fixture',
    termsRegisterEntry: 'fixture-ats',
    termsVersion: '1',
    termsReviewedAt: '2026-01-01',
    allowedActions: ['openTarget', 'snapshot', 'fill', 'select', 'attach', 'capture', 'handoff'],
    uploadConstraints: { maxBytes: 10_000_000, mimeTypes: ['application/pdf'] },
    rateLimits: { perDay: 1, perEmployerPerDay: 1, minIntervalMs: 0 },
    killSwitches: { navigate: false, fill: false, upload: false, submit: false },
    maxSteps: 50,
    timeoutMs: 30_000,
    maximumSnapshotBytes: 1_000_000,
    ...overrides,
  };
}

const NAME_INPUT_TREE = {
  root: {
    nodeName: 'BODY',
    nodeType: 1,
    backendNodeId: 1,
    children: [
      { nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'text', 'name', 'fullName'] },
      { nodeName: 'INPUT', nodeType: 1, backendNodeId: 3, attributes: ['type', 'checkbox', 'name', 'hasDriversLicense'] },
      {
        nodeName: 'SELECT',
        nodeType: 1,
        backendNodeId: 4,
        attributes: ['name', 'country'],
        children: [
          { nodeName: 'OPTION', nodeType: 1, backendNodeId: 5, attributes: ['value', 'nl'], children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 0, nodeValue: 'Netherlands' }] },
        ],
      },
      { nodeName: 'INPUT', nodeType: 1, backendNodeId: 6, attributes: ['type', 'file', 'name', 'resume'] },
    ],
  },
};

describe('ApplicationExecutor: policy enforcement', () => {
  it('refuses an action not in the policy allowedActions list', async () => {
    const { transport } = fakeTransport();
    const executor = new ApplicationExecutor(transport, fullPolicy({ allowedActions: ['snapshot'] }));
    await expect(executor.openTarget('https://fixture.example.invalid/apply')).rejects.toThrow(ExecutorPolicyError);
  });

  it('refuses openTarget when the navigate kill switch is on', async () => {
    const { transport } = fakeTransport();
    const executor = new ApplicationExecutor(transport, fullPolicy({ killSwitches: { navigate: true, fill: false, upload: false, submit: false } }));
    await expect(executor.openTarget('https://fixture.example.invalid/apply')).rejects.toThrow(ExecutorPolicyError);
  });

  it('refuses fill when the fill kill switch is on', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy({ killSwitches: { navigate: false, fill: true, upload: false, submit: false } }));
    const snapshot = await executor.snapshot();
    await expect(executor.fill(snapshot.fields[0]!.fieldRef, 'x')).rejects.toThrow(ExecutorPolicyError);
  });

  it('refuses openTarget to an origin outside the policy allowlist', async () => {
    const { transport, calls } = fakeTransport();
    const executor = new ApplicationExecutor(transport, fullPolicy());
    await expect(executor.openTarget('https://attacker.example.invalid/apply')).rejects.toThrow(ExecutorPolicyError);
    expect(calls).toHaveLength(0); // never reached the transport at all
  });
});

describe('ApplicationExecutor: openTarget', () => {
  it('navigates via Page.navigate and bumps the generation, invalidating the prior snapshot', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    await executor.snapshot();
    expect(executor.currentSnapshot).toBeDefined();

    await executor.openTarget('https://fixture.example.invalid/apply');
    expect(calls.at(-1)).toMatchObject({ method: 'Page.navigate', params: { url: 'https://fixture.example.invalid/apply' } });
    expect(executor.currentSnapshot).toBeUndefined();
  });
});

describe('ApplicationExecutor: snapshot', () => {
  it('mints a fresh generation and real fields from the DOM tree', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    expect(snapshot.generation).toBe(1);
    expect(snapshot.fields.map((f) => f.controlType)).toEqual(['text', 'checkbox', 'select', 'file']);
  });

  it('bumps the generation on every call', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const first = await executor.snapshot();
    const second = await executor.snapshot();
    expect(second.generation).toBe(first.generation + 1);
  });

  const EMPTY_TREE = { root: { nodeName: 'BODY', nodeType: 1, backendNodeId: 1, children: [] } };

  it('retries an initially-empty DOM read and returns the real fields once the page catches up', async () => {
    // Confirmed against a real Electron WebContentsView (e2e/application-executor.spec.ts):
    // Page.navigate resolves before the document is actually parsed, so an immediate
    // DOM.getDocument can race ahead and see nothing yet.
    let calls = 0;
    const transport: CdpTransport = {
      async sendCommand(method) {
        if (method !== 'DOM.getDocument') return {};
        calls += 1;
        return calls < 3 ? EMPTY_TREE : NAME_INPUT_TREE;
      },
    };
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    expect(calls).toBe(3);
    expect(snapshot.fields).toHaveLength(4);
  });

  it('gives up after the retry limit and returns an empty snapshot rather than waiting forever', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const transport: CdpTransport = {
        async sendCommand(method) {
          if (method === 'DOM.getDocument') calls += 1;
          return EMPTY_TREE;
        },
      };
      const executor = new ApplicationExecutor(transport, fullPolicy());
      const snapshotPromise = executor.snapshot();
      await vi.advanceTimersByTimeAsync(60_000);
      const snapshot = await snapshotPromise;
      expect(snapshot.fields).toEqual([]);
      expect(calls).toBe(21); // the first read plus EMPTY_SNAPSHOT_RETRY_LIMIT retries
    } finally {
      vi.useRealTimers();
    }
  });

  it('never retries when the first read already finds fields, matching every fake-transport test above', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    await executor.snapshot();
    expect(calls.filter((c) => c.method === 'DOM.getDocument')).toHaveLength(1);
  });
});

describe('ApplicationExecutor: fill', () => {
  it('focuses the real backend node then inserts text, for a plain text field', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const nameField = snapshot.fields.find((f) => f.controlType === 'text')!;

    await executor.fill(nameField.fieldRef, 'Jamie Rivera');

    const relevant = calls.slice(-2);
    expect(relevant[0]).toMatchObject({ method: 'DOM.focus', params: { backendNodeId: 2 } });
    expect(relevant[1]).toMatchObject({ method: 'Input.insertText', params: { text: 'Jamie Rivera' } });
  });

  it('clicks the checkbox at its real box-model center when the value is true', async () => {
    const { transport, calls } = fakeTransport({
      'DOM.getDocument': NAME_INPUT_TREE,
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const checkbox = snapshot.fields.find((f) => f.controlType === 'checkbox')!;

    await executor.fill(checkbox.fieldRef, 'true');

    const mouseCalls = calls.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(mouseCalls).toHaveLength(2); // pressed + released
    expect(mouseCalls[0]).toMatchObject({ params: { type: 'mousePressed', x: 20, y: 30 } });
  });

  it('does nothing for a checkbox fill of "false" (native default is already unchecked)', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const checkbox = snapshot.fields.find((f) => f.controlType === 'checkbox')!;
    const before = calls.length;

    await executor.fill(checkbox.fieldRef, 'false');
    expect(calls.length).toBe(before); // no new CDP calls at all
  });

  it('refuses to fill an unknown fieldRef', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    await executor.snapshot();
    await expect(executor.fill('f0000000000000ff', 'x')).rejects.toThrow(ExecutorPolicyError);
  });

  it('refuses to fill a field structurally classified as a credential field, even with a plausible value', async () => {
    const passwordTree = {
      root: { nodeName: 'BODY', nodeType: 1, backendNodeId: 1, children: [{ nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'password', 'name', 'pw'] }] },
    };
    const { transport } = fakeTransport({ 'DOM.getDocument': passwordTree });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    await expect(executor.fill(snapshot.fields[0]!.fieldRef, 'hunter2')).rejects.toThrow(ExecutorPolicyError);
  });

  it('throws when no snapshot has been taken yet', async () => {
    const { transport } = fakeTransport();
    const executor = new ApplicationExecutor(transport, fullPolicy());
    await expect(executor.fill('f0000000000000ff', 'x')).rejects.toThrow(ExecutorPolicyError);
  });
});

describe('ApplicationExecutor: select', () => {
  it('focuses the select then drives it to the option index with arrow keys and Enter', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const countryField = snapshot.fields.find((f) => f.controlType === 'select')!;
    const option = countryField.options![0]!;

    await executor.select(countryField.fieldRef, option.optionRef);

    const relevant = calls.slice(-2);
    expect(relevant[0]).toMatchObject({ method: 'DOM.focus', params: { backendNodeId: 4 } });
    expect(relevant[1]).toMatchObject({ method: 'Input.dispatchKeyEvent', params: { key: 'Enter' } });
  });

  it('refuses an optionRef that is not on the given field', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const countryField = snapshot.fields.find((f) => f.controlType === 'select')!;
    await expect(executor.select(countryField.fieldRef, 'o0000000000000ff')).rejects.toThrow(ExecutorPolicyError);
  });
});

describe('ApplicationExecutor: attach', () => {
  it('calls DOM.setFileInputFiles with the real backend node and given path', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const fileField = snapshot.fields.find((f) => f.controlType === 'file')!;

    await executor.attach(fileField.fieldRef, '/staged/resume.pdf');

    expect(calls.at(-1)).toMatchObject({ method: 'DOM.setFileInputFiles', params: { files: ['/staged/resume.pdf'], backendNodeId: 6 } });
  });

  it('refuses to attach to a non-file field', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const textField = snapshot.fields.find((f) => f.controlType === 'text')!;
    await expect(executor.attach(textField.fieldRef, '/staged/resume.pdf')).rejects.toThrow(ExecutorPolicyError);
  });
});

describe('ApplicationExecutor: capture and handoff', () => {
  it('captures a screenshot via Page.captureScreenshot', async () => {
    const { transport } = fakeTransport({ 'Page.captureScreenshot': { data: 'base64data' } });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    expect(await executor.capture()).toBe('base64data');
  });

  it('handoff is a pure state transition -- no CDP call at all', () => {
    const { transport, calls } = fakeTransport();
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const result = executor.handoff('login_wall');
    expect(result).toEqual({ action: 'handoff', reason: 'login_wall' });
    expect(calls).toHaveLength(0);
  });
});

describe('ApplicationExecutor: CDP allowlist enforcement is real, not decorative', () => {
  it('every method actually sent to the transport is on the allowlist', async () => {
    const { transport, calls } = fakeTransport({
      'DOM.getDocument': NAME_INPUT_TREE,
      'DOM.getBoxModel': { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } },
      'Page.captureScreenshot': { data: 'x' },
    });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    await executor.fill(snapshot.fields[0]!.fieldRef, 'x');
    await executor.fill(snapshot.fields[1]!.fieldRef, 'true');
    await executor.select(snapshot.fields[2]!.fieldRef, snapshot.fields[2]!.options![0]!.optionRef);
    await executor.attach(snapshot.fields[3]!.fieldRef, '/tmp/x.pdf');
    await executor.capture();

    const { isAllowedCdpMethod } = await import('../src/cdp-allowlist.js');
    for (const call of calls) {
      expect(isAllowedCdpMethod(call.method), call.method).toBe(true);
    }
    expect(calls.length).toBeGreaterThan(5); // sanity: this test actually exercised real calls
  });
});
