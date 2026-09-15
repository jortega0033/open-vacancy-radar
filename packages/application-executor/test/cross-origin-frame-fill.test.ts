import { describe, expect, it } from 'vitest';
import { ApplicationExecutor } from '../src/executor.js';
import { validateFieldMap } from '../src/validate.js';
import type { ApplicationTargetPolicy } from '../src/target-policy.js';
import type { CdpDomNode } from '../src/dom-extract.js';
import { fakeBrowser } from './fake-browser.js';

/**
 * The cross-origin half of the active-frame resolution, against the same behaving fake browser the
 * rest of this suite uses (`fake-browser.ts`).
 *
 * What these tests are about: #277 taught the executor to pick the frame a person is actually
 * looking at, by field count and real layout geometry. That reasoning holds for a page choosing
 * among its own forms and collapses for a third party's embedded document -- a chat widget, a
 * cookie-consent banner, a job-alert signup are not "the page's own controls", and the fill path
 * dispatches real `Input.insertText`/mouse events that such a widget's own script reads live. So a
 * widget with more inputs than the real application form used to win the contest outright and
 * receive an applicant's answers, with no origin ever entering the decision.
 *
 * Each fixture below is therefore built so that the *old* heuristic would pick the wrong frame: the
 * cross-origin frame always has more fields than the real form, and is always laid out.
 */

function fullPolicy(overrides: Partial<ApplicationTargetPolicy> = {}): ApplicationTargetPolicy {
  return {
    id: 'employer-careers',
    displayName: 'Employer Careers',
    origins: ['https://careers.employer.invalid'],
    adapter: 'fixture',
    termsRegisterEntry: 'employer-careers',
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

// ---------------------------------------------------------------------------------------------
// A real application form, plus a third party's chat widget carrying more inputs than it.
// ---------------------------------------------------------------------------------------------

const FORM_EMAIL_NODE = 3;
const WIDGET_EMAIL_NODE = 13;

const EMPLOYER_FORM_WITH_CHAT_WIDGET: CdpDomNode = {
  nodeName: '#document',
  nodeType: 9,
  backendNodeId: 1,
  documentURL: 'https://careers.employer.invalid/jobs/7',
  children: [
    {
      nodeName: 'FORM',
      nodeType: 1,
      backendNodeId: 2,
      children: [
        { nodeName: 'INPUT', nodeType: 1, backendNodeId: FORM_EMAIL_NODE, attributes: ['type', 'email', 'name', 'email', 'required', ''] },
        { nodeName: 'INPUT', nodeType: 1, backendNodeId: 4, attributes: ['type', 'text', 'name', 'fullName', 'required', ''] },
      ],
    },
    {
      // A support-chat widget: three inputs, laid out, and served by somebody else entirely.
      nodeName: 'IFRAME',
      nodeType: 1,
      backendNodeId: 10,
      attributes: ['src', 'https://chat.vendor.invalid/widget'],
      contentDocument: {
        nodeName: '#document',
        nodeType: 9,
        backendNodeId: 11,
        documentURL: 'https://chat.vendor.invalid/widget',
        children: [
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: 12, attributes: ['type', 'text', 'name', 'visitorName'] },
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: WIDGET_EMAIL_NODE, attributes: ['type', 'email', 'name', 'email'] },
          { nodeName: 'TEXTAREA', nodeType: 1, backendNodeId: 14, attributes: ['name', 'message'] },
        ],
      },
    },
  ],
};

