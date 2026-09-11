import { describe, expect, it } from 'vitest';
import { extractSnapshotFields, extractSubmissionSignals, MAX_OBSERVED_PAGE_TEXT_LENGTH, type CdpDomNode } from '../src/dom-extract.js';

let nextBackendId = 1;
function node(partial: Partial<CdpDomNode> & { nodeName: string }): CdpDomNode {
  return {
    nodeType: 1,
    backendNodeId: nextBackendId++,
    attributes: [],
    children: [],
    ...partial,
  };
}

function attrsFrom(pairs: Record<string, string>): string[] {
  return Object.entries(pairs).flat();
}

describe('extractSnapshotFields', () => {
  it('extracts a plain text input with its label resolved from name', () => {
    const root = node({
      nodeName: 'DIV',
      children: [node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'fullName' }) })],
    });
    const { fields } = extractSnapshotFields(root);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ controlType: 'text', label: 'fullName', required: false });
  });

  it('prefers aria-label over placeholder over name over id', () => {
    const root = node({
      nodeName: 'INPUT',
      attributes: attrsFrom({ type: 'text', 'aria-label': 'Full name', placeholder: 'placeholder', name: 'name-attr', id: 'id-attr' }),
    });
    const { fields } = extractSnapshotFields(root);
    expect(fields[0]!.label).toBe('Full name');
  });

  it('marks a required field', () => {
    const root = node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'x', required: '' }) });
    expect(extractSnapshotFields(root).fields[0]!.required).toBe(true);
  });

  it('skips hidden and disabled inputs entirely', () => {
    const root = node({
      nodeName: 'DIV',
      children: [
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'hidden', name: 'csrf' }) }),
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'disabled-field', disabled: '' }) }),
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'real-field' }) }),
      ],
    });
    const { fields } = extractSnapshotFields(root);
    expect(fields).toHaveLength(1);
    expect(fields[0]!.label).toBe('real-field');
  });

  it('also skips a text-type input carrying the generic HTML `hidden` attribute, not just type="hidden"', () => {
    // Confirmed against a real Electron WebContentsView (e2e/application-executor.spec.ts): a
    // `<input type="text" hidden>` honeypot field was originally surfaced as fillable, because
    // only `type="hidden"` was checked, never the separate `hidden` boolean attribute.
    const root = node({
      nodeName: 'DIV',
      children: [
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'referralSource', hidden: '' }) }),
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'real-field' }) }),
      ],
    });
    const { fields } = extractSnapshotFields(root);
    expect(fields).toHaveLength(1);
    expect(fields[0]!.label).toBe('real-field');
  });

  it('gives each fillable element a distinct fieldRef mapped to its own backendNodeId', () => {
    const root = node({
      nodeName: 'DIV',
      children: [
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'a' }) }),
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'b' }) }),
      ],
    });
    const { fields, nodeIds } = extractSnapshotFields(root);
    expect(fields[0]!.fieldRef).not.toBe(fields[1]!.fieldRef);
    expect(nodeIds.get(fields[0]!.fieldRef)).not.toBe(nodeIds.get(fields[1]!.fieldRef));
    expect(nodeIds.size).toBe(2);
  });

  it('classifies a password input as a credential field regardless of name', () => {
    const root = node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'password', name: 'whatever' }) });
    expect(extractSnapshotFields(root).fields[0]!.classification).toBe('credential_field');
  });

  it('classifies by autocomplete token even when type is plain text', () => {
    const root = node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'code', autocomplete: 'one-time-code' }) });
    expect(extractSnapshotFields(root).fields[0]!.classification).toBe('credential_field');
  });

  it('classifies a field named/labelled like a consent checkbox', () => {
    const root = node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'checkbox', name: 'agreeToTerms' }) });
    expect(extractSnapshotFields(root).fields[0]!.classification).toBe('consent_field');
  });

  it('leaves an ordinary field unclassified', () => {
    const root = node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'city' }) });
    expect(extractSnapshotFields(root).fields[0]!.classification).toBeUndefined();
  });

  it('extracts select options with real labels from their text content', () => {
    const select = node({
      nodeName: 'SELECT',
      attributes: attrsFrom({ name: 'country' }),
      children: [
        node({ nodeName: 'OPTION', attributes: attrsFrom({ value: 'nl' }), children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Netherlands', backendNodeId: 0 }] }),
        node({ nodeName: 'OPTION', attributes: attrsFrom({ value: 'de' }), children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Germany', backendNodeId: 0 }] }),
      ],
    });
    const { fields } = extractSnapshotFields(select);
    expect(fields).toHaveLength(1);
    expect(fields[0]!.controlType).toBe('select');
    expect(fields[0]!.options?.map((o) => o.label)).toEqual(['Netherlands', 'Germany']);
    // Two distinct options, never colliding refs.
    const refs = fields[0]!.options!.map((o) => o.optionRef);
    expect(new Set(refs).size).toBe(2);
  });

  it("does not walk into a select's own OPTION children as independent top-level fields", () => {
    const select = node({
      nodeName: 'SELECT',
      attributes: attrsFrom({ name: 'country' }),
      children: [node({ nodeName: 'OPTION', attributes: attrsFrom({ value: 'nl' }) })],
    });
    const { fields } = extractSnapshotFields(select);
    expect(fields).toHaveLength(1); // just the select itself, not a phantom field for the option
  });

  it('classifies file and radio/checkbox control types correctly', () => {
    const root = node({
      nodeName: 'DIV',
      children: [
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'file', name: 'resume' }) }),
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'radio', name: 'yesno' }) }),
        node({ nodeName: 'TEXTAREA', attributes: attrsFrom({ name: 'cover' }) }),
      ],
    });
    const { fields } = extractSnapshotFields(root);
    expect(fields.map((f) => f.controlType)).toEqual(['file', 'radio', 'textarea']);
  });

  it('reads a checkbox\'s real starting checked state from the checked attribute', () => {
    // Real gap found during #201's review: `fill()` used to assume every checkbox starts
    // unchecked. This is what makes the fix possible -- the extracted snapshot must actually carry
    // the control's real starting state for `fill()` to compare against.
    const root = node({
      nodeName: 'DIV',
      children: [
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'checkbox', name: 'unchecked-one' }) }),
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'checkbox', name: 'checked-one', checked: '' }) }),
      ],
    });
    const { fields } = extractSnapshotFields(root);
    expect(fields[0]!.checked).toBe(false);
    expect(fields[1]!.checked).toBe(true);
  });

  it('never sets `checked` on a non-checkbox control', () => {
    const root = node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'x' }) });
    const { fields } = extractSnapshotFields(root);
    expect(fields[0]!.checked).toBeUndefined();
  });
});

