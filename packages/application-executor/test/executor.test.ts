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
    allowedActions: ['openTarget', 'snapshot', 'fill', 'select', 'attach', 'capture', 'handoff', 'submit'],
    uploadConstraints: { maxBytes: 10_000_000, mimeTypes: ['application/pdf'] },
    rateLimits: { perDay: 1, perEmployerPerDay: 1, minIntervalMs: 0 },
    killSwitches: { navigate: false, fill: false, upload: false, submit: false },
    termsEligibleForAutomation: false,
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
      { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 7, children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 0, nodeValue: 'Submit Application' }] },
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

  it('refuses a file:// URL not in exactFileUrls, never matching by origin alone', async () => {
    // Every file:// URL's origin serializes to the same literal string "null" (WHATWG URL spec).
    // A policy that (mistakenly) put 'null' in `origins` would let ANY local file through if this
    // were checked the same way as an http(s) origin -- confirmed as a real gap against a live
    // Electron process (issue #201's review). `exactFileUrls` is the fix: exact-URL match only.
    const { transport, calls } = fakeTransport();
    const executor = new ApplicationExecutor(
      transport,
      fullPolicy({ origins: ['null'], exactFileUrls: ['file:///allowed/fixture.html'] }),
    );
    await expect(executor.openTarget('file:///some/other/sensitive-file.html')).rejects.toThrow(ExecutorPolicyError);
    expect(calls).toHaveLength(0);
  });

  it('allows a file:// URL that is an exact match in exactFileUrls', async () => {
    const { transport, calls } = fakeTransport();
    const executor = new ApplicationExecutor(
      transport,
      fullPolicy({ origins: [], exactFileUrls: ['file:///allowed/fixture.html'] }),
    );
    await executor.openTarget('file:///allowed/fixture.html');
    expect(calls.at(-1)).toMatchObject({ method: 'Page.navigate', params: { url: 'file:///allowed/fixture.html' } });
  });

  it('refuses every file:// URL when exactFileUrls is absent, even with a permissive origins list', async () => {
    const { transport, calls } = fakeTransport();
    const executor = new ApplicationExecutor(transport, fullPolicy({ origins: ['null'] }));
    await expect(executor.openTarget('file:///anything.html')).rejects.toThrow(ExecutorPolicyError);
    expect(calls).toHaveLength(0);
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

  const SUBMIT_ONLY_TREE = {
    root: {
      nodeName: 'BODY',
      nodeType: 1,
      backendNodeId: 1,
      children: [{ nodeName: 'BUTTON', nodeType: 1, backendNodeId: 2, children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 0, nodeValue: 'Submit Application' }] }],
    },
  };

  it('never retries a field-less page that already has a submit control -- a real, actionable "review and submit" step, not an empty/loading page', async () => {
    // Real gap found during PR #214's own review: the retry condition originally checked only
    // fields.length, so a field-less final-review page would have burned the entire retry budget
    // even though it was already fully actionable via its submit button.
    let calls = 0;
    const transport: CdpTransport = {
      async sendCommand(method) {
        if (method === 'DOM.getDocument') calls += 1;
        return SUBMIT_ONLY_TREE;
      },
    };
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    expect(calls).toBe(1);
    expect(snapshot.fields).toEqual([]);
    expect(snapshot.submitControls).toHaveLength(1);
  });

  it('stops retrying as soon as fields alone have rendered, even with no submit control yet -- deliberately not waiting for both', async () => {
    // The retry condition only continues while BOTH fields and submitControls are still empty
    // (fixing the field-less "review and submit" page above); it does not wait for both to be
    // non-empty. A page whose fields render before its submit button does is left as a single,
    // possibly-incomplete read -- the same behavior this loop already had for fields alone before
    // submitControls existed, deliberately not extended, since retrying until every kind of content
    // has appeared would reintroduce the same "wait for something that might never come" risk this
    // loop's bounded retry exists to avoid.
    const FIELDS_ONLY_TREE = { root: { nodeName: 'BODY', nodeType: 1, backendNodeId: 1, children: [{ nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'text', 'name', 'fullName'] }] } };
    let calls = 0;
    const transport: CdpTransport = {
      async sendCommand(method) {
        if (method === 'DOM.getDocument') calls += 1;
        return FIELDS_ONLY_TREE;
      },
    };
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    expect(calls).toBe(1);
    expect(snapshot.submitControls).toEqual([]);
  });

  const CHALLENGE_TREE = {
    root: {
      nodeName: 'BODY',
      nodeType: 1,
      backendNodeId: 1,
      children: [{ nodeName: 'IFRAME', nodeType: 1, backendNodeId: 2, attributes: ['src', 'https://www.google.com/recaptcha/api2/anchor'] }],
    },
  };

  it('surfaces challengeDetected on the returned snapshot', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': CHALLENGE_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    expect(snapshot.challengeDetected).toBe(true);
  });

  it('stops the empty-snapshot retry loop as soon as a challenge is detected, even with zero fields', async () => {
    // A CAPTCHA page often has no fillable fields at all -- without this, snapshot() would burn
    // through the full retry budget waiting for fields that will never appear behind a challenge.
    let calls = 0;
    const transport: CdpTransport = {
      async sendCommand(method) {
        if (method === 'DOM.getDocument') calls += 1;
        return CHALLENGE_TREE;
      },
    };
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    expect(calls).toBe(1);
    expect(snapshot.fields).toEqual([]);
    expect(snapshot.challengeDetected).toBe(true);
  });
});

