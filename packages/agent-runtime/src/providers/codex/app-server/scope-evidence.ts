import { createHash } from 'node:crypto';
import { ProviderTransportStartupError } from '../../common/fallback-gate.js';
import { CodexAppServerProtocolError, safeDisplay } from './errors.js';

type JsonObject = Record<string, unknown>;

export interface CodexAppServerModel {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface CodexAccountScope {
  authSource: 'chatgpt' | 'api_key';
  fingerprint?: string;
}

/**
 * The account+model binding this repo's app-server transport needs before it will ever send a
 * turn/start: which category of account it probed (`authSource`, cross-checked in `scope-probe.ts`
 * against what `detect()` already reported -- catches a coarse category switch like chatgpt to
 * api_key, not a same-category account swap the CLI's own `authSource` signal has no way to
 * distinguish), and which model was actually resolved to drive the turn. A finer-grained
 * per-account check, if one is ever needed, belongs in whatever later stage actually consumes
 * `accountFingerprint` at resume time -- this stage has no daemon wiring yet. Deliberately not
 * upstream's `ProviderContinuationEvidence` type (this repo has no `types.ts` counterpart for it
 * yet) -- a later stage that wires this into `launch-scope.ts`/`fallback-gate.ts` designs that
 * seam then, against whatever those files actually need at that point.
 */
export interface CodexContinuationEvidence {
  accountFingerprint: string;
  selectedModel: string;
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodexAppServerProtocolError('frame_invalid', `Invalid ${label}`);
  }
  return value as JsonObject;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 64 * 1024) {
    throw new CodexAppServerProtocolError('frame_invalid', `Invalid ${label}`);
  }
  return value;
}

function hasUnsafeDisplayCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || /\p{Cf}/u.test(character);
  });
}

/**
 * Parses `account/read`'s response. Ported from upstream's `scope-evidence.ts`, unchanged in
 * substance: the account's fingerprint is a SHA-256 of the normalized email, never the raw
 * address, and `api_key` accounts get no fingerprint at all (there is nothing stable and
 * non-identifying to hash) -- matching `hasValidAppServerCompatibility`'s sibling rule that
 * API-key auth cannot provide a bindable continuation identity.
 *
 * The two "the account isn't what we expected" branches throw `ProviderTransportStartupError`
 * (reused from `providers/common/fallback-gate.ts`, never a parallel error type) with
 * `deliveryState: 'not_delivered'`: the scope probe never sends `thread/start`/`turn/start` (see
 * `scope-probe.ts`), so a failure here can never mean the provider acted on the user's prompt --
 * exactly the fact a fallback decision needs to know it's safe to retry on another transport.
 */
export function parseCodexAccountScope(result: unknown): CodexAccountScope {
  const response = asObject(result, 'account/read response');
  if (typeof response.requiresOpenaiAuth !== 'boolean') {
    throw new CodexAppServerProtocolError('frame_invalid', 'Invalid account/read response');
  }
  if (response.account === null || response.account === undefined) {
    throw new ProviderTransportStartupError('codex_auth_scope_changed', 'not_delivered', 'Codex app-server has no authenticated account');
  }
  const account = asObject(response.account, 'account');
  if (account.type === 'apiKey') return { authSource: 'api_key' };
  if (account.type !== 'chatgpt' || (account.email !== null && typeof account.email !== 'string')) {
    throw new ProviderTransportStartupError('codex_auth_scope_changed', 'not_delivered', 'Codex app-server authentication source is unsupported');
  }
  // `account.email === undefined` already threw above (the preceding check's `typeof ... !==
  // 'string'` catches it, since `undefined !== null`): only `null` reaches here, matching the
  // schema's `email: string | null`, always present, never missing entirely.
  if (account.email === null) return { authSource: 'chatgpt' };
  const normalized = account.email.trim().normalize('NFKC').toLowerCase();
  if (normalized.length === 0 || Buffer.byteLength(normalized) > 512 || hasUnsafeDisplayCharacters(normalized)) {
    return { authSource: 'chatgpt' };
  }
  return { authSource: 'chatgpt', fingerprint: createHash('sha256').update(normalized, 'utf8').digest('hex') };
}

/** Parses `model/list`'s response. Ported from upstream, unchanged. */
export function parseCodexModelCatalog(result: unknown): readonly CodexAppServerModel[] {
  const response = asObject(result, 'model/list response');
  if (!Array.isArray(response.data) || response.data.length > 1_024) {
    throw new CodexAppServerProtocolError('frame_invalid', 'Invalid Codex model catalog');
  }
  const models = response.data.map((rawModel) => {
    const model = asObject(rawModel, 'model');
    const id = asString(model.id ?? model.model, 'model id');
    if (Buffer.byteLength(id) > 256 || hasUnsafeDisplayCharacters(id)) {
      throw new CodexAppServerProtocolError('frame_invalid', 'Invalid model id');
    }
    return Object.freeze({ id, displayName: safeDisplay(model.displayName, 256, 'Codex model'), isDefault: model.isDefault === true });
  });
  return Object.freeze(models);
}

/**
 * Picks the model the transport actually drives a turn with. A `pinnedModel` (from
 * `POST /v2/sessions`'s model-select capability, once a later stage wires transport selection to
 * it) must exist in the live catalog; absent a pin, exactly one catalog entry must be marked
 * default -- an ambiguous or missing default is a startup failure (`codex_model_unverified`), not
 * a guess, matching the "no fallback occurs after accepted work" and "unsupported/unverified
 * versions do not select rich transports" acceptance criteria in ADI-08 (#126).
 */
export function resolveCodexSelectedModel(catalog: readonly CodexAppServerModel[], pinnedModel?: string): string {
  if (pinnedModel) {
    if (!catalog.some(({ id }) => id === pinnedModel)) {
      throw new ProviderTransportStartupError('codex_model_unavailable', 'not_delivered', 'Pinned Codex model is unavailable');
    }
    return pinnedModel;
  }
  const defaults = catalog.filter(({ isDefault }) => isDefault);
  if (defaults.length !== 1) {
    throw new ProviderTransportStartupError('codex_model_unverified', 'not_delivered', 'Codex default model could not be determined exactly');
  }
  return defaults[0]!.id;
}

export function toCodexContinuationEvidence(account: CodexAccountScope, selectedModel: string): CodexContinuationEvidence | undefined {
  return account.fingerprint ? Object.freeze({ accountFingerprint: account.fingerprint, selectedModel }) : undefined;
}