describe('extractSnapshotFields: challenge detection', () => {
  it('flags a reCAPTCHA iframe by its src', () => {
    const root = node({
      nodeName: 'DIV',
      children: [
        node({ nodeName: 'IFRAME', attributes: attrsFrom({ src: 'https://www.google.com/recaptcha/api2/anchor' }) }),
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'real-field' }) }),
      ],
    });
    const { challengeDetected } = extractSnapshotFields(root);
    expect(challengeDetected).toBe(true);
  });

  it('flags an hCaptcha iframe by its src', () => {
    const root = node({ nodeName: 'IFRAME', attributes: attrsFrom({ src: 'https://newassets.hcaptcha.com/captcha/v1/frame' }) });
    expect(extractSnapshotFields(root).challengeDetected).toBe(true);
  });

  it('flags a Cloudflare Turnstile iframe by its src', () => {
    const root = node({ nodeName: 'IFRAME', attributes: attrsFrom({ src: 'https://challenges.cloudflare.com/turnstile/v0/api.js' }) });
    expect(extractSnapshotFields(root).challengeDetected).toBe(true);
  });

  it('flags a challenge container by class name, as a fallback for an iframe not yet loaded', () => {
    const root = node({
      nodeName: 'DIV',
      attributes: attrsFrom({ class: 'form-row g-recaptcha' }),
    });
    expect(extractSnapshotFields(root).challengeDetected).toBe(true);
  });

  it('flags an h-captcha or cf-turnstile class the same way', () => {
    expect(extractSnapshotFields(node({ nodeName: 'DIV', attributes: attrsFrom({ class: 'h-captcha' }) })).challengeDetected).toBe(true);
    expect(extractSnapshotFields(node({ nodeName: 'DIV', attributes: attrsFrom({ class: 'cf-turnstile' }) })).challengeDetected).toBe(true);
  });

  it('does not flag an unrelated iframe or class name', () => {
    const root = node({
      nodeName: 'DIV',
      children: [
        node({ nodeName: 'IFRAME', attributes: attrsFrom({ src: 'https://player.vimeo.com/video/123' }) }),
        node({ nodeName: 'DIV', attributes: attrsFrom({ class: 'form-row highlighted' }) }),
      ],
    });
    expect(extractSnapshotFields(root).challengeDetected).toBe(false);
  });

  it('leaves challengeDetected false on an ordinary form with no widget', () => {
    const root = node({
      nodeName: 'DIV',
      children: [node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'a' }) })],
    });
    expect(extractSnapshotFields(root).challengeDetected).toBe(false);
  });
});

