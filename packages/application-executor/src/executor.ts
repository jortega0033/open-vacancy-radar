import { assertAllowedCdpMethod } from './cdp-allowlist.js';
import { extractSnapshotFields, type CdpDomNode, type FieldNodeMap } from './dom-extract.js';
import { findSnapshotField, type FormSnapshot } from './form-snapshot.js';
import { isActionAllowed, isOriginAllowed, type ApplicationTargetPolicy, type ExecutorAction } from './target-policy.js';

/**
 * The deterministic executor (#196 §1.1, §2): the seven implemented actions
 * (`openTarget`/`snapshot`/`fill`/`select`/`attach`/`capture`/`handoff`) plus the eighth,
 * `submit`, which does not exist in this slice's code at all -- see `target-policy.ts`'s own
 * comment on `ExecutorAction`.
 *
 * Every method that ultimately calls the transport goes through `assertAllowedCdpMethod` first
 * (`cdp-allowlist.ts`), so a method outside the frozen allowlist throws before it ever reaches a
 * real CDP connection, regardless of how this class is called.
 *
 * `CdpTransport` is a structural interface, not `Electron.Debugger` itself: this package stays
 * Electron-free and fully unit-testable with a fake transport. The real adapter over
 * `webContents.debugger` lives in `apps/desktop/electron/`.
 */
export interface CdpTransport {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export class ExecutorPolicyError extends Error {
  constructor(
    public readonly action: string,
    reason: string,
  ) {
    super(`action "${action}" refused: ${reason}`);
    this.name = 'ExecutorPolicyError';
  }
}

export type HandoffReason =
  | 'login_wall'
  | 'captcha'
  | 'missing_mandatory_answer'
  | 'unsupported_control'
  | 'off_policy_navigation'
  | 'unrecognized_field'
  | 'user_requested';

export interface HandoffResult {
  action: 'handoff';
  reason: HandoffReason;
}

interface BoxModel {
  content: readonly number[]; // [x1,y1, x2,y2, x3,y3, x4,y4] quad
}

function boxCenter(box: BoxModel): { x: number; y: number } {
  const [x1, y1, , , x3, y3] = box.content;
  return { x: ((x1 ?? 0) + (x3 ?? 0)) / 2, y: ((y1 ?? 0) + (y3 ?? 0)) / 2 };
}

/** One executor instance per attempt/target. Owns the current snapshot generation and the
 * fieldRef -> CDP node-handle map so `fill`/`select`/`attach` can issue correctly-targeted CDP
 * calls -- the node map never leaves this class (see `dom-extract.ts`'s own doc comment on why). */
export class ApplicationExecutor {
  #generation = 0;
  #currentSnapshot: FormSnapshot | undefined;
  #nodeIds: FieldNodeMap = new Map();

  constructor(
    private readonly transport: CdpTransport,
    private readonly policy: ApplicationTargetPolicy,
  ) {}

  get currentSnapshot(): FormSnapshot | undefined {
    return this.#currentSnapshot;
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    assertAllowedCdpMethod(method);
    return this.transport.sendCommand(method, params);
  }

  private requireAction(action: ExecutorAction): void {
    if (!isActionAllowed(this.policy, action)) {
      throw new ExecutorPolicyError(action, `not permitted by policy "${this.policy.id}"`);
    }
  }

  private nodeIdFor(action: string, fieldRef: string): number {
    const backendNodeId = this.#nodeIds.get(fieldRef);
    if (backendNodeId === undefined) throw new ExecutorPolicyError(action, `unknown fieldRef ${fieldRef}`);
    return backendNodeId;
  }

