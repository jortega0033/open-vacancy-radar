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
 *
 * A reset time is placed relative to `generatedAt`, when the report was made, not to now: a saved
 * report opened days later must not turn an old "resets 3pm" into the next 3pm.
 */
export function describeAiWebSearchFailure(
  sources: readonly DiscoverySource[],
  generatedAt?: string,
  now: number = Date.now(),
): AiWebSearchNotice | null {
  const source = sources.find((candidate) => candidate.provider === 'ai_web_search');
  if (!source || (source.status !== 'error' && source.status !== 'blocked')) return null;
  const raw = source.error ?? '';
  const reason = source.completenessReason ?? '';
  const madeAt = generatedAt === undefined ? NaN : Date.parse(generatedAt);
  const info = classifyProviderError(raw, Number.isNaN(madeAt) ? new Date(now) : new Date(madeAt));

  if (info.kind === 'usage_limit') {
    // Once the reset has passed, the notice describes what happened, not a limit still in force.
    if (info.resetAt !== undefined && info.resetAt <= now) {
      return { message: 'AI web search did not run in this scan: Claude was at its usage limit.', limit: info };
    }
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
    return { message: 'AI web search needs a role or skill under What you are looking for.' };
  }
  if (/failed to start|daemon was not ready|availability could not be determined/i.test(reason)) {
    return { message: 'AI web search could not start, so these results are from job sites only.' };
  }
  return { message: 'AI web search did not finish, so these results are from job sites only.' };
}