describe('extractSnapshotFields: submit control detection', () => {
  it('detects a plain <button> as submit-shaped by default (no explicit type)', () => {
    const root = node({ nodeName: 'BUTTON', children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Submit Application', backendNodeId: 0 }] });
    const { submitControls } = extractSnapshotFields(root);
    expect(submitControls).toHaveLength(1);
    expect(submitControls[0]!.label).toBe('Submit Application');
  });

  it('detects an <input type="submit"> and reads its label from value', () => {
    const root = node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'submit', value: 'Apply Now' }) });
    const { submitControls } = extractSnapshotFields(root);
    expect(submitControls).toHaveLength(1);
    expect(submitControls[0]!.label).toBe('Apply Now');
  });

  it('falls back to "Submit" when an <input type="submit"> has no value attribute', () => {
    const root = node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'submit' }) });
    expect(extractSnapshotFields(root).submitControls[0]!.label).toBe('Submit');
  });

  it('does not treat a <button type="button"> or <button type="reset"> as submit-shaped', () => {
    const root = node({
      nodeName: 'DIV',
      children: [
        node({ nodeName: 'BUTTON', attributes: attrsFrom({ type: 'button' }), children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Back', backendNodeId: 0 }] }),
        node({ nodeName: 'BUTTON', attributes: attrsFrom({ type: 'reset' }), children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Clear', backendNodeId: 0 }] }),
      ],
    });
    expect(extractSnapshotFields(root).submitControls).toHaveLength(0);
  });

  it('never surfaces an <input type="submit"> as a fillable field', () => {
    const root = node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'submit', value: 'Submit' }) });
    const { fields, submitControls } = extractSnapshotFields(root);
    expect(fields).toHaveLength(0);
    expect(submitControls).toHaveLength(1);
  });

  it('skips a disabled or hidden submit button entirely', () => {
    const root = node({
      nodeName: 'DIV',
      children: [
        node({ nodeName: 'BUTTON', attributes: attrsFrom({ disabled: '' }), children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Submit', backendNodeId: 0 }] }),
        node({ nodeName: 'BUTTON', attributes: attrsFrom({ hidden: '' }), children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Submit', backendNodeId: 0 }] }),
      ],
    });
    expect(extractSnapshotFields(root).submitControls).toHaveLength(0);
  });

  it('gives each submit control a distinct controlRef mapped to its own backendNodeId', () => {
    const root = node({
      nodeName: 'DIV',
      children: [
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'submit', value: 'Submit' }) }),
        node({ nodeName: 'BUTTON', children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Apply', backendNodeId: 0 }] }),
      ],
    });
    const { submitControls, nodeIds } = extractSnapshotFields(root);
    expect(submitControls).toHaveLength(2);
    expect(submitControls[0]!.controlRef).not.toBe(submitControls[1]!.controlRef);
    expect(nodeIds.get(submitControls[0]!.controlRef)).not.toBe(nodeIds.get(submitControls[1]!.controlRef));
  });
});

