import { createHash } from 'node:crypto';
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
const workspaceMock = vi.hoisted(() => ({
  getApplicationAttempt: vi.fn(),
  listApplicationAttempts: vi.fn(() => [] as unknown[]),
  listCvDocuments: vi.fn(() => [] as Array<{ id: string; text: string }>),
  listApplicationArtifacts: vi.fn(() => [] as Array<{ kind: string; storagePath: string }>),
  updateApplicationAttempt: vi.fn(),
  findActiveAutomationGrant: vi.fn(() => undefined as unknown),
}));
const { extractPdfText } = vi.hoisted(() => ({ extractPdfText: vi.fn(async () => '') }));
const { notifyAutomaticSubmission } = vi.hoisted(() => ({ notifyAutomaticSubmission: vi.fn() }));

vi.mock('../electron/application-view.js', () => ({ createApplicationView }));
vi.mock('../electron/workspace/repository.js', () => workspaceMock);
vi.mock('../electron/cv-text.js', () => ({ extractPdfText }));
vi.mock('../electron/automatic-submission-notify.js', () => ({ notifyAutomaticSubmission }));
const { readFile } = vi.hoisted(() => ({ readFile: vi.fn(async () => Buffer.from('')) }));
vi.mock('node:fs/promises', () => ({ readFile, default: { readFile } }));

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

const SUBMIT_TREE: CdpDomNode = {
  ...TREE,
  children: [...TREE.children!, { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 9, children: [{ nodeName: '#text', nodeType: 3, backendNodeId: 10, nodeValue: 'Submit Application' }] }],
};

function fakeView(tree: CdpDomNode = TREE) {
  const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case 'Page.navigate':
        return {};
      case 'DOM.getDocument':
        return { root: tree };
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

const FAKE_DB = {} as never;

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

function fakeAttempt(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ATTEMPT_ID,
    applicationId: null,
    vacancyKey: null,
    canonicalUrl: FIXTURE_URL,
    company: 'Acme Corp',
    role: 'Senior Engineer',
    sourceCvId: null,
    sourceCvContentHash: 'cv-hash-v1',
    jdSnapshot: 'We are hiring a Senior Engineer at Acme Corp.',
    jdSnapshotHash: '',
    jdComplete: true,
    workflowVersion: 'v1',
    checkpoint: 'ready',
    checkpointDetail: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    submittedAt: null,
    formStructureHash: null,
    scheduledAutomaticSubmitAt: null,
    submissionMode: null,
    ...overrides,
  };
}

function withRealJdHash<T extends { jdSnapshot: string }>(attempt: T): T & { jdSnapshotHash: string } {
  // submitApplicationReview recomputes the JD hash from jdSnapshot itself (sha256), so a fixture
  // attempt must carry the real hash of its own jdSnapshot text for the gate to pass, matching how
  // a genuinely-created attempt would have been hashed at creation time.
  return { ...attempt, jdSnapshotHash: createHash('sha256').update(attempt.jdSnapshot).digest('hex') };
}

