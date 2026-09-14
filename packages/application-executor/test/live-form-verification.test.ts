import { describe, expect, it } from 'vitest';
import { ApplicationExecutor, ExecutorPolicyError } from '../src/executor.js';
import { validateFieldMap } from '../src/validate.js';
import type { ApplicationTargetPolicy } from '../src/target-policy.js';
import type { CdpDomNode } from '../src/dom-extract.js';
import { fakeBrowser } from './fake-browser.js';

/**
 * Issue #277's acceptance checks, against a fake that behaves like a browser rather than a call
 * recorder (see `fake-browser.ts` for why that distinction is the whole point).
 *
 * Every test here asserts on *committed state* -- what the control holds afterwards -- rather than
 * on which CDP methods were issued. A test that only checks the call sequence passes for an
 * executor that sends exactly the right commands in an order that produces the wrong value, which
 * is the shape of three of the four defects this ticket exists to fix.
 */

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

function text(backendNodeId: number, value: string): CdpDomNode {
  return { nodeName: '#text', nodeType: 3, backendNodeId, nodeValue: value };
}

// ---------------------------------------------------------------------------------------------
// Acceptance check 1: a page carrying a hidden duplicate of its own form.
// ---------------------------------------------------------------------------------------------

/**
 * Two iframes, each holding a byte-identical copy of the same application form: the same labels,
 * the same types, the same required-ness. Nothing in the markup distinguishes them -- the decoy is
 * hidden by a stylesheet, which `dom-extract.ts` documents it has no way to see. The only thing
 * that separates them is which one the browser actually laid out.
 *
 * The decoy is listed first and has MORE fields than the real form, so a resolution that picked by
 * field count (which is what `dom-extract.ts` does on its own) or by document order would pick the
 * wrong one. Only the rendering probe gets this right.
 */
const DECOY_IFRAME_NODE = 10;
const LIVE_IFRAME_NODE = 20;

const DUPLICATE_IFRAME_TREE: CdpDomNode = {
  nodeName: 'BODY',
  nodeType: 1,
  backendNodeId: 1,
  children: [
    {
      nodeName: 'IFRAME',
      nodeType: 1,
      backendNodeId: DECOY_IFRAME_NODE,
      attributes: ['src', 'https://fixture.example.invalid/form'],
      contentDocument: {
        nodeName: '#document',
        nodeType: 9,
        backendNodeId: 11,
        children: [
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: 12, attributes: ['type', 'email', 'name', 'email', 'required', ''] },
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: 13, attributes: ['type', 'text', 'name', 'fullName', 'required', ''] },
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: 14, attributes: ['type', 'text', 'name', 'referral'] },
        ],
      },
    },
    {
      nodeName: 'IFRAME',
      nodeType: 1,
      backendNodeId: LIVE_IFRAME_NODE,
      attributes: ['src', 'https://fixture.example.invalid/form'],
      contentDocument: {
        nodeName: '#document',
        nodeType: 9,
        backendNodeId: 21,
        children: [
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: 22, attributes: ['type', 'email', 'name', 'email', 'required', ''] },
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: 23, attributes: ['type', 'text', 'name', 'fullName', 'required', ''] },
        ],
      },
    },
  ],
};