describe('extractSnapshotFields: submit-control scoping (never a candidate from an unrelated form/frame)', () => {
  it('excludes a submit button inside a different <form> than the one the real fields are in', () => {
    const root = node({
      nodeName: 'BODY',
      children: [
        node({
          nodeName: 'FORM',
          children: [
            node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'fullName' }) }),
            node({ nodeName: 'BUTTON', children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Submit Application', backendNodeId: 0 }] }),
          ],
        }),
        node({
          // A newsletter-signup mini-form elsewhere on the same page -- a real, unrelated <form>.
          nodeName: 'FORM',
          children: [node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'submit', value: 'Subscribe' }) })],
        }),
      ],
    });
    const { fields, submitControls } = extractSnapshotFields(root);
    expect(fields).toHaveLength(1);
    expect(submitControls).toHaveLength(1);
    expect(submitControls[0]!.label).toBe('Submit Application');
  });

  it('excludes a submit-shaped button outside any <form> when the real fields are inside one', () => {
    const root = node({
      nodeName: 'BODY',
      children: [
        node({
          nodeName: 'FORM',
          children: [
            node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'fullName' }) }),
            node({ nodeName: 'BUTTON', children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Submit Application', backendNodeId: 0 }] }),
          ],
        }),
        // A header search box's own submit-shaped button, outside the application <form> entirely.
        node({ nodeName: 'BUTTON', children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Send', backendNodeId: 0 }] }),
      ],
    });
    const { submitControls } = extractSnapshotFields(root);
    expect(submitControls).toHaveLength(1);
    expect(submitControls[0]!.label).toBe('Submit Application');
  });

  it('excludes a submit control found in a different iframe than the one the real fields are in', () => {
    const root = node({
      nodeName: 'BODY',
      children: [
        node({
          nodeName: 'IFRAME',
          contentDocument: node({
            nodeName: '#document',
            children: [
              node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'fullName' }) }),
              node({ nodeName: 'BUTTON', children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Submit Application', backendNodeId: 0 }] }),
            ],
          }),
        }),
        // A chat-widget iframe elsewhere on the page, unrelated to the application form.
        node({
          nodeName: 'IFRAME',
          contentDocument: node({
            nodeName: '#document',
            children: [node({ nodeName: 'BUTTON', children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Send', backendNodeId: 0 }] })],
          }),
        }),
      ],
    });
    const { fields, submitControls } = extractSnapshotFields(root);
    expect(fields).toHaveLength(1);
    expect(submitControls).toHaveLength(1);
    expect(submitControls[0]!.label).toBe('Submit Application');
  });

  it('does not descend into an IFRAME with no contentDocument (pierce not requested, or not yet loaded)', () => {
    const root = node({
      nodeName: 'BODY',
      children: [
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'fullName' }) }),
        node({ nodeName: 'IFRAME', attributes: attrsFrom({ src: 'https://example.invalid/widget' }) }),
      ],
    });
    const { fields, submitControls } = extractSnapshotFields(root);
    expect(fields).toHaveLength(1);
    expect(submitControls).toHaveLength(0);
  });

  it('falls back to the top-level frame/no-form scope when there are no fields to derive a dominant scope from', () => {
    // A field-less "review and submit" final step: nothing to compare a candidate's scope
    // against, so the top document's own submit button must still be a candidate.
    const root = node({ nodeName: 'BUTTON', children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Submit Application', backendNodeId: 0 }] });
    const { submitControls } = extractSnapshotFields(root);
    expect(submitControls).toHaveLength(1);
  });
});

