import type { ProviderId } from '@agent-dock/shared';

/** Display name for a provider before its `ProviderStatus` (which already carries a `name` field)
 * has been fetched, for example, when rendering a persisted `defaultProvider` on first paint. */
export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};
