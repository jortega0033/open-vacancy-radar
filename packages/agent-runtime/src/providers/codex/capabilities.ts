import type { ProviderCapabilities } from '@agent-dock/shared';

/**
 * What this adapter actually implements for Codex. See the parser and adapter.ts for the
 * behavior each of these reflects.
 *
 * - resume: `codex exec resume <providerSessionId> <prompt>` (adapter.ts)
 * - cancellation: shared runProviderSession() process-tree kill (providers/common/run-session.ts)
 * - tools: `command_execution`/`file_change`/`mcp_tool_call` items normalize to
 *   tool.started/tool.completed (parser.ts)
 * - usage: `turn.completed.usage` normalizes to a `usage` event (parser.ts)
 * - thinking: `reasoning` items normalize to thinking.delta (parser.ts): only present when Codex's
 *   own reasoning-effort/model configuration surfaces them; absent otherwise
 * - modelCatalog (ADI-22a): `CodexProvider.fetchModelCatalog()` (adapter.ts) wraps the same live
 *   `model/list` RPC and `parseCodexModelCatalog` parser `app-server/transport.ts` already uses
 *   before every real session -- see `app-server/model-catalog.ts`.
 *
 * `hardenedNoNetwork` (#284) is **absent, permanently**, and that absence is a statement rather
 * than an omission: `buildCodexArgs` never reads `opts.hardened`, so a Codex session asked for the
 * `'no-network'` profile would get exactly the same argv as one that asked for nothing. Declaring
 * the flag here would make the stage router believe a restriction that no code applies. The day
 * Codex's CLI grows a real equivalent, this key is added in the same change as the argv that
 * implements it, never before.
 *
 * attachments (port of agentdock#152/#153): `StartSessionOptions.attachments` delivered as
 * `-i/--image <path>` argv, one flag per attachment (build-args.ts) -- the prompt itself keeps
 * going over stdin unchanged, since this flag takes a real local file path directly, not inline
 * content. Only honored on the `'exec'` transport (this repo's shipped default); `adapter.ts`
 * fails closed with a clear error if attachments are requested on the opt-in `'app-server'`/
 * `'auto'` transport, which has no wiring for them.
 */
export const CODEX_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
  modelCatalog: true,
  attachments: true,
};

/**
 * MIME types this adapter's attachment delivery (`-i/--image <path>`) accepts.
 *
 * Verification status (codex-cli 0.147.0, the version this repo's compatibility manifest pins,
 * `codex exec -i/--image <path>`):
 * - `application/pdf` was directly tested end-to-end against the real CLI -- a small real PDF was
 *   attached via this flag, and Codex correctly read its content back, despite the flag's name.
 * - `image/png` and `image/jpeg` are NOT independently tested here; they're listed because the
 *   flag's own `--help` text ("Optional image(s) to attach to the initial prompt") documents its
 *   purpose as image attachment. Re-verify against the pinned CLI version before relying on them
 *   for anything security- or correctness-sensitive.
 */
export const CODEX_ATTACHMENT_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