describe('#277 acceptance 1: duplicate hidden/visible iframes', () => {
  it('resolves the visible frame as active, even though the hidden decoy has more fields and comes first', async () => {
    const browser = fakeBrowser(DUPLICATE_IFRAME_TREE, { notRendered: [DECOY_IFRAME_NODE] });
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();

    const active = snapshot.fields.filter((field) => field.active);
    const inactive = snapshot.fields.filter((field) => !field.active);
    expect(active).toHaveLength(2);
    expect(inactive).toHaveLength(3);
    // Both copies are still reported, so a person (or a later diagnosis) can see the page had two.
    // Only one of them is the one anything is allowed to write to.
    expect(snapshot.fields).toHaveLength(5);
    expect(snapshot.activeFrameId).toBe(2); // the second pierced frame, not the first
  });

  it('fills only the visible form, leaving the hidden duplicate untouched', async () => {
    const browser = fakeBrowser(DUPLICATE_IFRAME_TREE, { notRendered: [DECOY_IFRAME_NODE] });
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();

    const activeEmail = snapshot.fields.find((field) => field.active && field.label === 'email')!;
    await executor.fill(activeEmail.fieldRef, 'ada@example.invalid');

    expect(browser.controls.get(22)?.value).toBe('ada@example.invalid'); // the live form
    expect(browser.controls.get(12)?.value).toBe(''); // the hidden decoy, never touched
  });

  it('refuses a fill targeting the hidden duplicate, even though its ref is a perfectly real ref', async () => {
    const browser = fakeBrowser(DUPLICATE_IFRAME_TREE, { notRendered: [DECOY_IFRAME_NODE] });
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();

    const decoyEmail = snapshot.fields.find((field) => !field.active && field.label === 'email')!;
    await expect(executor.fill(decoyEmail.fieldRef, 'ada@example.invalid')).rejects.toThrow(/not part of the active form/);
    expect(browser.controls.get(12)?.value).toBe('');
  });

  it('refuses a field map that targets the hidden duplicate, before any CDP call is made', async () => {
    const browser = fakeBrowser(DUPLICATE_IFRAME_TREE, { notRendered: [DECOY_IFRAME_NODE] });
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const decoyEmail = snapshot.fields.find((field) => !field.active && field.label === 'email')!;
    const activeFields = snapshot.fields.filter((field) => field.active);

    const result = validateFieldMap({
      raw: {
        attemptId: '11111111-1111-4111-8111-111111111111',
        snapshotGeneration: snapshot.generation,
        assignments: [{ fieldRef: decoyEmail.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000001' } }],
        // Rule 9 only covers the active form's required fields now, so the decoy's own required
        // fields need no coverage -- that is the other half of the same change.
        unmapped: activeFields.map((field) => ({ fieldRef: field.fieldRef, reason: 'needs_user' })),
      },
      attemptId: '11111111-1111-4111-8111-111111111111',
      snapshot,
      valueTable: [{ valueRef: 'v0000000000000001', value: 'ada@example.invalid', provenance: 'profile' }],
      ownedArtifactIds: [],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('inactive_form_field');
  });

  it('keeps the count-based resolution when the probe cannot answer for any group at all', async () => {
    // Fail-open, deliberately: a transport that does not implement the geometry read must not make
    // every field on a two-form page permanently unfillable. The behaviour then is exactly what it
    // was before #277 (most fields wins), which is the honest fallback.
    const browser = fakeBrowser(DUPLICATE_IFRAME_TREE);
    // Answer the geometry read with a shape carrying no `quads` at all: "the browser did not say".
    const original = browser.transport.sendCommand.bind(browser.transport);
    const executor = new ApplicationExecutor(
      {
        async sendCommand(method, params) {
          if (method === 'DOM.getContentQuads') return {};
          return original(method, params);
        },
      },
      fullPolicy(),
    );
    const snapshot = await executor.snapshot();
    expect(snapshot.activeFrameId).toBe(1); // the decoy: three fields beats two, by count alone
    expect(snapshot.fields.filter((field) => field.active)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Acceptance check 2: repeated fills replace, and committed state survives blur and re-read.
// ---------------------------------------------------------------------------------------------

const CONTACT_FORM_TREE: CdpDomNode = {
  nodeName: 'BODY',
  nodeType: 1,
  backendNodeId: 1,
  children: [
    { nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'email', 'name', 'email', 'required', ''] },
    { nodeName: 'INPUT', nodeType: 1, backendNodeId: 3, attributes: ['type', 'radio', 'name', 'remote'] },
    {
      nodeName: 'SELECT',
      nodeType: 1,
      backendNodeId: 4,
      attributes: ['name', 'noticePeriod'],
      children: [
        { nodeName: 'OPTION', nodeType: 1, backendNodeId: 5, attributes: ['value', '1m'], children: [text(6, 'One month')] },
        { nodeName: 'OPTION', nodeType: 1, backendNodeId: 7, attributes: ['value', '2m'], children: [text(8, 'Two months')] },
        { nodeName: 'OPTION', nodeType: 1, backendNodeId: 9, attributes: ['value', '3m'], children: [text(10, 'Three months')] },
      ],
    },
  ],
};

describe('#277 acceptance 2: replace, not append, and committed state survives blur and re-read', () => {
  it('filling the same email field three times leaves exactly the last value, never a concatenation', async () => {
    const browser = fakeBrowser(CONTACT_FORM_TREE);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const email = snapshot.fields.find((field) => field.label === 'email')!;

    await executor.fill(email.fieldRef, 'first@example.invalid');
    await executor.fill(email.fieldRef, 'second@example.invalid');
    const third = await executor.fill(email.fieldRef, 'third@example.invalid');

    expect(browser.controls.get(2)?.value).toBe('third@example.invalid');
    expect(third.committedValue).toBe('third@example.invalid');
    expect(third.status).toBe('verified');
  });

  it('filling a field with an empty value really clears it, rather than leaving the old value in place', async () => {
    const browser = fakeBrowser(CONTACT_FORM_TREE);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const email = snapshot.fields.find((field) => field.label === 'email')!;

    await executor.fill(email.fieldRef, 'typo@example.invalid');
    const cleared = await executor.fill(email.fieldRef, '');

    expect(browser.controls.get(2)?.value).toBe('');
    expect(cleared.status).toBe('verified');
  });

  it('text, radio and select state all survive the blur and a full re-read of the page', async () => {
    const browser = fakeBrowser(CONTACT_FORM_TREE);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const first = await executor.snapshot();

    const email = first.fields.find((field) => field.label === 'email')!;
    const remote = first.fields.find((field) => field.controlType === 'radio')!;
    const notice = first.fields.find((field) => field.controlType === 'select')!;
    const threeMonths = notice.options!.find((option) => option.label === 'Three months')!;

    expect((await executor.fill(email.fieldRef, 'ada@example.invalid')).status).toBe('verified');
    expect((await executor.fill(remote.fieldRef, 'true')).status).toBe('verified');
    expect((await executor.select(notice.fieldRef, threeMonths.optionRef)).status).toBe('verified');

    // A full re-read: a new generation, new refs, and a fresh look at the live page. The values
    // must still be there, because they were committed rather than merely typed.
    const second = await executor.snapshot();
    expect(second.generation).toBe(first.generation + 1);
    const readiness = await executor.evaluateReadiness();

    expect(browser.controls.get(2)?.value).toBe('ada@example.invalid');
    expect(browser.controls.get(3)?.checked).toBe(true);
    expect(browser.controls.get(4)?.value).toBe('Three months');
    // The email field is the only required one, and it is answered, so nothing blocks.
    expect(readiness.blockers).toEqual([]);
    // Verifications do NOT survive a re-read: the refs they name no longer exist. The values did;
    // the claims about them did not, and that distinction is deliberate.
    expect(readiness.verifiedFilledCount).toBe(0);
  });

  it('reports a mismatch, rather than success, when the control does not keep what was written', async () => {
    const browser = fakeBrowser(CONTACT_FORM_TREE);
    // A controlled input that rewrites whatever is typed into it, as a React-controlled field with
    // a formatter does. Nothing about the commands issued changes; only the outcome does.
    const original = browser.transport.sendCommand.bind(browser.transport);
    const executor = new ApplicationExecutor(
      {
        async sendCommand(method, params) {
          const result = await original(method, params);
          if (method === 'Input.insertText') browser.controls.get(2)!.value = 'REWRITTEN BY THE PAGE';
          return result;
        },
      },
      fullPolicy(),
    );
    const snapshot = await executor.snapshot();
    const email = snapshot.fields.find((field) => field.label === 'email')!;

    const verification = await executor.fill(email.fieldRef, 'ada@example.invalid');

    expect(verification.status).toBe('mismatch');
    expect(verification.committedValue).toBe('REWRITTEN BY THE PAGE');
    const readiness = await executor.evaluateReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.verifiedFilledCount).toBe(0);
    expect(readiness.blockers.map((blocker) => blocker.kind)).toContain('value_mismatch');
  });

  it('reports unreadable, never verified, when the browser publishes nothing for the control', async () => {
    const browser = fakeBrowser(CONTACT_FORM_TREE);
    const original = browser.transport.sendCommand.bind(browser.transport);
    const executor = new ApplicationExecutor(
      {
        async sendCommand(method, params) {
          if (method === 'Accessibility.getPartialAXTree') throw new Error('node gone');
          return original(method, params);
        },
      },
      fullPolicy(),
    );
    const snapshot = await executor.snapshot();
    const email = snapshot.fields.find((field) => field.label === 'email')!;

    const verification = await executor.fill(email.fieldRef, 'ada@example.invalid');
    expect(verification.status).toBe('unreadable');
  });
});

// ---------------------------------------------------------------------------------------------
// Acceptance check 3: unresolved required-field/upload errors block ready; freshness is checked.
// ---------------------------------------------------------------------------------------------

const APPLICATION_TREE: CdpDomNode = {
  nodeName: 'BODY',
  nodeType: 1,
  backendNodeId: 1,
  children: [
    {
      nodeName: 'FORM',
      nodeType: 1,
      backendNodeId: 2,
      children: [
        { nodeName: 'INPUT', nodeType: 1, backendNodeId: 3, attributes: ['type', 'text', 'name', 'fullName', 'required', ''] },
        { nodeName: 'INPUT', nodeType: 1, backendNodeId: 4, attributes: ['type', 'file', 'name', 'resume', 'required', ''] },
        { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 5, children: [text(6, 'Submit Application')] },
      ],
    },
  ],
};

const A_VALID_PDF = { localFilePath: '/staged/resume.pdf', mimeType: 'application/pdf', byteSize: 1000 };

describe('#277 acceptance 3: unresolved errors prevent ready, and freshness gates submission', () => {
  it('an empty required field prevents ready', async () => {
    const browser = fakeBrowser(APPLICATION_TREE);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    await executor.snapshot();

    const readiness = await executor.evaluateReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.kind)).toContain('required_field_empty');
    expect(readiness.requiredFieldCount).toBe(2);
    expect(readiness.requiredFieldsSatisfied).toBe(0);
  });

  it('a required upload with nothing attached prevents ready, and attaching for real clears it', async () => {
    const browser = fakeBrowser(APPLICATION_TREE);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const name = snapshot.fields.find((field) => field.controlType === 'text')!;
    const resume = snapshot.fields.find((field) => field.controlType === 'file')!;

    await executor.fill(name.fieldRef, 'Ada Lovelace');
    const beforeAttach = await executor.evaluateReadiness();
    expect(beforeAttach.ready).toBe(false);
    expect(beforeAttach.blockers.map((blocker) => blocker.kind)).toEqual(['attachment_missing']);

    const attached = await executor.attach(resume.fieldRef, A_VALID_PDF);
    expect(attached.status).toBe('verified');
    expect(attached.attachmentNames).toEqual(['resume.pdf']);

    const afterAttach = await executor.evaluateReadiness();
    expect(afterAttach.ready).toBe(true);
    expect(afterAttach.verifiedFilledCount).toBe(2);
  });

  it('an upload the control never actually took is a mismatch, not a success, and still prevents ready', async () => {
    const browser = fakeBrowser(APPLICATION_TREE);
    // `DOM.setFileInputFiles` resolves, but the control ends up holding nothing -- the page swapped
    // the input out, or its `accept` filter rejected the file.
    const original = browser.transport.sendCommand.bind(browser.transport);
    const executor = new ApplicationExecutor(
      {
        async sendCommand(method, params) {
          const result = await original(method, params);
          if (method === 'DOM.setFileInputFiles') browser.controls.get(4)!.value = '';
          return result;
        },
      },
      fullPolicy(),
    );
    const snapshot = await executor.snapshot();
    const name = snapshot.fields.find((field) => field.controlType === 'text')!;
    const resume = snapshot.fields.find((field) => field.controlType === 'file')!;

    await executor.fill(name.fieldRef, 'Ada Lovelace');
    const attached = await executor.attach(resume.fieldRef, A_VALID_PDF);

    expect(attached.status).toBe('mismatch');
    expect(attached.attachmentNames).toEqual([]);
    const readiness = await executor.evaluateReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.kind).sort()).toEqual(['attachment_missing', 'value_mismatch']);
  });

  it('a validation error the page is showing prevents ready, even on a field that holds a value', async () => {
    const browser = fakeBrowser(APPLICATION_TREE, {
      overrides: { 3: { invalid: true, description: 'Enter your full legal name as it appears on your passport.' } },
    });
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const name = snapshot.fields.find((field) => field.controlType === 'text')!;
    const resume = snapshot.fields.find((field) => field.controlType === 'file')!;

    await executor.fill(name.fieldRef, 'Ada');
    await executor.attach(resume.fieldRef, A_VALID_PDF);

    const readiness = await executor.evaluateReadiness();
    expect(readiness.ready).toBe(false);
    const validation = readiness.blockers.find((blocker) => blocker.kind === 'validation_error');
    expect(validation).toBeDefined();
    expect(validation).toMatchObject({ message: 'Enter your full legal name as it appears on your passport.' });
  });

  it('a page that changed since the snapshot was taken reports stale state and is not ready', async () => {
    const browser = fakeBrowser(APPLICATION_TREE);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const name = snapshot.fields.find((field) => field.controlType === 'text')!;
    const resume = snapshot.fields.find((field) => field.controlType === 'file')!;
    await executor.fill(name.fieldRef, 'Ada Lovelace');
    await executor.attach(resume.fieldRef, A_VALID_PDF);
    expect((await executor.evaluateReadiness()).ready).toBe(true);

    // The employer's form grows a new required question under the person reviewing it.
    browser.setTree({
      ...APPLICATION_TREE,
      children: [
        {
          ...(APPLICATION_TREE.children![0] as CdpDomNode),
          children: [
            ...(APPLICATION_TREE.children![0] as CdpDomNode).children!,
            { nodeName: 'INPUT', nodeType: 1, backendNodeId: 7, attributes: ['type', 'text', 'name', 'salaryExpectation', 'required', ''] },
          ],
        },
      ],
    });

    const readiness = await executor.evaluateReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.kind)).toContain('stale_page_state');
  });

  it('submit itself refuses against a changed page, independently of the caller checking readiness', async () => {
    const browser = fakeBrowser(APPLICATION_TREE);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const controlRef = snapshot.submitControls[0]!.controlRef;

    browser.setTree({
      ...APPLICATION_TREE,
      children: [
        {
          ...(APPLICATION_TREE.children![0] as CdpDomNode),
          children: [
            ...(APPLICATION_TREE.children![0] as CdpDomNode).children!,
            { nodeName: 'INPUT', nodeType: 1, backendNodeId: 7, attributes: ['type', 'text', 'name', 'salaryExpectation', 'required', ''] },
          ],
        },
      ],
    });

    await expect(executor.submit(controlRef)).rejects.toThrow(/the page changed since the snapshot under review was taken/);
    // Nothing was clicked: no mouse event ever reached the page.
    expect(browser.calls.filter((call) => call.method === 'Input.dispatchMouseEvent')).toHaveLength(0);
  });

  it('submit proceeds when the page is unchanged, so the freshness gate is not simply always-refusing', async () => {
    const browser = fakeBrowser(APPLICATION_TREE);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();

    await executor.submit(snapshot.submitControls[0]!.controlRef);
    expect(browser.calls.filter((call) => call.method === 'Input.dispatchMouseEvent')).toHaveLength(2);
  });

  it('evaluateReadiness refuses outright when there is no snapshot to evaluate against', async () => {
    const browser = fakeBrowser(APPLICATION_TREE);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    await expect(executor.evaluateReadiness()).rejects.toThrow(ExecutorPolicyError);
  });

  it('an upload the page only claims in its own aria-label is never confirmed', async () => {
    // The one failure mode worse than an unconfirmed attachment: a page that reads
    // `input.files[0].name`, echoes it into an author-supplied accessible name, and discards the
    // file would otherwise get an applicant told their CV landed on a form that threw it away.
    const browser = fakeBrowser(APPLICATION_TREE);
    const original = browser.transport.sendCommand.bind(browser.transport);
    const executor = new ApplicationExecutor(
      {
        async sendCommand(method, params) {
          const result = await original(method, params);
          if (method === 'DOM.setFileInputFiles') {
            const control = browser.controls.get(4)!;
            control.value = ''; // the control took nothing
            control.description = 'resume.pdf'; // but the page says otherwise, in text it authored
          }
          return result;
        },
      },
      fullPolicy(),
    );
    const snapshot = await executor.snapshot();
    const resume = snapshot.fields.find((field) => field.controlType === 'file')!;

    const attached = await executor.attach(resume.fieldRef, A_VALID_PDF);
    expect(attached.status).toBe('mismatch');
    expect(attached.attachmentNames).toEqual([]);
  });

  it('caps a page-authored validation message rather than carrying it at whatever length the page chose', async () => {
    // The message travels into a refusal detail and, on the unattended path, a desktop notification
    // body, so its length is bounded where it enters rather than at each place it is displayed.
    const shouty = 'X'.repeat(5000);
    const tree: CdpDomNode = {
      nodeName: 'BODY',
      nodeType: 1,
      backendNodeId: 1,
      children: [
        { nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'text', 'name', 'fullName', 'aria-errormessage', 'err'] },
        { nodeName: 'SPAN', nodeType: 1, backendNodeId: 3, attributes: ['id', 'err'], children: [text(4, shouty)] },
      ],
    };
    const browser = fakeBrowser(tree);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();

    expect(snapshot.fields[0]!.validationMessage!.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------------------------
// Acceptance check 5 (executor half): a field inventory is never a filled count.
// ---------------------------------------------------------------------------------------------

describe('#277 acceptance 5: discovering fields is not filling them', () => {
  it('a freshly snapshotted page reports every field discovered and zero verified filled', async () => {
    const browser = fakeBrowser(APPLICATION_TREE);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();

    // The old reading: two fields were found, so "2 fields filled".
    expect(snapshot.fields).toHaveLength(2);

    const readiness = await executor.evaluateReadiness();
    expect(readiness.discoveredFieldCount).toBe(2);
    expect(readiness.verifiedFilledCount).toBe(0);
    expect(readiness.ready).toBe(false);
  });

  it('capturing a screenshot changes nothing about the verified-filled count', async () => {
    const browser = fakeBrowser(APPLICATION_TREE);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    await executor.snapshot();

    await executor.capture();
    await executor.capture();

    const readiness = await executor.evaluateReadiness();
    expect(readiness.verifiedFilledCount).toBe(0);
  });

  it('a value present on the page that this executor did not write is answered, but never verified-filled', async () => {
    // The honest middle case: the required field holds something (so it does not block), but this
    // app never wrote it and has no verification of its own to point at.
    const prefilled: CdpDomNode = {
      ...APPLICATION_TREE,
      children: [
        {
          ...(APPLICATION_TREE.children![0] as CdpDomNode),
          children: [
            { nodeName: 'INPUT', nodeType: 1, backendNodeId: 3, attributes: ['type', 'text', 'name', 'fullName', 'required', '', 'value', 'Ada Lovelace'] },
            { nodeName: 'BUTTON', nodeType: 1, backendNodeId: 5, children: [text(6, 'Submit Application')] },
          ],
        },
      ],
    };
    const browser = fakeBrowser(prefilled);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    await executor.snapshot();

    const readiness = await executor.evaluateReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.requiredFieldsSatisfied).toBe(1);
    expect(readiness.verifiedFilledCount).toBe(0);
  });
});
