import { describe, expect, it } from 'vitest';
import { extractSnapshotFields, type CdpDomNode } from '../src/dom-extract.js';

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
});