describe('ApplicationExecutor: fill', () => {
  it('focuses the real backend node, replaces its whole contents, blurs to commit, then reads back', async () => {
    // The sequence #277 made explicit. `Input.insertText` alone inserts at the caret, so the
    // selectAll before it is what makes this a replace rather than an append; the Tab after it is
    // what commits the value (a real `change` fires on blur); and the read-back is what turns
    // "a command was sent" into "the control holds this".
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const nameField = snapshot.fields.find((f) => f.controlType === 'text')!;

    await executor.fill(nameField.fieldRef, 'Jamie Rivera');

    // focus, selectAll (down/up), insertText, Tab (down/up), read-back.
    const relevant = calls.slice(-7);
    expect(relevant[0]).toMatchObject({ method: 'DOM.focus', params: { backendNodeId: 2 } });
    expect(relevant[1]).toMatchObject({ method: 'Input.dispatchKeyEvent', params: { commands: ['selectAll'] } });
    expect(relevant[3]).toMatchObject({ method: 'Input.insertText', params: { text: 'Jamie Rivera' } });
    expect(relevant[4]).toMatchObject({ method: 'Input.dispatchKeyEvent', params: { key: 'Tab', type: 'keyDown' } });
    expect(calls.at(-1)).toMatchObject({ method: 'Accessibility.getPartialAXTree', params: { backendNodeId: 2 } });
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

  it('clicks nothing for a checkbox fill of "false" when it is already unchecked, but still reads it back', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const checkbox = snapshot.fields.find((f) => f.controlType === 'checkbox')!;
    const before = calls.length;

    await executor.fill(checkbox.fieldRef, 'false');

    // No click: the box is already in the desired state. But the read-back still happens (#277) --
    // "we decided not to touch it" is not evidence of what it holds, and a box the page had
    // re-rendered between the snapshot and now would otherwise go unnoticed entirely.
    expect(calls.slice(before).map((c) => c.method)).toEqual(['Accessibility.getPartialAXTree']);
  });

  it('clicks nothing for a checkbox fill of "true" when it is already checked', async () => {
    const preCheckedTree = {
      root: {
        nodeName: 'BODY',
        nodeType: 1,
        backendNodeId: 1,
        children: [{ nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'checkbox', 'name', 'hasPriorExperience', 'checked', ''] }],
      },
    };
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': preCheckedTree });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    expect(snapshot.fields[0]!.checked).toBe(true);
    const before = calls.length;

    await executor.fill(snapshot.fields[0]!.fieldRef, 'true');
    // Already in the desired state, so no click -- only the read-back (#277).
    expect(calls.slice(before).map((c) => c.method)).toEqual(['Accessibility.getPartialAXTree']);
  });

  it('clicks a pre-checked checkbox to uncheck it when the value is "false"', async () => {
    // Real gap found during #201's review: fill() used to assume every checkbox starts unchecked,
    // so a validated `value: 'false'` could never actually uncheck a pre-checked box.
    const preCheckedTree = {
      root: {
        nodeName: 'BODY',
        nodeType: 1,
        backendNodeId: 1,
        children: [{ nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'checkbox', 'name', 'hasPriorExperience', 'checked', ''] }],
      },
    };
    const { transport, calls } = fakeTransport({
      'DOM.getDocument': preCheckedTree,
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();

    await executor.fill(snapshot.fields[0]!.fieldRef, 'false');

    const mouseCalls = calls.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(mouseCalls).toHaveLength(2); // pressed + released, the same real click as checking one
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

const MULTI_OPTION_SELECT_TREE = {
  root: {
    nodeName: 'BODY',
    nodeType: 1,
    backendNodeId: 1,
    children: [
      {
        nodeName: 'SELECT',
        nodeType: 1,
        backendNodeId: 2,
        attributes: ['name', 'workAuthorization'],
        children: [
          { nodeName: 'OPTION', nodeType: 1, backendNodeId: 3, attributes: ['value', 'no'], children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 0, nodeValue: 'No' }] },
          { nodeName: 'OPTION', nodeType: 1, backendNodeId: 4, attributes: ['value', 'yes'], children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 0, nodeValue: 'Yes' }] },
          { nodeName: 'OPTION', nodeType: 1, backendNodeId: 5, attributes: ['value', 'sponsor'], children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 0, nodeValue: 'Needs sponsorship' }] },
        ],
      },
    ],
  },
};