  private currentField(fieldRef: string): ReturnType<typeof findSnapshotField> {
    if (!this.#currentSnapshot) return undefined;
    return findSnapshotField(this.#currentSnapshot, fieldRef);
  }

  /** Navigates to `url`, refusing anything outside the policy's compiled origin list -- a
   * `handoff('off_policy_navigation')` is the caller's job when this throws, per #196 §1.1's "any
   * navigation to an unlisted origin produces a handoff, never a followed redirect" rule. */
  async openTarget(url: string): Promise<void> {
    this.requireAction('openTarget');
    const origin = new URL(url).origin;
    if (!isOriginAllowed(this.policy, origin)) {
      throw new ExecutorPolicyError('openTarget', `origin "${origin}" is not in policy "${this.policy.id}"'s allowlist`);
    }
    await this.send('Page.navigate', { url });
    this.#generation += 1; // navigation invalidates any prior snapshot's field refs
    this.#currentSnapshot = undefined;
    this.#nodeIds = new Map();
  }

  /** Reads the current DOM into a fresh `FormSnapshot`, minting a new set of field/option refs.
   * Bumps the generation counter, so a field map produced against the previous snapshot is
   * structurally stale afterward (Domain B's rule 2). */
  async snapshot(): Promise<FormSnapshot> {
    this.requireAction('snapshot');
    const document = (await this.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpDomNode };
    const extracted = extractSnapshotFields(document.root);
    this.#generation += 1;
    this.#nodeIds = extracted.nodeIds;
    const result: FormSnapshot = { generation: this.#generation, fields: extracted.fields, capturedAt: new Date().toISOString() };
    this.#currentSnapshot = result;
    return result;
  }

  /** Fills a text/textarea/checkbox field. `value` must already have been resolved by Domain B
   * from the attempt's own value table -- this method takes a plain string because by the time it
   * is called, validation has already happened; it is not itself a validation boundary. */
  async fill(fieldRef: string, value: string): Promise<void> {
    this.requireAction('fill');
    const field = this.currentField(fieldRef);
    if (!field) throw new ExecutorPolicyError('fill', `unknown fieldRef ${fieldRef}`);
    if (field.classification) {
      throw new ExecutorPolicyError('fill', `fieldRef ${fieldRef} is a ${field.classification}, never fillable`);
    }
    const backendNodeId = this.nodeIdFor('fill', fieldRef);

    if (field.controlType === 'checkbox') {
      // A checkbox has no allowed-method way to set its checked state directly (`DOM.setAttributeValue`
      // is deliberately not on the allowlist -- it would not fire the page's own change handlers at
      // all). A real click at the element's own box-model center does.
      if (value !== 'true') return; // native default is unchecked; nothing to do
      const box = (await this.send('DOM.getBoxModel', { backendNodeId })) as { model: BoxModel };
      const { x, y } = boxCenter(box.model);
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      return;
    }

    await this.send('DOM.focus', { backendNodeId });
    await this.send('Input.insertText', { text: value });
  }

  /** Selects one option on a `select` field. Best-effort within the CDP allowlist: focuses the
   * control, then drives it with real keyboard events (arrow-down to the option's index, then
   * Enter) -- there is no allowed CDP method that sets a `<select>`'s value directly and still
   * fires the page's own change handlers, and `DOM.setAttributeValue` is deliberately not on the
   * allowlist for exactly that reason (it would not fire them at all). */
  async select(fieldRef: string, optionRef: string): Promise<void> {
    this.requireAction('select');
    const field = this.currentField(fieldRef);
    if (!field) throw new ExecutorPolicyError('select', `unknown fieldRef ${fieldRef}`);
    const options = field.options ?? [];
    const index = options.findIndex((option) => option.optionRef === optionRef);
    if (index === -1) throw new ExecutorPolicyError('select', `optionRef ${optionRef} is not on fieldRef ${fieldRef}`);
    const backendNodeId = this.nodeIdFor('select', fieldRef);

    await this.send('DOM.focus', { backendNodeId });
    for (let i = 0; i < index; i++) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown' });
    }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' });
  }

  /** Attaches a local file (resolved by the caller from a registered artifact id -- never a path
   * the field map itself carries) to a `file` input. */
  async attach(fieldRef: string, localFilePath: string): Promise<void> {
    this.requireAction('attach');
    const field = this.currentField(fieldRef);
    if (!field) throw new ExecutorPolicyError('attach', `unknown fieldRef ${fieldRef}`);
    if (field.controlType !== 'file') throw new ExecutorPolicyError('attach', `fieldRef ${fieldRef} is not a file input`);
    const backendNodeId = this.nodeIdFor('attach', fieldRef);
    await this.send('DOM.setFileInputFiles', { files: [localFilePath], backendNodeId });
  }

  /** Captures a screenshot for the review UI / submission evidence record. */
  async capture(): Promise<string> {
    this.requireAction('capture');
    const result = (await this.send('Page.captureScreenshot', {})) as { data: string };
    return result.data;
  }

  /** A pure state transition -- no CDP call. Surfaces the live view to the user and stops the
   * attempt. The caller (main process) is what actually shows the window. */
  handoff(reason: HandoffReason): HandoffResult {
    return { action: 'handoff', reason };
  }
}