beforeEach(() => {
  createApplicationView.mockReset();
  createApplicationView.mockImplementation(() => fakeView());
  workspaceMock.getApplicationAttempt.mockReset();
  workspaceMock.listApplicationAttempts.mockReset().mockReturnValue([]);
  workspaceMock.listCvDocuments.mockReset().mockReturnValue([]);
  workspaceMock.listApplicationArtifacts.mockReset().mockReturnValue([]);
  workspaceMock.updateApplicationAttempt.mockReset();
  workspaceMock.findActiveAutomationGrant.mockReset().mockReturnValue(undefined);
  notifyAutomaticSubmission.mockReset();
  extractPdfText.mockReset().mockResolvedValue('');
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

  describe('submitApplicationReview (#202)', () => {
    it('refuses when there is no open review for the attempt', async () => {
      const { submitApplicationReview } = await importSession();
      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: false, reason: 'no_open_review', detail: expect.any(String) });
    });

    it('refuses when the current snapshot has no unambiguously-resolvable submit control', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(TREE)); // no submit button at all
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: false, reason: 'unresolved_submit_control', detail: expect.any(String) });
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
    });

    const CHALLENGE_SUBMIT_TREE: CdpDomNode = {
      ...SUBMIT_TREE,
      children: [...SUBMIT_TREE.children!, { nodeName: 'IFRAME', nodeType: 1, backendNodeId: 11, attributes: ['src', 'https://www.google.com/recaptcha/api2/anchor'] }],
    };

    it('refuses when the current snapshot has an active CAPTCHA challenge, before touching the checkpoint at all', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(CHALLENGE_SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: false, reason: 'captcha_detected', detail: expect.any(String) });
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
    });

    it('refuses via the pre-submit gate when the rendered documents do not name the attempt\'s own company/role -- a real tampered/stale-content case', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([{ kind: 'cv_pdf', storagePath: '/fake/resume.pdf' }]);
      extractPdfText.mockResolvedValue('A perfectly nice resume that never mentions the employer or role at all.');

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: false, reason: 'company_not_found_in_documents', detail: expect.any(String) });
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled(); // gate refused before submitting ever began
    });

    it('refuses via the pre-submit gate when the live source CV in the library no longer matches the hash this attempt was created with', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt({ sourceCvId: 'cv-1', sourceCvContentHash: 'hash-of-the-original-cv-text' })));
      workspaceMock.listCvDocuments.mockReturnValue([{ id: 'cv-1', text: 'the CV has since been edited by the user' }]);
      workspaceMock.listApplicationArtifacts.mockReturnValue([{ kind: 'cv_pdf', storagePath: '/fake/resume.pdf' }]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: false, reason: 'source_cv_changed', detail: expect.any(String) });
    });

    it('refuses when the attempt names a sourceCvId that no longer exists in the library', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt({ sourceCvId: 'cv-deleted' })));
      workspaceMock.listCvDocuments.mockReturnValue([]);

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);
      expect(result).toEqual({ ok: false, reason: 'source_cv_not_found', detail: expect.any(String) });
    });

    it('fills, reviews, confirms, and submits for real against the fixture -- the happy path #202 exists for', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      const view = fakeView(SUBMIT_TREE);
      createApplicationView.mockImplementation(() => view);
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([
        { kind: 'cv_pdf', storagePath: '/fake/resume.pdf' },
        { kind: 'cover_letter_pdf', storagePath: '/fake/letter.pdf' },
      ]);
      extractPdfText.mockResolvedValue('Dear Acme Corp, I am excited to apply for the Senior Engineer role.');

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

      expect(result).toEqual({ ok: true });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(1, FAKE_DB, ATTEMPT_ID, { checkpoint: 'submitting' });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(2, FAKE_DB, ATTEMPT_ID, {
        checkpoint: 'submitted',
        submittedAt: expect.any(String),
        submissionMode: 'manual',
        formStructureHash: expect.any(String),
      });
      const calledMethods = view.transport.sendCommand.mock.calls.map(([method]) => method as string);
      expect(calledMethods).toContain('Input.dispatchMouseEvent'); // the real submit click
    });

    it('lands on submission_unknown, never a silent retry or drop, when the submit click itself fails ambiguously', async () => {
      const { openApplicationReview, submitApplicationReview } = await importSession();
      const view = fakeView(SUBMIT_TREE);
      view.transport.sendCommand.mockImplementation(async (method: string) => {
        if (method === 'DOM.getBoxModel') throw new Error('CDP connection dropped');
        if (method === 'DOM.getDocument') return { root: SUBMIT_TREE };
        return {};
      });
      createApplicationView.mockImplementation(() => view);
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([{ kind: 'cv_pdf', storagePath: '/fake/resume.pdf' }]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

      expect(result).toEqual({ ok: false, reason: 'submission_unknown', detail: expect.stringContaining('CDP connection dropped') });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(1, FAKE_DB, ATTEMPT_ID, { checkpoint: 'submitting' });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(2, FAKE_DB, ATTEMPT_ID, {
        checkpoint: 'submission_unknown',
        checkpointDetail: expect.stringContaining('CDP connection dropped'),
      });
    });

    it('reverts to ready (never submission_unknown) when the policy itself refuses the submit action -- nothing ever reached the page', async () => {
      vi.doMock('../electron/application-target-policies.js', () => ({
        resolveApplicationTargetPolicy: () => ({
          ...FIXTURE_REVIEW_POLICY,
          killSwitches: { ...FIXTURE_REVIEW_POLICY.killSwitches, submit: true }, // the actual gate this test exercises
        }),
      }));
      const { openApplicationReview, submitApplicationReview } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: 'ashby-fixture-test-only', targetUrl: FIXTURE_URL });

      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationArtifacts.mockReturnValue([{ kind: 'cv_pdf', storagePath: '/fake/resume.pdf' }]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');

      const result = await submitApplicationReview(FAKE_DB, ATTEMPT_ID);

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('submit_refused');
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(1, FAKE_DB, ATTEMPT_ID, { checkpoint: 'submitting' });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenNthCalledWith(2, FAKE_DB, ATTEMPT_ID, { checkpoint: 'ready', checkpointDetail: expect.any(String) });
    });
  });

  describe('automatic submission (#203)', () => {
    // A dedicated policy, isolated from the shared FIXTURE_REVIEW_POLICY, so rate limits can be
    // set tight enough to actually exercise (the real fixture's own perDay:1000 exists to never
    // get in #202's fixture tests' way, which would make it useless for testing a cap here).
    const AUTOMATION_POLICY_ID = 'ashby-fixture-test-only';
    function automationPolicy(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        ...FIXTURE_REVIEW_POLICY,
        id: AUTOMATION_POLICY_ID,
        rateLimits: { perDay: 2, perEmployerPerDay: 1, minIntervalMs: 0 },
        termsEligibleForAutomation: true,
        ...overrides,
      };
    }
    function mockAutomationPolicy(overrides: Partial<Record<string, unknown>> = {}) {
      const policy = automationPolicy(overrides);
      vi.doMock('../electron/application-target-policies.js', () => ({
        FIXTURE_REVIEW_POLICY: policy,
        resolveApplicationTargetPolicy: (id: string) => (id === policy.id ? policy : undefined),
        resolvePolicyIdForCanonicalUrl: (url: string) => (url === FIXTURE_URL ? policy.id : undefined),
      }));
    }

    const NOW = '2026-02-01T12:00:00.000Z';
    const submittedAttempt = (overrides: Partial<Record<string, unknown>> = {}) =>
      withRealJdHash(fakeAttempt({ checkpoint: 'submitted', submittedAt: '2026-01-31T12:00:00.000Z', submissionMode: 'manual', ...overrides }));

    it('refuses to schedule when the target is not eligible for automation under the terms register, even with an active grant', async () => {
      mockAutomationPolicy({ termsEligibleForAutomation: false });
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });

      const result = evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(result).toEqual({ ok: false, reason: 'not_eligible_for_automation' });
    });

    it('refuses to schedule when no active grant exists', async () => {
      mockAutomationPolicy();
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue(undefined);

      const result = evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(result).toEqual({ ok: false, reason: 'no_active_grant' });
    });

    it('refuses the first attempt at any employer, even with an active grant -- it is always manually reviewed', async () => {
      mockAutomationPolicy();
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationAttempts.mockReturnValue([]); // no prior submission for this employer at all

      const result = evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(result).toMatchObject({ ok: false, reason: 'no_prior_manual_submission_for_employer' });
    });

    it('refuses when the current form structure does not match the employer\'s most recent submission', async () => {
      mockAutomationPolicy();
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationAttempts.mockReturnValue([submittedAttempt({ formStructureHash: 'a-completely-different-hash' })]);

      const result = evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(result).toMatchObject({ ok: false, reason: 'form_structure_changed_since_last_review' });
    });

    it('schedules a real automatic submit, exactly the cancel window out, once every guardrail passes', async () => {
      mockAutomationPolicy();
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission, AUTOMATIC_SUBMIT_CANCEL_WINDOW_MS } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      const opened = await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      const matchingHash = createHash('sha256')
        .update(opened.snapshot.fields.map((f) => `${f.label}|${f.controlType}|${f.required}`).sort().join('||'))
        .digest('hex');
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationAttempts.mockReturnValue([submittedAttempt({ formStructureHash: matchingHash })]);

      const result = evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);

      const expectedAt = new Date(Date.parse(NOW) + AUTOMATIC_SUBMIT_CANCEL_WINDOW_MS).toISOString();
      expect(result).toEqual({ ok: true, scheduledAutomaticSubmitAt: expectedAt });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, { scheduledAutomaticSubmitAt: expectedAt });
    });

    it('the daily automatic-submission cap actually blocks scheduling a queue past it, not just a config value that goes unchecked', async () => {
      mockAutomationPolicy({ rateLimits: { perDay: 1, perEmployerPerDay: 10, minIntervalMs: 0 } });
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      const opened = await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      const matchingHash = createHash('sha256')
        .update(opened.snapshot.fields.map((f) => `${f.label}|${f.controlType}|${f.required}`).sort().join('||'))
        .digest('hex');
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationAttempts.mockReturnValue([
        submittedAttempt({ formStructureHash: matchingHash }),
        // Already one automatic submission in the last 24h -- the perDay:1 cap is already spent.
        submittedAttempt({ id: 'other-attempt', company: 'Beta Inc', submissionMode: 'automatic', submittedAt: '2026-02-01T06:00:00.000Z' }),
      ]);

      const result = evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(result).toEqual({ ok: false, reason: 'daily_cap_reached', detail: expect.any(String) });
    });

    it('cancelling a scheduled automatic submit within the window means it never fires', async () => {
      mockAutomationPolicy();
      const { openApplicationReview, cancelScheduledAutomaticSubmission, fireDueAutomaticSubmissions } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      const scheduledAt = '2026-02-01T12:03:00.000Z';
      workspaceMock.listApplicationAttempts.mockReturnValue([withRealJdHash(fakeAttempt({ scheduledAutomaticSubmitAt: scheduledAt }))]);

      cancelScheduledAutomaticSubmission(FAKE_DB, ATTEMPT_ID);
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, { scheduledAutomaticSubmitAt: null });

      // Once cancelled, this attempt must never be found "due", even asking well after the
      // original schedule would have elapsed.
      workspaceMock.listApplicationAttempts.mockReturnValue([withRealJdHash(fakeAttempt({ scheduledAutomaticSubmitAt: null }))]);
      const fired = await fireDueAutomaticSubmissions(FAKE_DB, '2026-02-01T13:00:00.000Z');
      expect(fired).toEqual([]);
    });

    it('does not fire a scheduled submit before its cancel window has actually elapsed', async () => {
      mockAutomationPolicy();
      const { fireDueAutomaticSubmissions } = await importSession();
      const scheduledAt = '2026-02-01T12:03:00.000Z';
      workspaceMock.listApplicationAttempts.mockReturnValue([withRealJdHash(fakeAttempt({ scheduledAutomaticSubmitAt: scheduledAt }))]);

      const fired = await fireDueAutomaticSubmissions(FAKE_DB, '2026-02-01T12:00:00.000Z'); // before scheduledAt
      expect(fired).toEqual([]);
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalled();
    });

    it('end to end: schedules, then fires for real once the window elapses, re-validating every guardrail and notifying either way', async () => {
      mockAutomationPolicy();
      const {
        openApplicationReview,
        evaluateAndScheduleAutomaticSubmission,
        fireDueAutomaticSubmissions,
      } = await importSession();
      const view = fakeView(SUBMIT_TREE);
      createApplicationView.mockImplementation(() => view);
      const opened = await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      const matchingHash = createHash('sha256')
        .update(opened.snapshot.fields.map((f) => `${f.label}|${f.controlType}|${f.required}`).sort().join('||'))
        .digest('hex');

      const attemptNow = withRealJdHash(fakeAttempt());
      workspaceMock.getApplicationAttempt.mockReturnValue(attemptNow);
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationArtifacts.mockReturnValue([{ kind: 'cv_pdf', storagePath: '/fake/resume.pdf' }]);
      extractPdfText.mockResolvedValue('Acme Corp Senior Engineer');
      workspaceMock.listApplicationAttempts.mockReturnValue([submittedAttempt({ formStructureHash: matchingHash })]);

      const scheduled = evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(scheduled.ok).toBe(true);

      // Reflect the schedule for the "what's due" query fireDueAutomaticSubmissions runs, plus the
      // employer's prior submission still needed for the re-validated eligibility check.
      workspaceMock.listApplicationAttempts.mockReturnValue([
        { ...attemptNow, scheduledAutomaticSubmitAt: scheduled.scheduledAutomaticSubmitAt },
        submittedAttempt({ formStructureHash: matchingHash }),
      ]);

      const afterWindow = new Date(Date.parse(NOW) + 4 * 60 * 1000).toISOString(); // past the 3-minute window
      const fired = await fireDueAutomaticSubmissions(FAKE_DB, afterWindow);

      expect(fired).toHaveLength(1);
      expect(fired[0]).toMatchObject({ attemptId: ATTEMPT_ID, company: 'Acme Corp', role: 'Senior Engineer', result: { ok: true } });
      expect(notifyAutomaticSubmission).toHaveBeenCalledWith({ company: 'Acme Corp', role: 'Senior Engineer', ok: true, detail: undefined });
      const calledMethods = view.transport.sendCommand.mock.calls.map(([method]) => method as string);
      expect(calledMethods).toContain('Input.dispatchMouseEvent'); // the real automatic submit click
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, { scheduledAutomaticSubmitAt: null });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(
        FAKE_DB,
        ATTEMPT_ID,
        expect.objectContaining({ checkpoint: 'submitted', submissionMode: 'automatic' }),
      );
    });

    it('a guardrail that newly fails between scheduling and firing (grant revoked in the meantime) refuses at fire time and notifies, rather than submitting on stale authorization', async () => {
      mockAutomationPolicy();
      const { openApplicationReview, fireDueAutomaticSubmissions } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });

      const scheduledAt = '2026-02-01T12:03:00.000Z';
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.listApplicationAttempts.mockReturnValue([withRealJdHash(fakeAttempt({ scheduledAutomaticSubmitAt: scheduledAt }))]);
      // The grant was revoked sometime during the cancel window -- re-validation at fire time must
      // catch this even though it was presumably active when this attempt was first scheduled.
      workspaceMock.findActiveAutomationGrant.mockReturnValue(undefined);

      const fired = await fireDueAutomaticSubmissions(FAKE_DB, '2026-02-01T12:05:00.000Z');

      expect(fired).toEqual([{ attemptId: ATTEMPT_ID, company: 'Acme Corp', role: 'Senior Engineer', result: { ok: false, reason: 'no_active_grant', detail: undefined } }]);
      expect(notifyAutomaticSubmission).toHaveBeenCalledWith({ company: 'Acme Corp', role: 'Senior Engineer', ok: false, detail: 'no_active_grant' });
      expect(workspaceMock.updateApplicationAttempt).toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, { scheduledAutomaticSubmitAt: null });
      // Never actually clicked anything -- the guardrail refused before any submit was attempted.
      expect(workspaceMock.updateApplicationAttempt).not.toHaveBeenCalledWith(FAKE_DB, ATTEMPT_ID, expect.objectContaining({ checkpoint: 'submitting' }));
    });

    it('a target the terms register has not cleared for automation can never run under automatic mode, even if every other guardrail would pass', async () => {
      mockAutomationPolicy({ termsEligibleForAutomation: false });
      const { openApplicationReview, evaluateAndScheduleAutomaticSubmission } = await importSession();
      createApplicationView.mockImplementation(() => fakeView(SUBMIT_TREE));
      await openApplicationReview({ attemptId: ATTEMPT_ID, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
      workspaceMock.getApplicationAttempt.mockReturnValue(withRealJdHash(fakeAttempt()));
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: NOW, expiresAt: '2026-03-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationAttempts.mockReturnValue([submittedAttempt()]);

      const result = evaluateAndScheduleAutomaticSubmission(FAKE_DB, ATTEMPT_ID, NOW);
      expect(result).toEqual({ ok: false, reason: 'not_eligible_for_automation' });
    });

    it('a real, small queue run unattended: every guardrail exercised together, not just individually', async () => {
      // Three attempts, one fireDueAutomaticSubmissions call, a stateful mock so a fire earlier in
      // the same batch is actually visible to a later one's own guardrail checks -- the same way a
      // real database would behave, and the only way "per-employer cap" can mean anything within
      // one unattended run rather than only across separate ones.
      mockAutomationPolicy({ rateLimits: { perDay: 10, perEmployerPerDay: 1, minIntervalMs: 0 } });
      const { openApplicationReview, fireDueAutomaticSubmissions } = await importSession();

      // submitApplicationReview stamps submittedAt from the real wall clock (correct: a manual
      // submit has no injected "now" to use), so this batch's own injected times must be anchored
      // to the real clock too -- a fixed historical date would make A's real-time submission look
      // like it happened in the future relative to B/C's checks, tripping minIntervalMs for the
      // wrong reason.
      const REAL_NOW = Date.now();
      const QUEUE_NOW = new Date(REAL_NOW - 3 * 60 * 1000).toISOString(); // scheduled 3 minutes ago
      const FIRE_AT = new Date(REAL_NOW).toISOString();

      const ATTEMPT_A = ATTEMPT_ID; // Acme Corp -- eligible, should fire
      const ATTEMPT_B = '22222222-2222-4222-8222-222222222222'; // Beta Inc -- no prior submission at all
      const ATTEMPT_C = '33333333-3333-4333-8333-333333333333'; // Acme Corp again -- blocked by A's own fire in this batch

      const views = new Map([
        [ATTEMPT_A, fakeView(SUBMIT_TREE)],
        [ATTEMPT_B, fakeView(SUBMIT_TREE)],
        [ATTEMPT_C, fakeView(SUBMIT_TREE)],
      ]);
      createApplicationView.mockImplementation((attemptId: string) => views.get(attemptId)!);
      let matchingHash = '';
      for (const attemptId of views.keys()) {
        const opened = await openApplicationReview({ attemptId, policyId: AUTOMATION_POLICY_ID, targetUrl: FIXTURE_URL });
        matchingHash = createHash('sha256')
          .update(opened.snapshot.fields.map((f) => `${f.label}|${f.controlType}|${f.required}`).sort().join('||'))
          .digest('hex'); // identical for every attempt here -- they all open the same SUBMIT_TREE
      }

      const attemptRecords = new Map<string, ReturnType<typeof fakeAttempt>>([
        [ATTEMPT_A, withRealJdHash(fakeAttempt({ id: ATTEMPT_A, company: 'Acme Corp', scheduledAutomaticSubmitAt: QUEUE_NOW }))],
        [ATTEMPT_B, withRealJdHash(fakeAttempt({ id: ATTEMPT_B, company: 'Beta Inc', scheduledAutomaticSubmitAt: QUEUE_NOW }))],
        [ATTEMPT_C, withRealJdHash(fakeAttempt({ id: ATTEMPT_C, company: 'Acme Corp', scheduledAutomaticSubmitAt: QUEUE_NOW }))],
      ]);
      const priorSubmissions = [submittedAttempt({ id: 'prior-acme', company: 'Acme Corp', formStructureHash: matchingHash, submittedAt: QUEUE_NOW })]; // establishes Acme's template; Beta has none

      workspaceMock.getApplicationAttempt.mockImplementation((_db: unknown, id: string) => attemptRecords.get(id));
      workspaceMock.listApplicationAttempts.mockImplementation(() => [...attemptRecords.values(), ...priorSubmissions]);
      workspaceMock.updateApplicationAttempt.mockImplementation((_db: unknown, id: string, patch: Record<string, unknown>) => {
        const current = attemptRecords.get(id)!;
        const updated = { ...current, ...patch };
        attemptRecords.set(id, updated);
        return updated;
      });
      workspaceMock.findActiveAutomationGrant.mockReturnValue({ id: 'grant-1', policyId: AUTOMATION_POLICY_ID, createdAt: QUEUE_NOW, expiresAt: '2027-01-01T00:00:00.000Z', revokedAt: null });
      workspaceMock.listApplicationArtifacts.mockReturnValue([{ kind: 'cv_pdf', storagePath: '/fake/resume.pdf' }]);
      extractPdfText.mockImplementation(async () => 'placeholder');

      // extractPdfText must name the right company/role per attempt for the gate to pass -- easier
      // to just return a superset string covering both employers' names/roles used above.
      extractPdfText.mockResolvedValue('Acme Corp Beta Inc Senior Engineer');

      const fired = await fireDueAutomaticSubmissions(FAKE_DB, FIRE_AT);

      const byAttempt = new Map(fired.map((f) => [f.attemptId, f]));
      expect(byAttempt.get(ATTEMPT_A)?.result.ok).toBe(true); // eligible, fires for real
      expect(byAttempt.get(ATTEMPT_B)?.result).toMatchObject({ ok: false, reason: 'no_prior_manual_submission_for_employer' });
      expect(byAttempt.get(ATTEMPT_C)?.result).toMatchObject({ ok: false, reason: 'per_employer_daily_cap_reached' });

      // Every one of the three was actually exercised (not silently skipped), and every one had
      // its schedule cleared regardless of outcome -- none is left dangling as "still scheduled".
      expect(fired).toHaveLength(3);
      for (const id of [ATTEMPT_A, ATTEMPT_B, ATTEMPT_C]) {
        expect(attemptRecords.get(id)!.scheduledAutomaticSubmitAt).toBeNull();
      }
      expect(notifyAutomaticSubmission).toHaveBeenCalledTimes(3);
    });
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
