import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CdpDomNode } from '@agent-dock/application-executor';
import { FIXTURE_REVIEW_POLICY } from '../electron/application-target-policies.js';

// The real fixture policy's own allowed URL, not an arbitrary literal -- since #201's review fix,
// `openTarget` refuses any file:// URL not in `exactFileUrls`, so this must be the exact one.
const FIXTURE_URL = FIXTURE_REVIEW_POLICY.exactFileUrls![0]!;

/**
 * Exercises `application-review-session.ts`'s registry/validate/apply orchestration against a
 * fake `CdpTransport` (via a mocked `application-view.js`), the same layering
 * `application-view.test.ts` uses one level down: that file proves the real `webContents.debugger`
 * wiring; this file proves what sits on top of it, without re-proving either half against the
 * other. `packages/application-executor`'s own suite already proves the executor/validator
 * mechanics in isolation -- this file is about the sequencing this module adds: duplicate-open
 * refusal, unknown-policy refusal, validate-then-apply, and cleanup on both the happy and the
 * failure path.
 */
const { createApplicationView } = vi.hoisted(() => ({ createApplicationView: vi.fn() }));

vi.mock('../electron/application-view.js', () => ({ createApplicationView }));

const TREE: CdpDomNode = {
  nodeName: 'BODY',
  nodeType: 1,
  backendNodeId: 1,
  children: [
    { nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'text', 'name', 'fullName', 'required', ''] },
    {
      nodeName: 'SELECT',
      nodeType: 1,
      backendNodeId: 3,
      attributes: ['name', 'workAuthorization'],
      children: [
        { nodeName: 'OPTION', nodeType: 1, backendNodeId: 4, attributes: ['value', 'yes'], children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 5, nodeValue: 'Yes' }] },
        { nodeName: 'OPTION', nodeType: 1, backendNodeId: 6, attributes: ['value', 'no'], children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 7, nodeValue: 'No' }] },
      ],
    },
    { nodeName: 'INPUT', nodeType: 1, backendNodeId: 8, attributes: ['type', 'checkbox', 'name', 'hasDriversLicense'] },
  ],
};

function fakeView() {
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case 'Page.navigate':
        return {};
      case 'DOM.getDocument':
        return { root: TREE };
      case 'Page.captureScreenshot':
        return { data: 'ZmFrZS1zY3JlZW5zaG90' };
      case 'DOM.getBoxModel':
        return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      case 'DOM.focus':
      case 'Input.insertText':
      case 'Input.dispatchKeyEvent':
      case 'Input.dispatchMouseEvent':
        return {};
      default:
        throw new Error(`unexpected CDP method in test: ${method} ${JSON.stringify(params)}`);
    }
  });
  return { view: {}, transport: { sendCommand }, show: vi.fn(), hide: vi.fn(), destroy: vi.fn() };
}

beforeEach(() => {
  createApplicationView.mockReset();
  createApplicationView.mockImplementation(() => fakeView());
});

async function importSession() {
  vi.resetModules();
  return import('../electron/application-review-session.js');
}