describe('extractSubmissionSignals (#271)', () => {
  function text(value: string): CdpDomNode {
    return { nodeName: '#text', nodeType: 3, nodeValue: value, backendNodeId: 0 };
  }

  it('collects visible page text, whitespace-collapsed, skipping script and style bodies', () => {
    const root = node({
      nodeName: 'BODY',
      children: [
        node({ nodeName: 'SCRIPT', children: [text('var thankYouForApplying = false;')] }),
        node({ nodeName: 'STYLE', children: [text('.error { color: red }')] }),
        node({ nodeName: 'H1', children: [text('  Your application   has been submitted ')] }),
      ],
    });
    const signals = extractSubmissionSignals(root);
    expect(signals.text).toBe('Your application has been submitted');
    expect(signals.text).not.toContain('thankYouForApplying');
  });

  it('reports the form as still standing while any submit-shaped control remains', () => {
    const root = node({ nodeName: 'BODY', children: [node({ nodeName: 'BUTTON', children: [text('Submit Application')] })] });
    expect(extractSubmissionSignals(root).formStillPresent).toBe(true);
  });

  it('reports the form as gone on a page with no submit-shaped control left', () => {
    const root = node({ nodeName: 'BODY', children: [node({ nodeName: 'H1', children: [text('Thank you for applying')] })] });
    expect(extractSubmissionSignals(root).formStillPresent).toBe(false);
  });

  it('collects an error-classed marker with its message', () => {
    const root = node({
      nodeName: 'BODY',
      children: [node({ nodeName: 'DIV', attributes: attrsFrom({ class: 'field-error' }), children: [text('Full name is required')] })],
    });
    expect(extractSubmissionSignals(root).errorMarkers).toEqual(['Full name is required']);
  });

  it('records an aria-invalid control by its own name even when the message lives in a sibling node', () => {
    const root = node({
      nodeName: 'FORM',
      children: [
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'fullName', 'aria-invalid': 'true' }) }),
        node({ nodeName: 'SPAN', children: [text('Please enter your name')] }),
      ],
    });
    expect(extractSubmissionSignals(root).errorMarkers).toEqual(['field "fullName" was flagged invalid']);
  });

  it('ignores an empty error container, which plenty of forms ship unconditionally in the markup', () => {
    const root = node({
      nodeName: 'BODY',
      children: [node({ nodeName: 'DIV', attributes: attrsFrom({ class: 'error-message' }), children: [] })],
    });
    expect(extractSubmissionSignals(root).errorMarkers).toEqual([]);
  });

  it('never reads a success banner as an error marker -- an alert role and an alert-success class are not error signals', () => {
    // A real regression risk in the other direction: misreading a success banner would report a
    // genuinely delivered application as one that still needs attention.
    const root = node({
      nodeName: 'BODY',
      children: [
        node({
          nodeName: 'DIV',
          attributes: attrsFrom({ role: 'alert', class: 'alert alert-success' }),
          children: [text('Your application has been submitted')],
        }),
      ],
    });
    expect(extractSubmissionSignals(root).errorMarkers).toEqual([]);
  });

  it('reads through an iframe the page embeds its confirmation in', () => {
    const root = node({
      nodeName: 'BODY',
      children: [
        node({
          nodeName: 'IFRAME',
          attributes: attrsFrom({ src: 'https://fixture.example.invalid/embedded' }),
          contentDocument: node({ nodeName: 'BODY', children: [node({ nodeName: 'P', children: [text('Application reference: FIXTURE-42-0001')] })] }),
        }),
      ],
    });
    expect(extractSubmissionSignals(root).text).toContain('FIXTURE-42-0001');
  });

  it('bounds collected page text rather than copying an unbounded third-party document', () => {
    const root = node({
      nodeName: 'BODY',
      children: Array.from({ length: 4000 }, () => node({ nodeName: 'P', children: [text('x'.repeat(50))] })),
    });
    expect(extractSubmissionSignals(root).text.length).toBeLessThanOrEqual(MAX_OBSERVED_PAGE_TEXT_LENGTH);
  });
});