describe('ApplicationExecutor: select', () => {
  it('focuses the select then drives it to the option index with arrow keys and Enter', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const countryField = snapshot.fields.find((f) => f.controlType === 'select')!;
    const option = countryField.options![0]!;

    await executor.select(countryField.fieldRef, option.optionRef);

    // NAME_INPUT_TREE's select has exactly one option (index 0): focus, one normalizing ArrowUp
    // (options.length -- see select()'s own doc comment on why this always runs, even for index 0),
    // zero ArrowDown (index 0), then Enter.
    // ...followed by the blur that commits the selection and the read-back that verifies it (#277).
    const relevant = calls.slice(-6);
    expect(relevant[0]).toMatchObject({ method: 'DOM.focus', params: { backendNodeId: 4 } });
    expect(relevant[1]).toMatchObject({ method: 'Input.dispatchKeyEvent', params: { key: 'ArrowUp' } });
    expect(relevant[2]).toMatchObject({ method: 'Input.dispatchKeyEvent', params: { key: 'Enter' } });
    expect(relevant[3]).toMatchObject({ method: 'Input.dispatchKeyEvent', params: { key: 'Tab', type: 'keyDown' } });
    expect(calls.at(-1)).toMatchObject({ method: 'Accessibility.getPartialAXTree', params: { backendNodeId: 4 } });
  });

  it('refuses an optionRef that is not on the given field', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const countryField = snapshot.fields.find((f) => f.controlType === 'select')!;
    await expect(executor.select(countryField.fieldRef, 'o0000000000000ff')).rejects.toThrow(ExecutorPolicyError);
  });

  it('normalizes to index 0 before navigating, regardless of the control\'s real starting selection', async () => {
    // Real gap found during #201's review: counting only ArrowDown presses from wherever the
    // control happens to already be assumes it always starts at index 0, which a real form with a
    // non-first `<option selected>` (or a second select() call on the same field) would violate.
    // This asserts the actual fix: a full options.length-sized burst of ArrowUp presses always
    // runs first, then exactly `index` ArrowDown presses -- never fewer, regardless of history.
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': MULTI_OPTION_SELECT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const field = snapshot.fields[0]!;
    const sponsorOption = field.options!.find((o) => o.label === 'Needs sponsorship')!;

    await executor.select(field.fieldRef, sponsorOption.optionRef);

    const keyEvents = calls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => (c.params as { key: string }).key);
    const arrowUpCount = keyEvents.filter((k) => k === 'ArrowUp').length;
    const arrowDownCount = keyEvents.filter((k) => k === 'ArrowDown').length;
    expect(arrowUpCount).toBe(3); // options.length
    expect(arrowDownCount).toBe(2); // sponsorOption's index
    // The drive itself still ends on Enter; the Tab pair after it is the commit blur (#277).
    expect(keyEvents.filter((k) => k !== 'Tab').at(-1)).toBe('Enter');
    // Every ArrowUp precedes every ArrowDown, so the normalize pass always completes before the
    // real navigation starts -- an interleaved order would defeat the whole point of resetting first.
    expect(keyEvents.lastIndexOf('ArrowUp')).toBeLessThan(keyEvents.indexOf('ArrowDown'));
  });

  it('calling select() twice on the same field re-normalizes each time, landing on the second target', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': MULTI_OPTION_SELECT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const field = snapshot.fields[0]!;
    const sponsorOption = field.options!.find((o) => o.label === 'Needs sponsorship')!; // index 2
    const noOption = field.options!.find((o) => o.label === 'No')!; // index 0

    await executor.select(field.fieldRef, sponsorOption.optionRef);
    calls.length = 0; // isolate the second call's own key sequence
    await executor.select(field.fieldRef, noOption.optionRef);

    const keyEvents = calls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => (c.params as { key: string }).key);
    // Re-normalizes with a full burst regardless of where the first call left the control (index
    // 2), then takes zero ArrowDown steps to reach index 0.
    expect(keyEvents.filter((k) => k === 'ArrowUp')).toHaveLength(3);
    expect(keyEvents.filter((k) => k === 'ArrowDown')).toHaveLength(0);
  });
});

