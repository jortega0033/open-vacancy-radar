import { assertAllowedCdpMethod } from './cdp-allowlist.js';
import { extractSnapshotFields, type CdpDomNode, type ExtractedSnapshot, type FieldNodeMap } from './dom-extract.js';
import { findSnapshotField, type FormSnapshot } from './form-snapshot.js';
import { isActionAllowed, isNavigationAllowed, type ApplicationTargetPolicy, type ExecutorAction } from './target-policy.js';

const EMPTY_SNAPSHOT_RETRY_LIMIT = 20;
const EMPTY_SNAPSHOT_RETRY_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  /** Navigates to `url`, refusing anything outside the policy's compiled allowlist -- a
   * `handoff('off_policy_navigation')` is the caller's job when this throws, per #196 §1.1's "any
   * navigation to an unlisted origin produces a handoff, never a followed redirect" rule. This is
   * the *pre-navigate* half of that rule; the *never a followed redirect* half is enforced at the
   * Electron layer (`apps/desktop/electron/application-view.ts`'s `will-navigate`/`will-redirect`
   * handlers), since `CdpTransport` here is request/response only and cannot observe a navigation
   * CDP itself didn't initiate. */
  async openTarget(url: string): Promise<void> {
    this.requireAction('openTarget');
    if (!isNavigationAllowed(this.policy, url)) {
      throw new ExecutorPolicyError('openTarget', `url "${url}" is not allowed by policy "${this.policy.id}"`);
    }
    await this.send('Page.navigate', { url });
    this.#generation += 1; // navigation invalidates any prior snapshot's field refs
    this.#currentSnapshot = undefined;
    this.#nodeIds = new Map();
  }

  private async readDom(): Promise<ExtractedSnapshot> {
    const document = (await this.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpDomNode };
    return extractSnapshotFields(document.root);
  }

  /** Reads the current DOM into a fresh `FormSnapshot`, minting a new set of field/option refs.
   * Bumps the generation counter, so a field map produced against the previous snapshot is
   * structurally stale afterward (Domain B's rule 2).
   *
   * Retries a genuinely empty read a few times before minting a zero-field snapshot: `Page.navigate`
   * resolves once navigation is dispatched, not once the document is parsed, so a `snapshot()` called
   * immediately after `openTarget()` can race ahead of the real page and see an empty/interim
   * document -- confirmed against a real Electron `WebContentsView` (`e2e/application-executor.spec.ts`),
   * where every fake-transport unit test's fixed, always-non-empty tree never triggers this path. Only
   * a read that finds zero fields retries; a real form that legitimately has none is indistinguishable
   * from that race and simply pays the (bounded) retry cost once. */
  async snapshot(): Promise<FormSnapshot> {
    this.requireAction('snapshot');
    let extracted = await this.readDom();
    for (let attempt = 0; extracted.fields.length === 0 && attempt < EMPTY_SNAPSHOT_RETRY_LIMIT; attempt++) {
      await sleep(EMPTY_SNAPSHOT_RETRY_DELAY_MS);
      extracted = await this.readDom();
    }
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
      // all). A real click at the element's own box-model center does, toggling whatever the box's
      // current state is -- so a click is only correct when the desired state actually differs from
      // it. Comparing against `field.checked` (rather than assuming every checkbox starts unchecked,
      // a real gap found during #201's review) is what makes this work in both directions: a
      // pre-checked box can now be unchecked, and an already-correct box is left alone rather than
      // toggled by an unnecessary click.
      const desiredChecked = value === 'true';
      if (desiredChecked === (field.checked ?? false)) return; // already in the desired state
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
   * allowlist for exactly that reason (it would not fire them at all).
   *
   * Normalizes to index 0 with a burst of `ArrowUp` presses before counting `ArrowDown` presses to
   * the target -- confirmed as a real gap during #201's review: counting `ArrowDown` alone assumes
   * the control's real starting selection is always index 0, which is false for a field with a
   * non-first `<option selected>`, a browser-remembered value, or a second `select()` call on the
   * same field. `ArrowUp` on an already-first option is a no-op in every real `<select>`, so
   * sending one per option is a safe, allowlist-only way to guarantee a known starting point
   * without any CDP method that reads the control's current value. */
  async select(fieldRef: string, optionRef: string): Promise<void> {
    this.requireAction('select');
    const field = this.currentField(fieldRef);
    if (!field) throw new ExecutorPolicyError('select', `unknown fieldRef ${fieldRef}`);
    const options = field.options ?? [];
    const index = options.findIndex((option) => option.optionRef === optionRef);
    if (index === -1) throw new ExecutorPolicyError('select', `optionRef ${optionRef} is not on fieldRef ${fieldRef}`);
    const backendNodeId = this.nodeIdFor('select', fieldRef);

    await this.send('DOM.focus', { backendNodeId });
    for (let i = 0; i < options.length; i++) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp' });
    }
    for (let i = 0; i < index; i++) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown' });
    }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' });
  }

  /**
   * Attaches a local file (resolved by the caller from a registered artifact id -- never a path
   * the field map itself carries) to a `file` input.
   *
   * `mimeType`/`byteSize` come from the caller's own trusted artifact record (#198), never derived
   * here from the file itself (a file extension is not a security boundary) -- this package does no
   * filesystem I/O by design. Checked against `policy.uploadConstraints` before the CDP call: a real
   * gap found during #201's review had this field declared on `ApplicationTargetPolicy` but never
   * actually enforced anywhere, so an oversized or wrong-type artifact would have reached
   * `DOM.setFileInputFiles` unchecked once artifact resolution (#198) was wired up.
   */
  async attach(fieldRef: string, file: { localFilePath: string; mimeType: string; byteSize: number }): Promise<void> {
    this.requireAction('attach');
    const field = this.currentField(fieldRef);
    if (!field) throw new ExecutorPolicyError('attach', `unknown fieldRef ${fieldRef}`);
    if (field.controlType !== 'file') throw new ExecutorPolicyError('attach', `fieldRef ${fieldRef} is not a file input`);
    const { maxBytes, mimeTypes } = this.policy.uploadConstraints;
    if (file.byteSize > maxBytes) {
      throw new ExecutorPolicyError('attach', `file (${file.byteSize} bytes) exceeds policy "${this.policy.id}"'s ${maxBytes}-byte limit`);
    }
    if (!mimeTypes.includes(file.mimeType)) {
      throw new ExecutorPolicyError('attach', `mime type "${file.mimeType}" is not allowed by policy "${this.policy.id}"`);
    }
    const backendNodeId = this.nodeIdFor('attach', fieldRef);
    await this.send('DOM.setFileInputFiles', { files: [file.localFilePath], backendNodeId });
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