/**
 * Frame/form identity, validation messages and field grouping (#277). None of this is new CDP
 * surface: it is all read from the same `DOM.getDocument` tree the extractor already walked, and it
 * is what the executor's rendering probe then narrows.
 */
describe('extractSnapshotFields: frame and form identity (#277)', () => {
  it('tags every field with the frame it was found in, counting pierced iframes from 1', () => {
    const root = node({
      nodeName: 'BODY',
      children: [
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'topLevel' }) }),
        node({
          nodeName: 'IFRAME',
          attributes: attrsFrom({ src: 'https://example.invalid/form' }),
          contentDocument: node({
            nodeName: '#document',
            nodeType: 9,
            children: [node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'inFrame' }) })],
          }),
        }),
      ],
    });
    const { fields } = extractSnapshotFields(root);
    expect(fields.find((f) => f.label === 'topLevel')!.frameId).toBe(0);
    expect(fields.find((f) => f.label === 'inFrame')!.frameId).toBe(1);
  });

  it('tags every field with its nearest enclosing form, and leaves formScope absent outside one', () => {
    const form = node({
      nodeName: 'FORM',
      children: [node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'inForm' }) })],
    });
    const root = node({
      nodeName: 'BODY',
      children: [form, node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'loose' }) })],
    });
    const { fields } = extractSnapshotFields(root);
    expect(fields.find((f) => f.label === 'inForm')!.formScope).toBe(form.backendNodeId);
    expect(fields.find((f) => f.label === 'loose')!.formScope).toBeUndefined();
  });

  it('groups fields by frame/form pair and points each group at the container that settles it', () => {
    const form = node({
      nodeName: 'FORM',
      children: [
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'a' }) }),
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'b' }) }),
      ],
    });
    const root = node({
      nodeName: 'BODY',
      children: [form, node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'newsletter' }) })],
    });
    const { fieldGroups } = extractSnapshotFields(root);
    expect(fieldGroups).toHaveLength(2);
    // The form's own element is what the rendering probe should ask about for that group.
    expect(fieldGroups[0]).toMatchObject({ frameId: 0, formScope: form.backendNodeId, containerNodeId: form.backendNodeId });
    expect(fieldGroups[0]!.fieldRefs).toHaveLength(2);
  });

  it('uses the hosting iframe element as the container for a form-less field inside a frame', () => {
    const iframe = node({
      nodeName: 'IFRAME',
      attributes: attrsFrom({ src: 'https://example.invalid/form' }),
      contentDocument: node({
        nodeName: '#document',
        nodeType: 9,
        children: [node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'inFrame' }) })],
      }),
    });
    const root = node({ nodeName: 'BODY', children: [iframe] });
    const { fieldGroups } = extractSnapshotFields(root);
    expect(fieldGroups[0]).toMatchObject({ frameId: 1, containerNodeId: iframe.backendNodeId });
  });

  it('carries every submit candidate with its own frame/form, alongside the narrowed list', () => {
    const form = node({
      nodeName: 'FORM',
      children: [
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'a' }) }),
        node({ nodeName: 'BUTTON', children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Submit Application', backendNodeId: 0 }] }),
      ],
    });
    const root = node({
      nodeName: 'BODY',
      children: [form, node({ nodeName: 'BUTTON', children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Search', backendNodeId: 0 }] })],
    });
    const { submitControls, submitCandidates } = extractSnapshotFields(root);
    expect(submitControls.map((c) => c.label)).toEqual(['Submit Application']);
    // Both are still available for the executor to re-narrow once the rendering probe has run.
    expect(submitCandidates.map((c) => c.control.label).sort()).toEqual(['Search', 'Submit Application']);
  });

  it('marks every field active by default, since a single-form page has nothing to disambiguate', () => {
    const root = node({
      nodeName: 'BODY',
      children: [node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'a' }) })],
    });
    const { fields } = extractSnapshotFields(root);
    expect(fields[0]!.active).toBe(true);
    expect(fields[0]!.rendered).toBeUndefined(); // no probe was run, which is not the same as "hidden"
  });
});