const A_VALID_PDF = { localFilePath: '/staged/resume.pdf', mimeType: 'application/pdf', byteSize: 1000 };

describe('ApplicationExecutor: attach', () => {
  it('calls DOM.setFileInputFiles with the real backend node and given path', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const fileField = snapshot.fields.find((f) => f.controlType === 'file')!;

    await executor.attach(fileField.fieldRef, A_VALID_PDF);

    // The upload, then the read-back that turns "the command resolved" into "the control reports
    // holding this file" (#277).
    expect(calls.at(-2)).toMatchObject({ method: 'DOM.setFileInputFiles', params: { files: ['/staged/resume.pdf'], backendNodeId: 6 } });
    expect(calls.at(-1)).toMatchObject({ method: 'Accessibility.getPartialAXTree', params: { backendNodeId: 6 } });
  });

  it('refuses to attach to a non-file field', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const textField = snapshot.fields.find((f) => f.controlType === 'text')!;
    await expect(executor.attach(textField.fieldRef, A_VALID_PDF)).rejects.toThrow(ExecutorPolicyError);
  });

  it('refuses a file larger than the policy\'s upload byte limit, never reaching the transport', async () => {
    // Real gap found during #201's review: `uploadConstraints` was declared on the policy shape
    // but never actually enforced anywhere.
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(
      transport,
      fullPolicy({ uploadConstraints: { maxBytes: 500, mimeTypes: ['application/pdf'] } }),
    );
    const snapshot = await executor.snapshot();
    const fileField = snapshot.fields.find((f) => f.controlType === 'file')!;
    const before = calls.length;

    await expect(
      executor.attach(fileField.fieldRef, { localFilePath: '/staged/huge.pdf', mimeType: 'application/pdf', byteSize: 501 }),
    ).rejects.toThrow(ExecutorPolicyError);
    expect(calls.length).toBe(before); // never reached DOM.setFileInputFiles
  });

  it('refuses a mime type the policy does not allow, never reaching the transport', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(
      transport,
      fullPolicy({ uploadConstraints: { maxBytes: 10_000_000, mimeTypes: ['application/pdf'] } }),
    );
    const snapshot = await executor.snapshot();
    const fileField = snapshot.fields.find((f) => f.controlType === 'file')!;
    const before = calls.length;

    await expect(
      executor.attach(fileField.fieldRef, { localFilePath: '/staged/resume.exe', mimeType: 'application/x-msdownload', byteSize: 100 }),
    ).rejects.toThrow(ExecutorPolicyError);
    expect(calls.length).toBe(before);
  });

  it('allows a file exactly at the policy byte limit', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(
      transport,
      fullPolicy({ uploadConstraints: { maxBytes: 500, mimeTypes: ['application/pdf'] } }),
    );
    const snapshot = await executor.snapshot();
    const fileField = snapshot.fields.find((f) => f.controlType === 'file')!;

    await executor.attach(fileField.fieldRef, { localFilePath: '/staged/exact.pdf', mimeType: 'application/pdf', byteSize: 500 });
    expect(calls.map((c) => c.method)).toContain('DOM.setFileInputFiles');
  });

  it('replaces, never accumulates, a file input\'s selection when the same field is attached twice', async () => {
    // The property #273's retry case rests on: `DOM.setFileInputFiles` always carries the full
    // intended selection, so a second attach cannot leave the first file behind alongside it.
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const fileField = snapshot.fields.find((f) => f.controlType === 'file')!;

    await executor.attach(fileField.fieldRef, A_VALID_PDF);
    await executor.attach(fileField.fieldRef, A_VALID_PDF);

    const uploads = calls.filter((call) => call.method === 'DOM.setFileInputFiles');
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) expect(upload.params).toMatchObject({ files: ['/staged/resume.pdf'], backendNodeId: 6 });
  });
});

