import { useEffect } from 'react';
import type { ProviderErrorInfo } from '../../provider-error.js';
import { activeProviderLimit, recordProviderLimit } from '../../provider-limits.js';
import { WarningBanner } from '../shell/index.js';
import { UNTIMED_LIMIT_MAX_AGE_MS } from './apply-workspace-state.js';

/**
 * Small pieces shared by the Review & apply workspace (#657) and the policy-backed review dialog,
 * so a blocked preparation reads the same wherever the person meets it.
 */

/** Raw detail text behind a collapsed disclosure, for the few people who need it. */
export function TechnicalDetails({ text, label }: { text: string; label: string }) {
  if (!text) return null;
  return (
    <details className="text-xs text-base-content/70">
      <summary className="cursor-pointer font-medium">{label}</summary>
      <p className="mt-1 break-words">{text}</p>
    </details>
  );
}

/**
 * A usage limit behind a blocked preparation (#546). Application preparation always runs on Claude
 * (`applicationPipelineDeps` in `main.ts`), so a limit there is Claude's whatever tool the person
 * picked.
 */
export function PipelineLimitNotice({ info }: { info: ProviderErrorInfo }) {
  return (
    <WarningBanner>
      Claude has reached its usage limit{info.resetLabel ? ` until ${info.resetLabel}` : ''}. Preparing an
      application needs Claude, so try again once the limit resets.
    </WarningBanner>
  );
}

/**
 * So the AI runtime page shows Claude's limit too, not only the review surface. Keyed on plain
 * values, since `limit` is rebuilt every render. An old attempt never overrides a newer limit, and a
 * limit that has already passed is not recorded at all.
 */
export function useRecordPipelineLimit(limit: ProviderErrorInfo | null, updatedAt: string): void {
  const limited = limit !== null;
  const resetLabel = limit?.resetLabel;
  const resetAt = limit?.resetAt;
  useEffect(() => {
    if (!limited) return;
    const now = Date.now();
    const parsed = Date.parse(updatedAt);
    const reachedAt = Number.isNaN(parsed) ? now : parsed;
    if (resetAt !== undefined ? resetAt <= now : now - reachedAt > UNTIMED_LIMIT_MAX_AGE_MS) return;
    const existing = activeProviderLimit('claude', now);
    if (existing && existing.reachedAt >= reachedAt) return;
    recordProviderLimit({
      provider: 'claude',
      reachedAt,
      ...(resetLabel ? { resetLabel } : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
    });
  }, [limited, resetLabel, resetAt, updatedAt]);
}
