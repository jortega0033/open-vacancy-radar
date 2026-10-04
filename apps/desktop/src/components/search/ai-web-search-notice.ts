import type { GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import { classifyProviderError, type ProviderErrorInfo } from '../../provider-error.js';

type DiscoverySource = GlobalRemoteReport['discoverySources'][number];

export interface AiWebSearchNotice {
  /** One plain sentence for the person. The raw reason stays in Copy diagnostics. */
  message: string;
  /** Set when the cause was Claude's usage limit, so the caller can record it. */
  limit?: ProviderErrorInfo;
}

/**
 * What to say when the optional AI web search step of a scan did not work (#559). The step always
 * runs on Claude (`vacancy-web-discovery.ts`), so every message names Claude, not the default tool.
 * Returns null when the scan did not include the step or the step worked.
 */
export function describeAiWebSearchFailure(sources: readonly DiscoverySource[]): AiWebSearchNotice | null {
  const source = sources.find((candidate) => candidate.provider === 'ai_web_search');
  if (!source || (source.status !== 'error' && source.status !== 'blocked')) return null;
  const raw = source.error ?? '';
  const reason = source.completenessReason ?? '';
  const info = classifyProviderError(raw);

  if (info.kind === 'usage_limit') {
    return {
      message: `AI web search did not run: Claude has reached its usage limit${info.resetLabel ? ` until ${info.resetLabel}` : ''}.`,
      limit: info,
    };
  }
  if (info.kind === 'not_signed_in' || /not signed in/i.test(reason)) {
    return { message: 'AI web search did not run: Claude Code is not signed in.' };
  }
  if (/not installed/i.test(reason)) {
    return { message: 'AI web search needs Claude Code, which is not installed.' };
  }
  if (/no candidate search profile/i.test(reason)) {
    return { message: 'AI web search needs a role or skill in your search profile.' };
  }
  if (/failed to start|daemon was not ready|availability could not be determined/i.test(reason)) {
    return { message: 'AI web search could not start, so these results are from job sites only.' };
  }
  return { message: 'AI web search did not finish, so these results are from job sites only.' };
}
