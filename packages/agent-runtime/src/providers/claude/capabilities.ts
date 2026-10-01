import type { ProviderCapabilities } from '@agent-dock/shared';

/**
 * What this adapter actually implements for Claude Code. See the parser and adapter.ts for the
 * behavior each of these reflects, not an assumption about what the model can do.
 *
 * - resume: `--resume <providerSessionId>` (adapter.ts)
 * - cancellation: shared runProviderSession() process-tree kill (providers/common/run-session.ts)
 * - tools: `tool_use`/`tool_result` content blocks normalize to tool.started/tool.completed (parser.ts)
 * - usage: `message.usage` and the final `result` event's usage normalize to `usage` events (parser.ts)
 * - thinking: `thinking` content blocks normalize to thinking.delta (parser.ts): only present when
 *   the CLI itself surfaces extended-thinking output; absent otherwise, which is fine, since this
 *   capability means "the adapter passes it through when the CLI provides it", not "always present"
 * - hardenedNoNetwork (#284): `buildClaudeArgs` reads `opts.hardened === 'no-network'` and appends
 *   `CLAUDE_HARDENING_ARGS_NO_NETWORK` (build-args.ts) -- this adapter is the only one in the repo
 *   that reads that field at all, which is exactly the fact this flag makes machine-readable
 * - attachments (port of agentdock#152/#153): `StartSessionOptions.attachments` delivered as an
 *   Anthropic Messages-API-shaped `document`/`image` content block via `claude -p --input-format
 *   stream-json` (build-args.ts, stdin-payload.ts). Verified to work combined with every
 *   `CLAUDE_HARDENING_ARGS` flag this adapter always applies (every session in this repo is
 *   hardened, see `session-manager.ts`'s `create()`) -- not merely assumed compatible. Absent when
 *   there are no attachments, which keeps `--input-format text` and the raw-prompt stdin write
 *   exactly as before this capability existed.
 */
export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
  hardenedNoNetwork: true,
  attachments: true,
};

/**
 * MIME types this adapter's attachment delivery (stdin-payload.ts) accepts, each mapped to the
 * Anthropic Messages-API content-block `type` it's sent as. This is a capability list, not a
 * validation function -- see `schemas.ts`'s route-level validation for where it's actually
 * enforced.
 *
 * Verification status (claude Code CLI 2.1.228, the version `CLAUDE_LEGACY_COMPATIBILITY` pins,
 * `--input-format stream-json`, combined with the full `CLAUDE_HARDENING_ARGS` suffix this adapter
 * always applies):
 * - `application/pdf` (as a `document` block) and `image/png` (as an `image` block) were directly
 *   tested end-to-end against the real CLI -- a small real PDF and PNG were each attached, and the
 *   model correctly read their content back, with the hardening flags applied.
 * - `image/jpeg`, `image/gif`, and `image/webp` are NOT independently tested here; they're listed
 *   because Anthropic's Messages API documents them as accepted `image` content-block MIME types,
 *   and Claude Code's stream-json input format uses the same content-block shape. Re-verify against
 *   the pinned CLI version before relying on them for anything security- or correctness-sensitive.
 */
export const CLAUDE_ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

/**
 * Model aliases the installed `claude` CLI accepts via `--model` as of this adapter's writing.
 * This is a display/selection list only: `buildClaudeArgs` passes whatever value it's given
 * straight through unvalidated, so a value the CLI no longer recognizes fails as a normal
 * session.failed event instead of being silently rejected here and going stale.
 */
export const CLAUDE_MODELS = ['sonnet', 'opus', 'fable', 'haiku'] as const;