describe('a cross-origin widget never becomes the active form', () => {
  it('resolves the employer form as active even though the widget frame has more fields', async () => {
    const browser = fakeBrowser(EMPLOYER_FORM_WITH_CHAT_WIDGET);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();

    expect(snapshot.activeFrameId).toBe(0);
    expect(snapshot.topFrameOrigin).toBe('https://careers.employer.invalid');
    expect(snapshot.fields.filter((field) => field.active).map((field) => field.label)).toEqual(['email', 'fullName']);
    // The widget's inputs are still reported -- a person, or a later diagnosis, can see the page had
    // them. They are simply not the form anything is allowed to write to.
    expect(snapshot.fields.filter((field) => !field.active)).toHaveLength(3);
    expect(snapshot.fields.filter((field) => field.frameOrigin === 'https://chat.vendor.invalid')).toHaveLength(3);
  });

  it('costs no geometry probe at all: one eligible group settles it', async () => {
    const browser = fakeBrowser(EMPLOYER_FORM_WITH_CHAT_WIDGET);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    await executor.snapshot();

    expect(browser.calls.filter((call) => call.method === 'DOM.getContentQuads')).toHaveLength(0);
  });

  it('refuses a fill into the widget frame, naming the origin rather than silently skipping it', async () => {
    const browser = fakeBrowser(EMPLOYER_FORM_WITH_CHAT_WIDGET);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();

    const widgetEmail = snapshot.fields.find((field) => field.frameOrigin === 'https://chat.vendor.invalid' && field.label === 'email')!;
    await expect(executor.fill(widgetEmail.fieldRef, 'ada@example.invalid')).rejects.toThrow(/cross-origin frame/);
    expect(browser.controls.get(WIDGET_EMAIL_NODE)?.value).toBe('');
  });

  it('still fills the employer form itself', async () => {
    const browser = fakeBrowser(EMPLOYER_FORM_WITH_CHAT_WIDGET);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();

    const formEmail = snapshot.fields.find((field) => field.active && field.label === 'email')!;
    const verification = await executor.fill(formEmail.fieldRef, 'ada@example.invalid');

    expect(verification.status).toBe('verified');
    expect(browser.controls.get(FORM_EMAIL_NODE)?.value).toBe('ada@example.invalid');
    expect(browser.controls.get(WIDGET_EMAIL_NODE)?.value).toBe('');
  });

  it('refuses a field map that targets the widget, before any CDP call is made', async () => {
    // The two halves of the same rule: the executor refuses the write, and Domain B refuses the
    // field map that proposed it -- the widget's fields are not part of the active form, so the
    // existing `inactive_form_field` veto covers them once resolution stops choosing that frame.
    const browser = fakeBrowser(EMPLOYER_FORM_WITH_CHAT_WIDGET);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();
    const widgetEmail = snapshot.fields.find((field) => field.frameOrigin === 'https://chat.vendor.invalid' && field.label === 'email')!;
    const activeFields = snapshot.fields.filter((field) => field.active);

    const result = validateFieldMap({
      raw: {
        attemptId: '11111111-1111-4111-8111-111111111111',
        snapshotGeneration: snapshot.generation,
        assignments: [{ fieldRef: widgetEmail.fieldRef, source: { kind: 'value', valueRef: 'v0000000000000001' } }],
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
});

// ---------------------------------------------------------------------------------------------
// The legitimate case: the real application form IS the cross-origin frame (an ATS vendor's embed),
// alongside an ad frame that is not.
// ---------------------------------------------------------------------------------------------

const ATS_EMAIL_NODE = 22;
const AD_EMAIL_NODE = 32;

const EMBEDDED_ATS_TREE: CdpDomNode = {
  nodeName: '#document',
  nodeType: 9,
  backendNodeId: 1,
  documentURL: 'https://careers.employer.invalid/jobs/7',
  children: [
    // The employer page's own content is a newsletter box and nothing else -- the application form
    // proper lives in the vendor's iframe below.
    { nodeName: 'INPUT', nodeType: 1, backendNodeId: 2, attributes: ['type', 'email', 'name', 'newsletterEmail'] },
    {
      nodeName: 'IFRAME',
      nodeType: 1,
      backendNodeId: 20,
      attributes: ['src', 'https://boards.ats-vendor.invalid/embed/7'],
      contentDocument: {
        nodeName: '#document',
        nodeType: 9,
        backendNodeId: 21,
        documentURL: 'https://boards.ats-vendor.invalid/embed/7',
        children: [
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: ATS_EMAIL_NODE, attributes: ['type', 'email', 'name', 'email', 'required', ''] },
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: 23, attributes: ['type', 'text', 'name', 'fullName', 'required', ''] },
          { nodeName: 'TEXTAREA', nodeType: 1, backendNodeId: 24, attributes: ['name', 'coverLetter'] },
        ],
      },
    },
    {
      // A fourth-party ad slot with more fields than either -- the frame the count heuristic alone
      // would hand everything to.
      nodeName: 'IFRAME',
      nodeType: 1,
      backendNodeId: 30,
      attributes: ['src', 'https://ads.other.invalid/slot'],
      contentDocument: {
        nodeName: '#document',
        nodeType: 9,
        backendNodeId: 31,
        documentURL: 'https://ads.other.invalid/slot',
        children: [
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: AD_EMAIL_NODE, attributes: ['type', 'email', 'name', 'email'] },
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: 33, attributes: ['type', 'text', 'name', 'fullName'] },
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: 34, attributes: ['type', 'text', 'name', 'phone'] },
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: 35, attributes: ['type', 'text', 'name', 'postcode'] },
        ],
      },
    },
  ],
};