describe('extractSnapshotFields: validation messages (#277)', () => {
  it('reads the text of the element aria-errormessage points at', () => {
    const root = node({
      nodeName: 'BODY',
      children: [
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'email', name: 'email', 'aria-errormessage': 'email-error' }) }),
        node({
          nodeName: 'SPAN',
          attributes: attrsFrom({ id: 'email-error' }),
          children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Enter a valid email address.', backendNodeId: 0 }],
        }),
      ],
    });
    const { fields } = extractSnapshotFields(root);
    expect(fields[0]!.validationMessage).toBe('Enter a valid email address.');
  });

  it('resolves a forward reference, since an error element can come after the field it describes', () => {
    const root = node({
      nodeName: 'BODY',
      children: [
        node({
          nodeName: 'SPAN',
          attributes: attrsFrom({ id: 'name-error' }),
          children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'This field is required.', backendNodeId: 0 }],
        }),
        node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'fullName', 'aria-errormessage': 'name-error' }) }),
      ],
    });
    const { fields } = extractSnapshotFields(root);
    expect(fields[0]!.validationMessage).toBe('This field is required.');
  });

  it('uses aria-describedby only for a field the page marked invalid, never for ordinary help text', () => {
    const help = node({
      nodeName: 'SPAN',
      attributes: attrsFrom({ id: 'help' }),
      children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'We will never share this.', backendNodeId: 0 }],
    });
    const valid = extractSnapshotFields(
      node({
        nodeName: 'BODY',
        children: [node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'email', name: 'email', 'aria-describedby': 'help' }) }), help],
      }),
    );
    expect(valid.fields[0]!.validationMessage).toBeUndefined();

    const invalid = extractSnapshotFields(
      node({
        nodeName: 'BODY',
        children: [
          node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'email', name: 'email', 'aria-describedby': 'help2', 'aria-invalid': 'true' }) }),
          node({
            nodeName: 'SPAN',
            attributes: attrsFrom({ id: 'help2' }),
            children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'We will never share this.', backendNodeId: 0 }],
          }),
        ],
      }),
    );
    expect(invalid.fields[0]!.invalid).toBe(true);
    expect(invalid.fields[0]!.validationMessage).toBe('We will never share this.');
  });

  it('does not resolve an id reference across a frame boundary', () => {
    // An id reference only ever resolves inside its own document. Matching across frames would let
    // one document's text be attributed to another document's field.
    const root = node({
      nodeName: 'BODY',
      children: [
        node({
          nodeName: 'SPAN',
          attributes: attrsFrom({ id: 'shared-id' }),
          children: [{ nodeName: '#text', nodeType: 3, nodeValue: 'Top-level text.', backendNodeId: 0 }],
        }),
        node({
          nodeName: 'IFRAME',
          attributes: attrsFrom({ src: 'https://example.invalid/form' }),
          contentDocument: node({
            nodeName: '#document',
            nodeType: 9,
            children: [node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'inFrame', 'aria-errormessage': 'shared-id' }) })],
          }),
        }),
      ],
    });
    const { fields } = extractSnapshotFields(root);
    expect(fields[0]!.validationMessage).toBeUndefined();
  });

  it('treats aria-required as required, the way a real custom control marks itself', () => {
    const root = node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'text', name: 'x', 'aria-required': 'true' }) });
    expect(extractSnapshotFields(root).fields[0]!.required).toBe(true);
  });

  it('reads the checked state of a radio, not only a checkbox', () => {
    const root = node({ nodeName: 'INPUT', attributes: attrsFrom({ type: 'radio', name: 'remote', checked: '' }) });
    expect(extractSnapshotFields(root).fields[0]).toMatchObject({ controlType: 'radio', checked: true });
  });
});
