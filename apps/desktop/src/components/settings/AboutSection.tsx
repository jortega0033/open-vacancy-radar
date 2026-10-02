import { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsSection } from './controls.js';
import { redactDiagnosticsText } from '../shell/redact-diagnostics.js';
import type { NavPage } from '../shell/nav.js';

const REPOSITORY_URL = 'https://github.com/jortega0033/open-vacancy-radar';
const ISSUE_URL = `${REPOSITORY_URL}/issues/new`;

type CopyState = 'idle' | 'copied' | 'failed';

export interface AboutSectionProps {
  /** The page the shell is showing. Always "settings" while this section is on screen. */
  currentPage?: NavPage;
  /** The page the user opened Settings from, which is the one a bug report is usually about. */
  previousPage?: NavPage;
}

function sanitizeForDiagnostics<T>(value: T): T {
  if (typeof value === 'string') return redactDiagnosticsText(value) as T;
  if (Array.isArray(value)) return value.map((entry) => sanitizeForDiagnostics(entry)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeForDiagnostics(entry)]),
    ) as T;
  }
  return value;
}

async function readEngineStatus() {
  try {
    const status = await window.vacancyRadar.getStatus();
    // Seam for #441: once the engine reports an error category (corrupt, locked, migration failed,
    // unknown), add it here next to the message. Today only the message exists.
    return { ready: status.ready, ...(status.error ? { error: status.error } : {}) };
  } catch (err) {
    return { ready: false, error: err instanceof Error ? err.message : 'could not read engine status' };
  }
}

async function readProviderStates() {
  try {
    const providers = await window.agentDock.listProviders();
    return providers.map((p) => ({
      id: p.id,
      installed: p.installed,
      authenticated: p.authenticated,
      ready: p.installed && p.authenticated === 'authenticated',
    }));
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'could not read provider status' };
  }
}

/**
 * Static-but-real "About" information: version comes from `app.getVersion()` (never a
 * hand-maintained string that could drift), everything else is a fact about this specific build
 * rather than decoration copied from the prototype (which listed a placeholder repository URL and
 * an MIT license: this app is actually Apache-2.0, and the repository is real).
 *
 * The diagnostics report is built here, shown in a read-only preview, and that exact text is what
 * "Copy diagnostics" copies and what "Open GitHub issue" puts in the issue body.
 */
