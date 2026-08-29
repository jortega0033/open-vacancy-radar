import type { ProviderCapabilities } from '@agent-dock/shared';

/**
 * What this adapter actually implements for Claude Code — see the parser and adapter.ts for the
 * behavior each of these reflects, not an assumption about what the model can do.
 *
 * - resume: `--resume <providerSessionId>` (adapter.ts)
 * - cancellation: shared runProviderSession() process-tree kill (providers/common/run-session.ts)
 * - tools: `tool_use`/`tool_result` content blocks normalize to tool.started/tool.completed (parser.ts)
 * - usage: `message.usage` and the final `result` event's usage normalize to `usage` events (parser.ts)
 * - thinking: `thinking` content blocks normalize to thinking.delta (parser.ts) — only present when
 *   the CLI itself surfaces extended-thinking output; absent otherwise, which is fine, since this
 *   capability means "the adapter passes it through when the CLI provides it", not "always present"
 */
export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
};

/**
 * Model aliases the installed `claude` CLI accepts via `--model` as of this adapter's writing.
 * This is a display/selection list only — `buildClaudeArgs` passes whatever value it's given
 * straight through unvalidated, so a value the CLI no longer recognizes fails as a normal
 * session.failed event instead of being silently rejected here and going stale.
 */
export const CLAUDE_MODELS = ['sonnet', 'opus', 'fable', 'haiku'] as const;
