import type { CdpTransport } from '../src/executor.js';
import type { CdpDomNode } from '../src/dom-extract.js';

/**
 * A `CdpTransport` that behaves like a browser rather than like a call recorder (#277).
 *
 * The point of this file is that the tests using it can *fail*. A transport that answers every
 * write with `{}` cannot tell a fill that replaced from a fill that appended, a select that moved
 * from one that did not, or an upload that landed from one that was dropped -- which is exactly why
 * those gaps survived as long as they did. This one keeps per-control committed state, applies real
 * edits to it, and publishes it back through `Accessibility.getPartialAXTree` the way a real
 * browser does, so an executor that sends the right commands in the wrong order produces a wrong
 * committed value here and the test says so.
 *
 * Deliberately not a Chromium emulator: it models the specific behaviours this package's read-back
 * depends on (caret insertion vs. selection replacement, blur on Tab, the arrow-key select drive,
 * layout presence) and nothing else.
 */

export interface FakeControl {
  kind: 'text' | 'checkbox' | 'radio' | 'select' | 'file';
  value: string;
  checked: boolean;
  optionLabels: string[];
  /** Whether the browser lays this node out. A fixture sets this false for a decoy the page hides
   * with a stylesheet, which no amount of markup reading can detect. */
  rendered: boolean;
  /** A validation message the browser publishes as this control's accessible description. Only
   * surfaced when `invalid` is set, matching how a real page marks a field in error. */
  invalid: boolean;
  description: string;
}

export interface FakeBrowserOptions {
  /** Nodes (by `backendNodeId`) the browser lays out nothing for, as a stylesheet's `display: none`
   * produces. Applies to `<iframe>`/`<form>` container nodes as well as controls. */
  notRendered?: readonly number[];
  /** Per-node overrides applied after the tree is read, e.g. to mark a control invalid. */
  overrides?: Readonly<Record<number, Partial<FakeControl>>>;
}

function attrOf(node: CdpDomNode, name: string): string | undefined {
  const list = node.attributes;
  if (!list) return undefined;
  for (let i = 0; i + 1 < list.length; i += 2) {
    if (list[i]?.toLowerCase() === name.toLowerCase()) return list[i + 1];
  }
  return undefined;
}

