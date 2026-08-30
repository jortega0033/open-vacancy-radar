import type { ProviderId } from '@agent-dock/shared';

/** Display name for a provider before its `ProviderStatus` (which already carries a `name` field)
 * has been fetched — e.g. rendering a persisted `defaultProvider` setting on first paint. */
export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};