export function AboutSection({ currentPage, previousPage }: AboutSectionProps = {}) {
  const [version, setVersion] = useState<string>();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [preview, setPreview] = useState<string>();
  const versionRef = useRef<string | undefined>(undefined);
  versionRef.current = version;

  useEffect(() => {
    let cancelled = false;
    // Reading `window.system.getAppVersion` is deferred a microtask past mount, not called
    // synchronously in the effect body: under the test harness, a just-unmounted sibling
    // instance's bridge reference can still be mid-teardown at the exact moment this effect runs,
    // which surfaces as `getAppVersion()` momentarily returning `undefined` instead of a promise.
    void Promise.resolve()
      .then(() => window.system.getAppVersion())
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {
        // the row just shows nothing after "v" rather than blocking the rest of the page
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const collectDiagnostics = useCallback(async (): Promise<string> => {
    // Everything is read fresh each time the report is built, never cached from an earlier click.
    // A failed read becomes an "unavailable" entry instead of aborting the report: a user whose
    // helper or engine is broken needs this report most.
    const [daemonStatus, engine, providers] = await Promise.all([
      Promise.resolve()
        .then(() => window.agentDock.getDaemonStatus())
        .catch((err: unknown) => ({
          state: 'unavailable' as const,
          error: err instanceof Error ? err.message : 'could not read background service status',
        })),
      readEngineStatus(),
      readProviderStates(),
    ]);
    return JSON.stringify(
      sanitizeForDiagnostics({
        application: 'Open Vacancy Radar',
        version: versionRef.current ?? 'unknown',
        generatedAt: new Date().toISOString(),
        platform: navigator.userAgent,
        page: currentPage ?? 'unknown',
        previousPage: previousPage ?? 'none',
        daemonStatus,
        vacancyEngine: engine,
        providers,
      }),
      null,
      2,
    );
  }, [currentPage, previousPage]);

  const refreshPreview = useCallback(async () => {
    setPreview(await collectDiagnostics());
  }, [collectDiagnostics]);

  // Built when the section shows (and once the version arrives) and again on "Refresh preview", so
  // the text on screen is always what Copy and Open GitHub issue use. Neither builds its own copy.
  useEffect(() => {
    let cancelled = false;
    void collectDiagnostics().then((text) => {
      if (!cancelled) setPreview(text);
    });
    return () => {
      cancelled = true;
    };
  }, [collectDiagnostics, version]);

  const copyDiagnostics = async () => {
    if (preview === undefined) return;
    try {
      await navigator.clipboard.writeText(preview);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    setTimeout(() => setCopyState('idle'), 2000);
  };

  const diagnosticIssueUrl =
    preview === undefined
      ? undefined
      : `${ISSUE_URL}?${new URLSearchParams({
          title: '[Bug]: Installed app diagnostic report',
          body: '## What happened?\n\n\n## Diagnostic report\n\n```json\n' + preview + '\n```\n',
        }).toString()}`;

  return (
    <SettingsSection title="About">
      <dl className="grid grid-cols-[160px_1fr] gap-0">
        <dt className="ovr-row border-b border-base-300 text-sm text-base-content/60">Application</dt>
        <dd className="ovr-row border-b border-base-300 text-sm font-medium">
          Open Vacancy Radar{version ? ` v${version}` : ''}
        </dd>
        <dt className="ovr-row border-b border-base-300 text-sm text-base-content/60">License</dt>
        <dd className="ovr-row border-b border-base-300 text-sm font-medium">Open source · Apache-2.0</dd>
        <dt className="ovr-row border-b border-base-300 text-sm text-base-content/60">AI runtime</dt>
        <dd className="ovr-row border-b border-base-300 text-sm font-medium">AgentDock (local)</dd>
        <dt className="ovr-row border-b border-base-300 text-sm text-base-content/60">Repository</dt>
        <dd className="ovr-row border-b border-base-300 text-sm font-medium">
          <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" className="link">
            {REPOSITORY_URL.replace('https://', '')}
          </a>
        </dd>
      </dl>
      <details className="ovr-row" open>
        <summary className="cursor-pointer text-sm font-medium">Diagnostics preview</summary>
        <p className="mt-2 text-sm text-base-content/60">
          This is the exact text that Copy diagnostics copies and Open GitHub issue puts in the draft. Paths, tokens
          and web addresses are removed. Nothing is sent until you submit the issue on GitHub.
        </p>
        <textarea
          aria-label="Diagnostics text"
          readOnly
          rows={12}
          className="textarea textarea-bordered mt-2 w-full font-mono text-xs"
          value={preview ?? 'Collecting diagnostics'}
        />
      </details>
      <div className="ovr-row flex items-center gap-2">
        <button
          type="button"
          className="btn btn-sm btn-outline"
          disabled={preview === undefined}
          onClick={() => void copyDiagnostics()}
        >
          Copy diagnostics
        </button>
        <button type="button" className="btn btn-sm btn-outline" onClick={() => void refreshPreview()}>
          Refresh preview
        </button>
        {diagnosticIssueUrl ? (
          <a className="btn btn-sm btn-outline" href={diagnosticIssueUrl} target="_blank" rel="noopener noreferrer">
            Open GitHub issue
          </a>
        ) : (
          <span className="btn btn-sm btn-outline btn-disabled" aria-disabled="true">
            Open GitHub issue
          </span>
        )}
        {copyState === 'copied' && (
          <span className="text-sm" role="status">
            Copied
          </span>
        )}
        {copyState === 'failed' && (
          <span className="text-sm text-error" role="alert">
            Could not copy to the clipboard
          </span>
        )}
      </div>
    </SettingsSection>
  );
}