describe('ApplicationExecutor: readBackAttachment', () => {
  /** One `Accessibility.getFullAXTree` response naming the fixture tree's file input (backend node
   * 6) -- what a real browser reports once a file is actually selected on that control. */
  function axTree(reported: unknown, backendDOMNodeId = 6) {
    return { nodes: [{ backendDOMNodeId, value: { type: 'string', value: reported } }] };
  }

  it('returns what the browser reports on that exact control, matched by backend node id', async () => {
    const { transport, calls } = fakeTransport({
      'DOM.getDocument': NAME_INPUT_TREE,
      'Accessibility.getFullAXTree': {
        nodes: [
          { backendDOMNodeId: 2, value: { type: 'string', value: 'a totally different control' } },
          { backendDOMNodeId: 6, value: { type: 'string', value: 'abc123-resume.pdf' } },
        ],
      },
    });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const fileField = snapshot.fields.find((f) => f.controlType === 'file')!;

    await executor.attach(fileField.fieldRef, A_VALID_PDF);

    expect(await executor.readBackAttachment(fileField.fieldRef)).toBe('abc123-resume.pdf');
    expect(calls.at(-1)?.method).toBe('Accessibility.getFullAXTree');
  });

  it('reports an empty control as exactly what the page said, never as a confirmed attachment', async () => {
    const { transport } = fakeTransport({
      'DOM.getDocument': NAME_INPUT_TREE,
      'Accessibility.getFullAXTree': axTree('No file chosen'),
    });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const fileField = snapshot.fields.find((f) => f.controlType === 'file')!;

    expect(await executor.readBackAttachment(fileField.fieldRef)).toBe('No file chosen');
  });

  it('returns null when the control is absent from the tree, or reports a non-string value', async () => {
    const absent = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE, 'Accessibility.getFullAXTree': { nodes: [] } });
    const absentExecutor = new ApplicationExecutor(absent.transport, fullPolicy());
    const absentField = (await absentExecutor.snapshot()).fields.find((f) => f.controlType === 'file')!;
    expect(await absentExecutor.readBackAttachment(absentField.fieldRef)).toBeNull();

    const nonString = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE, 'Accessibility.getFullAXTree': axTree(42) });
    const nonStringExecutor = new ApplicationExecutor(nonString.transport, fullPolicy());
    const nonStringField = (await nonStringExecutor.snapshot()).fields.find((f) => f.controlType === 'file')!;
    expect(await nonStringExecutor.readBackAttachment(nonStringField.fieldRef)).toBeNull();
  });

  it('refuses a non-file field and an unknown fieldRef, never reaching the transport', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const textField = snapshot.fields.find((f) => f.controlType === 'text')!;
    const before = calls.length;

    await expect(executor.readBackAttachment(textField.fieldRef)).rejects.toThrow(ExecutorPolicyError);
    await expect(executor.readBackAttachment('f0000000000000000')).rejects.toThrow(ExecutorPolicyError);
    expect(calls.length).toBe(before);
  });

  it('refuses on a policy that does not permit uploads at all', async () => {
    const { transport, calls } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy({ killSwitches: { navigate: false, fill: false, upload: true, submit: false } }));
    const snapshot = await executor.snapshot();
    const fileField = snapshot.fields.find((f) => f.controlType === 'file')!;
    const before = calls.length;

    await expect(executor.readBackAttachment(fileField.fieldRef)).rejects.toThrow(ExecutorPolicyError);
    expect(calls.length).toBe(before);
  });
});

