import { CopyButton } from './CopyButton.js';
import { redactDiagnosticsText } from './redact-diagnostics.js';
import type { NavPage } from './nav.js';

/** The pages that run AI work, so they are the ones that show the helper notice. Applications, CV
 * and the rest keep working without the helper and do not carry a red bar about it. The AI Runtime
 * page renders the same notice itself. */
export const AI_HELPER_NOTICE_PAGES: readonly NavPage[] = ['search', 'letters', 'agent-workspace'];

export interface AiHelperNoticeProps {
  /** The raw error from the main process. Shown only inside "Details", with paths, URLs and tokens removed. */
  error?: string;
  retrying: boolean;
  /** True after a "Try again" that ended without the helper coming up. */
  retryFailed: boolean;
  onRetry: () => void;
  className?: string;
}

/**
 * Plain-language replacement for the old "Daemon unavailable: <raw error>" bar. The local helper is
 * the background process that runs Claude Code or Codex; saved data lives elsewhere, so the copy
 * can say it is untouched.
 */
export function AiHelperNotice({ error, retrying, retryFailed, onRetry, className }: AiHelperNoticeProps) {
  const details = redactDiagnosticsText(error ?? 'unknown error');
  const diagnostics = [
    'Open Vacancy Radar AI helper diagnostics',
    `Time: ${new Date().toISOString()}`,
    'Status: unavailable',
    `Details: ${details}`,
  ].join('\n');

  return (
    <div className={['alert alert-error alert-soft items-start text-sm', className].filter(Boolean).join(' ')} role="alert">
      <div className="min-w-0 flex-1">
        <div className="font-semibold">AI features cannot start.</div>
        <p className="mt-0.5">
          The AI part of the app did not start. Your saved data is safe.
        </p>
        {retryFailed && !retrying && (
          <p className="mt-1" data-testid="ai-helper-retry-failed">
            Still not working. Try again or copy the report for a bug report.
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-sm" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Trying again…' : 'Try again'}
          </button>
          <CopyButton text={diagnostics} label="Copy report" className="btn btn-sm btn-outline" />
        </div>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium">Details</summary>
          <pre className="mt-1 max-h-40 overflow-auto text-xs break-words whitespace-pre-wrap">{details}</pre>
        </details>
      </div>
    </div>
  );
}