function walk(node: CdpDomNode, visit: (node: CdpDomNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
  if (node.contentDocument) walk(node.contentDocument, visit);
}

export interface FakeBrowser {
  transport: CdpTransport;
  calls: Array<{ method: string; params: unknown }>;
  controls: Map<number, FakeControl>;
  /** Test-only: change the page under the executor's feet, the way a real page re-rendering does. */
  setTree(next: CdpDomNode): void;
}

export function fakeBrowser(tree: CdpDomNode, options: FakeBrowserOptions = {}): FakeBrowser {
  let currentTree = tree;
  const calls: Array<{ method: string; params: unknown }> = [];
  const controls = new Map<number, FakeControl>();
  const notRendered = new Set(options.notRendered ?? []);

  function indexTree(root: CdpDomNode): void {
    walk(root, (node) => {
      const inputType = (attrOf(node, 'type') ?? 'text').toLowerCase();
      let kind: FakeControl['kind'] | undefined;
      if (node.nodeName === 'SELECT') kind = 'select';
      else if (node.nodeName === 'TEXTAREA') kind = 'text';
      else if (node.nodeName === 'INPUT') {
        kind = inputType === 'checkbox' || inputType === 'radio' || inputType === 'file' ? (inputType as FakeControl['kind']) : 'text';
      }
      if (!kind) return;
      if (controls.has(node.backendNodeId)) return; // keep committed state across a re-read
      const optionLabels = (node.children ?? [])
        .filter((child) => child.nodeName === 'OPTION')
        .map((child) => (child.children ?? []).map((text) => text.nodeValue ?? '').join('') || (attrOf(child, 'value') ?? ''));
      controls.set(node.backendNodeId, {
        kind,
        value: kind === 'select' ? (optionLabels[0] ?? '') : (attrOf(node, 'value') ?? ''),
        checked: attrOf(node, 'checked') !== undefined,
        optionLabels,
        rendered: !notRendered.has(node.backendNodeId),
        invalid: false,
        description: '',
        ...(options.overrides?.[node.backendNodeId] ?? {}),
      });
    });
  }
  indexTree(currentTree);

  let focused: number | undefined;
  let lastBoxModelNode: number | undefined;
  let wholeControlSelected = false;
  let selectIndex = 0;

  const transport: CdpTransport = {
    async sendCommand(method, params) {
      calls.push({ method, params });
      const backendNodeId = typeof params?.backendNodeId === 'number' ? params.backendNodeId : undefined;
      switch (method) {
        case 'Page.navigate':
          return {};
        case 'DOM.getDocument':
          return { root: currentTree };
        case 'Page.captureScreenshot':
          return { data: 'ZmFrZS1zY3JlZW5zaG90' };
        case 'DOM.getBoxModel':
          lastBoxModelNode = backendNodeId;
          return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
        case 'DOM.getContentQuads':
          // Chromium raises rather than returning an empty list for a node with no layout box.
          if (backendNodeId !== undefined && notRendered.has(backendNodeId)) {
            throw new Error('Could not compute content quads.');
          }
          return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] };
        case 'DOM.focus': {
          focused = backendNodeId;
          wholeControlSelected = false;
          const control = focused !== undefined ? controls.get(focused) : undefined;
          selectIndex = control ? Math.max(0, control.optionLabels.indexOf(control.value)) : 0;
          return {};
        }
        case 'Input.insertText': {
          const control = focused !== undefined ? controls.get(focused) : undefined;
          if (control) {
            const text = typeof params?.text === 'string' ? params.text : '';
            // Without a preceding selectAll this APPENDS at the caret, which is the real browser
            // behaviour that made a repeated fill produce "valuevalue".
            control.value = wholeControlSelected ? text : control.value + text;
            wholeControlSelected = false;
          }
          return {};
        }
        case 'Input.dispatchKeyEvent': {
          const commands = Array.isArray(params?.commands) ? (params.commands as string[]) : [];
          const key = typeof params?.key === 'string' ? params.key : '';
          const isKeyDown = params?.type === 'keyDown';
          const control = focused !== undefined ? controls.get(focused) : undefined;
          if (commands.includes('selectAll')) wholeControlSelected = true;
          if (commands.includes('delete') && control) {
            control.value = '';
            wholeControlSelected = false;
          }
          if (isKeyDown && control?.kind === 'select') {
            if (key === 'ArrowUp') selectIndex = Math.max(0, selectIndex - 1);
            if (key === 'ArrowDown') selectIndex = Math.min(control.optionLabels.length - 1, selectIndex + 1);
            if (key === 'Enter') control.value = control.optionLabels[selectIndex] ?? '';
          }
          if (isKeyDown && key === 'Tab') focused = undefined; // a real blur
          return {};
        }
        case 'Input.dispatchMouseEvent': {
          if (params?.type === 'mouseReleased' && lastBoxModelNode !== undefined) {
            const control = controls.get(lastBoxModelNode);
            if (control && (control.kind === 'checkbox' || control.kind === 'radio')) control.checked = !control.checked;
          }
          return {};
        }
        case 'DOM.setFileInputFiles': {
          const files = Array.isArray(params?.files) ? (params.files as string[]) : [];
          const control = backendNodeId !== undefined ? controls.get(backendNodeId) : undefined;
          if (control) control.value = (files[0] ?? '').split(/[\\/]/).pop() ?? '';
          return {};
        }
        case 'Accessibility.getPartialAXTree': {
          const control = backendNodeId !== undefined ? controls.get(backendNodeId) : undefined;
          if (!control) return { nodes: [] };
          return {
            nodes: [
              // An ancestor node, as a real partial tree carries, to prove the reader picks by
              // `backendDOMNodeId` rather than by position.
              { backendDOMNodeId: 999_999, role: { value: 'group' }, value: { type: 'string', value: 'not this one' } },
              {
                backendDOMNodeId: backendNodeId,
                value: { type: 'string', value: control.value },
                name: { type: 'computedString', value: control.kind === 'file' ? control.value : '' },
                description: { type: 'computedString', value: control.description },
                properties: [
                  ...(control.kind === 'checkbox' || control.kind === 'radio'
                    ? [{ name: 'checked', value: { type: 'tristate', value: control.checked ? 'true' : 'false' } }]
                    : []),
                  { name: 'invalid', value: { type: 'token', value: control.invalid ? 'true' : 'false' } },
                ],
              },
            ],
          };
        }
        default:
          throw new Error(`unexpected CDP method in test: ${method} ${JSON.stringify(params)}`);
      }
    },
  };

  return {
    transport,
    calls,
    controls,
    setTree(next) {
      currentTree = next;
      indexTree(next);
    },
  };
}