describe('ApplicationExecutor: submit', () => {
  it('clicks the resolved submit control at its real box-model center', async () => {
    const { transport, calls } = fakeTransport({
      'DOM.getDocument': NAME_INPUT_TREE,
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    expect(snapshot.submitControls).toHaveLength(1);

    await executor.submit(snapshot.submitControls[0]!.controlRef);

    const mouseCalls = calls.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(mouseCalls).toHaveLength(2); // pressed + released, the same real click fill() uses for a checkbox
    expect(mouseCalls[0]).toMatchObject({ params: { type: 'mousePressed', x: 20, y: 30 } });
    expect(mouseCalls[1]).toMatchObject({ params: { type: 'mouseReleased', x: 20, y: 30 } });
  });

  it('refuses submit when the policy does not list it in allowedActions', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy({ allowedActions: ['openTarget', 'snapshot'] }));
    const snapshot = await executor.snapshot();
    await expect(executor.submit(snapshot.submitControls[0]!.controlRef)).rejects.toThrow(ExecutorPolicyError);
  });

  it('refuses submit when the submit kill switch is on, even though allowedActions lists it', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(
      transport,
      fullPolicy({ killSwitches: { navigate: false, fill: false, upload: false, submit: true } }),
    );
    const snapshot = await executor.snapshot();
    await expect(executor.submit(snapshot.submitControls[0]!.controlRef)).rejects.toThrow(ExecutorPolicyError);
  });

  it('refuses an unknown controlRef', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    await executor.snapshot();
    await expect(executor.submit('c0000000000000ff')).rejects.toThrow(ExecutorPolicyError);
  });

  it('refuses to submit before any snapshot has been taken', async () => {
    const { transport } = fakeTransport();
    const executor = new ApplicationExecutor(transport, fullPolicy());
    await expect(executor.submit('c0000000000000ff')).rejects.toThrow(ExecutorPolicyError);
  });

  it('refuses a controlRef from a stale (prior-generation) snapshot', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const first = await executor.snapshot();
    await executor.snapshot(); // bumps the generation, replacing #currentSnapshot
    await expect(executor.submit(first.submitControls[0]!.controlRef)).rejects.toThrow(ExecutorPolicyError);
  });

  const DECOY_BUTTON_TREE = {
    root: {
      nodeName: 'BODY',
      nodeType: 1,
      backendNodeId: 1,
      children: [
        { nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'text', 'name', 'fullName'] },
        { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 3, children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 0, nodeValue: 'Save as draft' }] },
        { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 4, children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 0, nodeValue: 'Submit Application' }] },
      ],
    },
  };

  it('refuses to submit a real, present controlRef that is not the one resolveSubmitControl would pick -- re-deriving resolution rather than trusting the caller', async () => {
    // A real gap found during PR #214's own review: an earlier version of submit() trusted
    // whatever controlRef the caller passed, as long as it was a real ref in submitControls at
    // all -- so a caller bug (or any future code path) handing it the "Save as draft" button's ref
    // instead of the real submit button's had nothing here to stop it.
    const { transport } = fakeTransport({ 'DOM.getDocument': DECOY_BUTTON_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const decoy = snapshot.submitControls.find((c) => c.label === 'Save as draft')!;
    await expect(executor.submit(decoy.controlRef)).rejects.toThrow(ExecutorPolicyError);
  });

  it('still submits the real, correctly-resolved control when a decoy is present alongside it', async () => {
    const { transport, calls } = fakeTransport({
      'DOM.getDocument': DECOY_BUTTON_TREE,
      'DOM.getBoxModel': { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } },
    });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const real = snapshot.submitControls.find((c) => c.label === 'Submit Application')!;

    await executor.submit(real.controlRef);

    expect(calls.filter((c) => c.method === 'Input.dispatchMouseEvent')).toHaveLength(2);
  });

  const AMBIGUOUS_TREE = {
    root: {
      nodeName: 'BODY',
      nodeType: 1,
      backendNodeId: 1,
      children: [
        { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 2, children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 0, nodeValue: 'Submit' }] },
        { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 3, children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 0, nodeValue: 'Apply' }] },
      ],
    },
  };

  it('refuses to submit either control when resolution is ambiguous (two equally plausible candidates)', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': AMBIGUOUS_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    expect(snapshot.submitControls).toHaveLength(2);
    for (const control of snapshot.submitControls) {
      await expect(executor.submit(control.controlRef)).rejects.toThrow(ExecutorPolicyError);
    }
  });

  const CHALLENGE_WITH_SUBMIT_TREE = {
    root: {
      nodeName: 'BODY',
      nodeType: 1,
      backendNodeId: 1,
      children: [
        { nodeName: 'IFRAME', nodeType: 1, backendNodeId: 2, attributes: ['src', 'https://www.google.com/recaptcha/api2/anchor'] },
        { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 3, children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 0, nodeValue: 'Submit Application' }] },
      ],
    },
  };

  it('refuses to submit when the current snapshot has an active CAPTCHA challenge, even with an otherwise-valid resolved control', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': CHALLENGE_WITH_SUBMIT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    expect(snapshot.challengeDetected).toBe(true);
    expect(snapshot.submitControls).toHaveLength(1); // the button itself resolves unambiguously
    await expect(executor.submit(snapshot.submitControls[0]!.controlRef)).rejects.toThrow(ExecutorPolicyError);
  });
});