describe('application-review-session', () => {
  it('opens a review, returning a real multi-field snapshot and a screenshot', async () => {
    const { openApplicationReview } = await importSession();
    const result = await openApplicationReview({
      attemptId: '11111111-1111-4111-8111-111111111111',
      policyId: 'ashby-fixture-test-only',
      targetUrl: FIXTURE_URL,
    });
    expect(result.screenshotBase64).toBe('ZmFrZS1zY3JlZW5zaG90');
    expect(result.snapshot.fields).toHaveLength(3);
    expect(result.snapshot.fields.map((f) => f.label)).toEqual(['fullName', 'workAuthorization', 'hasDriversLicense']);
  });

  it('refuses an unknown policy id before ever creating a view', async () => {
    const { openApplicationReview } = await importSession();
    await expect(
      openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'not-a-real-policy', targetUrl: FIXTURE_URL }),
    ).rejects.toThrow(/unknown application target policy/);
    expect(createApplicationView).not.toHaveBeenCalled();
  });

  it('refuses to open a second review for an attempt that already has one open', async () => {
    const { openApplicationReview } = await importSession();
    await openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
    await expect(
      openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL }),
    ).rejects.toThrow(/already has an open review/);
  });

  it('destroys the view when openTarget refuses an off-policy origin, leaving no leaked registration', async () => {
    const { openApplicationReview } = await importSession();
    const view = fakeView();
    createApplicationView.mockImplementation(() => view);
    await expect(
      openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: 'https://evil.example/apply' }),
    ).rejects.toThrow(/not allowed by policy/);
    expect(view.destroy).toHaveBeenCalledTimes(1);

    // The failed attempt's id is free to retry, proving nothing was left registered for it.
    await expect(
      openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL }),
    ).resolves.toBeDefined();
  });

  it('applies a valid field map: fills the text field, selects the option, fills the checkbox', async () => {
    const { openApplicationReview, applyApplicationFieldMap } = await importSession();
    const view = fakeView();
    createApplicationView.mockImplementation(() => view);
    const opened = await openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

    const nameField = opened.snapshot.fields.find((f) => f.label === 'fullName')!;
    const authField = opened.snapshot.fields.find((f) => f.label === 'workAuthorization')!;
    const licenseField = opened.snapshot.fields.find((f) => f.label === 'hasDriversLicense')!;
    const yesOption = authField.options!.find((o) => o.label === 'Yes')!;

    const result = await applyApplicationFieldMap({
      attemptId: '11111111-1111-4111-8111-111111111111',
      valueTable: [{ valueRef: 'v0000000000000001', value: 'Ada Lovelace', provenance: 'profile' }, { valueRef: 'v0000000000000002', value: 'true', provenance: 'user_answer' }],
      fieldMap: {
        attemptId: '11111111-1111-4111-8111-111111111111',
        snapshotGeneration: opened.snapshot.generation,
        assignments: [
          { fieldRef: nameField.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000001' } },
          { fieldRef: authField.fieldRef, source: { kind: 'option', optionRef: yesOption.optionRef } },
          { fieldRef: licenseField.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000002' } },
        ],
        unmapped: [],
      },
    });

    expect(result).toEqual({ ok: true, appliedCount: 3 });
    const calledMethods = view.transport.sendCommand.mock.calls.map(([method]) => method as string);
    expect(calledMethods).toContain('Input.insertText'); // fullName
    expect(calledMethods).toContain('Input.dispatchKeyEvent'); // select's arrow/enter drive
    expect(calledMethods).toContain('Input.dispatchMouseEvent'); // checkbox click
  });

  it('refuses (never partially applies) a field map targeting a stale snapshot generation', async () => {
    const { openApplicationReview, applyApplicationFieldMap } = await importSession();
    const opened = await openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
    const nameField = opened.snapshot.fields.find((f) => f.label === 'fullName')!;

    const result = await applyApplicationFieldMap({
      attemptId: '11111111-1111-4111-8111-111111111111',
      valueTable: [{ valueRef: 'v0000000000000001', value: 'Ada Lovelace', provenance: 'profile' }],
      fieldMap: {
        attemptId: '11111111-1111-4111-8111-111111111111',
        snapshotGeneration: opened.snapshot.generation + 1, // stale
        assignments: [{ fieldRef: nameField.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000001' } }],
        unmapped: [],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale_snapshot_generation');
  });

  it('refuses a field map with an artifact assignment, since ownership is never resolved in this slice', async () => {
    const { openApplicationReview, applyApplicationFieldMap } = await importSession();
    const opened = await openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });
    const nameField = opened.snapshot.fields.find((f) => f.label === 'fullName')!;

    const result = await applyApplicationFieldMap({
      attemptId: '11111111-1111-4111-8111-111111111111',
      valueTable: [],
      fieldMap: {
        attemptId: '11111111-1111-4111-8111-111111111111',
        snapshotGeneration: opened.snapshot.generation,
        assignments: [{ fieldRef: nameField.fieldRef, source: { kind: 'artifact', artifactId: '33333333-3333-4333-8333-333333333333' } }],
        unmapped: [],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('artifact_not_owned');
  });

  it('throws when applying a field map for an attempt with no open review', async () => {
    const { applyApplicationFieldMap } = await importSession();
    await expect(
      applyApplicationFieldMap({ attemptId: '22222222-2222-4222-8222-222222222222', valueTable: [], fieldMap: { attemptId: '22222222-2222-4222-8222-222222222222', snapshotGeneration: 1, assignments: [], unmapped: [] } }),
    ).rejects.toThrow(/no open review/);
  });

  it('closeReview destroys the view and frees the attemptId for reuse; is a no-op if never opened', async () => {
    const { openApplicationReview, closeApplicationReview } = await importSession();
    const view = fakeView();
    createApplicationView.mockImplementation(() => view);
    await openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

    await closeApplicationReview('22222222-2222-4222-8222-222222222222'); // no-op
    await closeApplicationReview('11111111-1111-4111-8111-111111111111');
    expect(view.destroy).toHaveBeenCalledTimes(1);

    await expect(
      openApplicationReview({ attemptId: '11111111-1111-4111-8111-111111111111', policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL }),
    ).resolves.toBeDefined();
  });
});
