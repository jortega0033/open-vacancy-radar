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
 */
export const CODEX_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
  modelCatalog: true,
};