describe('ApplicationExecutor: observeSubmissionOutcome (#271)', () => {
  const BOX = { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };

  function textNode(value: string) {
    return { nodeName: '#text', nodeType: 3, backendNodeId: 0, nodeValue: value };
  }

  /** The fixture form, plus whatever the page turns into after the click. Nothing here reaches a
   * network at all: the "page" is two hand-built CDP trees and a swap on the click. */
  function submitFixture(afterClickTree: unknown) {
    let clicked = false;
    const calls: string[] = [];
    const transport: CdpTransport = {
      async sendCommand(method) {
        calls.push(method);
        if (method === 'DOM.getBoxModel') return BOX;
        if (method === 'Input.dispatchMouseEvent') {
          clicked = true;
          return {};
        }
        if (method === 'DOM.getDocument') return clicked ? afterClickTree : NAME_INPUT_TREE;
        return {};
      },
    };
    return { transport, calls };
  }

  const REQUIRED_ERROR_TREE = {
    root: {
      nodeName: 'BODY',
      nodeType: 1,
      backendNodeId: 1,
      children: [
        { nodeName: 'DIV', nodeType: 1, backendNodeId: 8, attributes: ['class', 'field-error'], children: [textNode('Full name is required')] },
        { nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'text', 'name', 'fullName', 'aria-invalid', 'true'] },
        { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 7, children: [textNode('Submit Application')] },
      ],
    },
  };

  const CONFIRMATION_TREE = {
    root: {
      nodeName: 'BODY',
      nodeType: 1,
      backendNodeId: 1,
      children: [
        { nodeName: 'H1', nodeType: 1, backendNodeId: 2, children: [textNode('Your application has been submitted')] },
        { nodeName: 'P', nodeType: 1, backendNodeId: 3, children: [textNode('Application reference: FIXTURE-2026-000123')] },
      ],
    },
  };

  it('acceptance 1: a click whose handler returns but leaves a required-field error is never submitted', async () => {
    const { transport } = submitFixture(REQUIRED_ERROR_TREE);
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    await executor.submit(snapshot.submitControls[0]!.controlRef); // resolves perfectly normally

    const report = await executor.observeSubmissionOutcome({ timeoutMs: 1_000, pollIntervalMs: 10 });

    expect(report.outcome).toBe('rejected');
    expect(report).toMatchObject({ reason: 'form_validation_error' });
  });

  it('acceptance 2: a confirmation page that replaced the form records submitted with a real evidence reference', async () => {
    const { transport } = submitFixture(CONFIRMATION_TREE);
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    await executor.submit(snapshot.submitControls[0]!.controlRef);

    const report = await executor.observeSubmissionOutcome({ timeoutMs: 1_000, pollIntervalMs: 10 });

    expect(report.outcome).toBe('submitted');
    expect(report.outcome === 'submitted' && report.evidence.kind).toBe('confirmation_page');
    expect(report.observedAt).toEqual(expect.any(String));
  });

  it('waits for a confirmation that only appears a few polls after the click, rather than deciding on the first read', async () => {
    let clicked = false;
    let readsAfterClick = 0;
    const transport: CdpTransport = {
      async sendCommand(method) {
        if (method === 'DOM.getBoxModel') return BOX;
        if (method === 'Input.dispatchMouseEvent') {
          clicked = true;
          return {};
        }
        if (method === 'DOM.getDocument') {
          if (!clicked) return NAME_INPUT_TREE;
          readsAfterClick += 1;
          // The form is gone immediately, but the confirmation text lands three reads later.
          return readsAfterClick < 3
            ? { root: { nodeName: 'BODY', nodeType: 1, backendNodeId: 1, children: [] } }
            : CONFIRMATION_TREE;
        }
        return {};
      },
    };
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    await executor.submit(snapshot.submitControls[0]!.controlRef);

    const report = await executor.observeSubmissionOutcome({ timeoutMs: 5_000, pollIntervalMs: 1 });

    expect(report.outcome).toBe('submitted');
    expect(readsAfterClick).toBe(3);
  });

  it('acceptance 3: a page that can no longer be read after the click reports unknown (navigation lost), never submitted', async () => {
    let clicked = false;
    const transport: CdpTransport = {
      async sendCommand(method) {
        if (method === 'DOM.getBoxModel') return BOX;
        if (method === 'Input.dispatchMouseEvent') {
          clicked = true;
          return {};
        }
        if (method === 'DOM.getDocument') {
          if (clicked) throw new Error('the renderer went away');
          return NAME_INPUT_TREE;
        }
        return {};
      },
    };
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    await executor.submit(snapshot.submitControls[0]!.controlRef);

    const report = await executor.observeSubmissionOutcome({ timeoutMs: 1_000, pollIntervalMs: 10 });

    expect(report).toMatchObject({ outcome: 'unknown', reason: 'navigation_lost' });
    expect(report.detail).toContain('the renderer went away');
  });

  it('acceptance 3: a form still standing with nothing conclusive times out into unknown, under a real bounded budget', async () => {
    vi.useFakeTimers();
    try {
      const { transport, calls } = submitFixture(NAME_INPUT_TREE); // unchanged page: the click did nothing visible
      const executor = new ApplicationExecutor(transport, fullPolicy());
      const snapshot = await executor.snapshot();
      await executor.submit(snapshot.submitControls[0]!.controlRef);

      const pending = executor.observeSubmissionOutcome();
      await vi.advanceTimersByTimeAsync(60_000);
      const report = await pending;

      expect(report).toMatchObject({ outcome: 'unknown', reason: 'observation_timeout' });
      // Bounded, and emphatically never a second click: retrying a submit is the exact thing an
      // unknown outcome exists to prevent.
      expect(calls.filter((method) => method === 'Input.dispatchMouseEvent')).toHaveLength(2); // the one press/release from submit()
    } finally {
      vi.useRealTimers();
    }
  });

  it('acceptance 5: an HTTP success carrying an application-error payload is not accepted as delivery, even on a confirmation page', async () => {
    const { transport } = submitFixture(CONFIRMATION_TREE);
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    await executor.submit(snapshot.submitControls[0]!.controlRef);

    const report = await executor.observeSubmissionOutcome({
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      response: { status: 200, body: JSON.stringify({ errors: [{ field: 'workAuthorization', message: 'unanswered' }] }) },
    });

    expect(report).toMatchObject({ outcome: 'rejected', reason: 'application_error_payload' });
  });

  it('never claims a confirmation the page was already showing before the click', async () => {
    // The same tree before and after: a posting whose own copy reads "thank you for applying".
    const BOILERPLATE_TREE = {
      root: {
        nodeName: 'BODY',
        nodeType: 1,
        backendNodeId: 1,
        children: [
          { nodeName: 'P', nodeType: 1, backendNodeId: 2, children: [textNode('Thank you for applying to Fixture Employer.')] },
          { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 7, children: [textNode('Submit Application')] },
        ],
      },
    };
    const transport: CdpTransport = {
      async sendCommand(method) {
        if (method === 'DOM.getBoxModel') return BOX;
        if (method === 'DOM.getDocument') return BOILERPLATE_TREE;
        return {};
      },
    };
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    await executor.submit(snapshot.submitControls[0]!.controlRef);

    const report = await executor.observeSubmissionOutcome({ timeoutMs: 30, pollIntervalMs: 10 });
    expect(report.outcome).toBe('unknown');
  });

  it('refuses to report on an executor that never clicked submit at all', async () => {
    const { transport } = fakeTransport({ 'DOM.getDocument': NAME_INPUT_TREE });
    const executor = new ApplicationExecutor(transport, fullPolicy());
    await executor.snapshot();
    await expect(executor.observeSubmissionOutcome()).rejects.toThrow(ExecutorPolicyError);
  });

  it('only ever sends allowlisted CDP methods while observing', async () => {
    const { transport, calls } = submitFixture(CONFIRMATION_TREE);
    const executor = new ApplicationExecutor(transport, fullPolicy());
    const snapshot = await executor.snapshot();
    await executor.submit(snapshot.submitControls[0]!.controlRef);
    await executor.observeSubmissionOutcome({ timeoutMs: 100, pollIntervalMs: 10 });

    const { isAllowedCdpMethod } = await import('../src/cdp-allowlist.js');
    for (const method of calls) expect(isAllowedCdpMethod(method), method).toBe(true);
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
    await executor.attach(snapshot.fields[3]!.fieldRef, { localFilePath: '/tmp/x.pdf', mimeType: 'application/pdf', byteSize: 100 });
    await executor.capture();
    await executor.submit(snapshot.submitControls[0]!.controlRef);

    const { isAllowedCdpMethod } = await import('../src/cdp-allowlist.js');
    for (const call of calls) {
      expect(isAllowedCdpMethod(call.method), call.method).toBe(true);
    }
    expect(calls.length).toBeGreaterThan(5); // sanity: this test actually exercised real calls
  });
});
