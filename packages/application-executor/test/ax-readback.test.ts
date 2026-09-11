import { describe, expect, it } from 'vitest';
import { readAttachmentNames, readAxControlState } from '../src/ax-readback.js';

/**
 * The parsing half of #277's read-back, against hand-built `Accessibility.getPartialAXTree`
 * responses. Every shape here is one a real Chromium response actually uses (a tristate `checked`,
 * a token `invalid`, an `AXValue` wrapper around every scalar), because the failure mode this
 * parser has to avoid is reading a plausible-looking response and quietly answering `undefined`.
 */

function node(overrides: Record<string, unknown>): Record<string, unknown> {
  return { role: { type: 'role', value: 'textbox' }, ...overrides };
}

describe('readAxControlState', () => {
  it('reads a text control\'s committed value', () => {
    const state = readAxControlState({ nodes: [node({ backendDOMNodeId: 7, value: { type: 'string', value: 'Ada Lovelace' } })] }, 7);
    expect(state).toEqual({ value: 'Ada Lovelace' });
  });

  it('picks the node describing the requested DOM node, not the first or last in the response', () => {
    // A real partial tree carries ancestors. Picking positionally works on every fixture and then
    // reads a wrapping <div>'s state on a real page.
    const response = {
      nodes: [
        node({ backendDOMNodeId: 1, role: { value: 'WebArea' }, value: { type: 'string', value: 'the document' } }),
        node({ backendDOMNodeId: 7, value: { type: 'string', value: 'the field' } }),
        node({ backendDOMNodeId: 9, value: { type: 'string', value: 'a sibling' } }),
      ],
    };
    expect(readAxControlState(response, 7)?.value).toBe('the field');
  });

  it('prefers a non-ignored node over an ignored one describing the same DOM node', () => {
    const response = {
      nodes: [
        node({ backendDOMNodeId: 7, ignored: true, value: { type: 'string', value: 'the ignored shadow' } }),
        node({ backendDOMNodeId: 7, value: { type: 'string', value: 'the real one' } }),
      ],
    };
    expect(readAxControlState(response, 7)?.value).toBe('the real one');
  });

  it('still reports an ignored node when it is the only one describing the DOM node', () => {
    const response = { nodes: [node({ backendDOMNodeId: 7, ignored: true, value: { type: 'string', value: 'aria-hidden but real' } })] };
    expect(readAxControlState(response, 7)?.value).toBe('aria-hidden but real');
  });

  it('returns undefined, never an empty state, when no node describes the requested DOM node', () => {
    // The distinction the whole verification rests on: "the browser did not say" must never read
    // as "the field is empty".
    expect(readAxControlState({ nodes: [node({ backendDOMNodeId: 3 })] }, 7)).toBeUndefined();
    expect(readAxControlState({ nodes: [] }, 7)).toBeUndefined();
    expect(readAxControlState({}, 7)).toBeUndefined();
    expect(readAxControlState(undefined, 7)).toBeUndefined();
  });

  it('reads a tristate checked property as a real boolean, and leaves "mixed" as neither', () => {
    const checked = (value: string) => ({ nodes: [node({ backendDOMNodeId: 7, properties: [{ name: 'checked', value: { type: 'tristate', value } }] })] });
    expect(readAxControlState(checked('true'), 7)?.checked).toBe(true);
    expect(readAxControlState(checked('false'), 7)?.checked).toBe(false);
    // "mixed" is a real third state and is deliberately not folded into either answer.
    expect(readAxControlState(checked('mixed'), 7)?.checked).toBeUndefined();
  });

  it('treats any invalid token other than "false" as invalid, including spelling and grammar', () => {
    const invalid = (value: string) => ({ nodes: [node({ backendDOMNodeId: 7, properties: [{ name: 'invalid', value: { type: 'token', value } }] })] });
    expect(readAxControlState(invalid('false'), 7)?.invalid).toBe(false);
    expect(readAxControlState(invalid('true'), 7)?.invalid).toBe(true);
    expect(readAxControlState(invalid('spelling'), 7)?.invalid).toBe(true);
    // Absent entirely is unknown, not valid.
    expect(readAxControlState({ nodes: [node({ backendDOMNodeId: 7 })] }, 7)?.invalid).toBeUndefined();
  });

  it('reads name, description and required alongside the value', () => {
    const state = readAxControlState(
      {
        nodes: [
          node({
            backendDOMNodeId: 7,
            name: { type: 'computedString', value: 'Full name' },
            description: { type: 'computedString', value: 'This field is required.' },
            properties: [{ name: 'required', value: { type: 'booleanOrUndefined', value: true } }],
          }),
        ],
      },
      7,
    );
    expect(state).toMatchObject({ name: 'Full name', description: 'This field is required.', required: true });
  });
});

describe('readAttachmentNames', () => {
  it('finds the chosen file name inside the browser\'s own surrounding caption', () => {
    const state = { value: 'Choose file: resume.pdf' };
    expect(readAttachmentNames(state, ['resume.pdf'])).toEqual(['resume.pdf']);
  });

  it('never matches on the accessible name or description, which the page itself authors', () => {
    // The one case that is worse than an unconfirmed attachment: a page that reads
    // `input.files[0].name`, echoes it into `aria-label`, and discards the file would otherwise be
    // able to tell the applicant their CV landed on a form that threw it away.
    expect(readAttachmentNames({ value: 'No file chosen', name: 'resume.pdf' }, ['resume.pdf'])).toEqual([]);
    expect(readAttachmentNames({ value: 'No file chosen', description: 'resume.pdf attached' }, ['resume.pdf'])).toEqual([]);
  });

  it('matches case-insensitively, since the caption is browser- and locale-dependent', () => {
    expect(readAttachmentNames({ value: 'RESUME.PDF' }, ['resume.pdf'])).toEqual(['resume.pdf']);
  });

  it('returns nothing for a control reporting no file chosen', () => {
    expect(readAttachmentNames({ value: 'No file chosen' }, ['resume.pdf'])).toEqual([]);
  });

  it('returns nothing when the browser published no state at all', () => {
    expect(readAttachmentNames(undefined, ['resume.pdf'])).toEqual([]);
  });

  it('never matches on an empty expected name, which would match every caption', () => {
    expect(readAttachmentNames({ value: 'No file chosen' }, [''])).toEqual([]);
  });
});