describe('an explicitly allowlisted sub-origin, and only that one', () => {
  it('refuses the vendor embed by default, leaving the employer page as the active form', async () => {
    const browser = fakeBrowser(EMBEDDED_ATS_TREE);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();

    expect(snapshot.activeFrameId).toBe(0);
    const atsEmail = snapshot.fields.find((field) => field.frameOrigin === 'https://boards.ats-vendor.invalid' && field.label === 'email')!;
    await expect(executor.fill(atsEmail.fieldRef, 'ada@example.invalid')).rejects.toThrow(/cross-origin frame/);
    expect(browser.controls.get(ATS_EMAIL_NODE)?.value).toBe('');
  });

  it('fills the vendor embed once the policy names that exact sub-origin', async () => {
    const browser = fakeBrowser(EMBEDDED_ATS_TREE);
    const executor = new ApplicationExecutor(
      browser.transport,
      fullPolicy({ allowedSubFrameOrigins: ['https://boards.ats-vendor.invalid'] }),
    );
    const snapshot = await executor.snapshot();

    // Two eligible groups now (the newsletter box and the embed), so the geometry probe runs and the
    // embed's three fields beat the single newsletter input -- the ad frame's four never enter it.
    expect(snapshot.activeFrameId).toBe(1);
    const atsEmail = snapshot.fields.find((field) => field.active && field.label === 'email')!;
    const verification = await executor.fill(atsEmail.fieldRef, 'ada@example.invalid');

    expect(verification.status).toBe('verified');
    expect(browser.controls.get(ATS_EMAIL_NODE)?.value).toBe('ada@example.invalid');
  });

  it('still refuses every other cross-origin frame while that one is allowlisted', async () => {
    const browser = fakeBrowser(EMBEDDED_ATS_TREE);
    const executor = new ApplicationExecutor(
      browser.transport,
      fullPolicy({ allowedSubFrameOrigins: ['https://boards.ats-vendor.invalid'] }),
    );
    const snapshot = await executor.snapshot();

    const adEmail = snapshot.fields.find((field) => field.frameOrigin === 'https://ads.other.invalid' && field.label === 'email')!;
    await expect(executor.fill(adEmail.fieldRef, 'ada@example.invalid')).rejects.toThrow(/cross-origin frame/);
    expect(browser.controls.get(AD_EMAIL_NODE)?.value).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// The shapes that must keep working exactly as they did.
// ---------------------------------------------------------------------------------------------

const SAME_ORIGIN_EMBED_TREE: CdpDomNode = {
  nodeName: '#document',
  nodeType: 9,
  backendNodeId: 1,
  documentURL: 'https://careers.employer.invalid/jobs/7',
  children: [
    {
      nodeName: 'IFRAME',
      nodeType: 1,
      backendNodeId: 40,
      // A relative src, the ordinary way a page embeds its own document.
      attributes: ['src', '/embed/apply/7'],
      contentDocument: {
        nodeName: '#document',
        nodeType: 9,
        backendNodeId: 41,
        children: [
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: 42, attributes: ['type', 'email', 'name', 'email', 'required', ''] },
          { nodeName: 'INPUT', nodeType: 1, backendNodeId: 43, attributes: ['type', 'text', 'name', 'fullName', 'required', ''] },
        ],
      },
    },
  ],
};

describe('same-origin pages are untouched by the origin check', () => {
  it('fills a form the page embedded in its own iframe', async () => {
    const browser = fakeBrowser(SAME_ORIGIN_EMBED_TREE);
    const executor = new ApplicationExecutor(browser.transport, fullPolicy());
    const snapshot = await executor.snapshot();

    expect(snapshot.activeFrameId).toBe(1);
    const email = snapshot.fields.find((field) => field.active && field.label === 'email')!;
    await executor.fill(email.fieldRef, 'ada@example.invalid');

    expect(browser.controls.get(42)?.value).toBe('ada@example.invalid');
  });

  it('accepts a frame served from another origin the policy already authorizes for this target', async () => {
    // A target that legitimately spans two of its own origins (the careers page and the apply
    // subdomain). Those are reviewed, compiled entries in the policy, not a third party -- so they
    // need no separate sub-frame allowlist entry.
    const tree: CdpDomNode = {
      ...SAME_ORIGIN_EMBED_TREE,
      children: [
        {
          ...(SAME_ORIGIN_EMBED_TREE.children![0] as CdpDomNode),
          attributes: ['src', 'https://apply.employer.invalid/7'],
          contentDocument: {
            ...(SAME_ORIGIN_EMBED_TREE.children![0]!.contentDocument as CdpDomNode),
            documentURL: 'https://apply.employer.invalid/7',
          },
        },
      ],
    };
    const browser = fakeBrowser(tree);
    const executor = new ApplicationExecutor(
      browser.transport,
      fullPolicy({ origins: ['https://careers.employer.invalid', 'https://apply.employer.invalid'] }),
    );
    const snapshot = await executor.snapshot();

    const email = snapshot.fields.find((field) => field.active && field.label === 'email')!;
    await executor.fill(email.fieldRef, 'ada@example.invalid');

    expect(browser.controls.get(42)?.value).toBe('ada@example.invalid');
  });
});
