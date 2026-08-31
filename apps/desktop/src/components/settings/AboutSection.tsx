import { useEffect, useState } from 'react';
import { SettingsSection } from './controls.js';

const REPOSITORY_URL = 'https://github.com/jortega0033/open-vacancy-radar';

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Static-but-real "About" information: version comes from `app.getVersion()` (never a
 * hand-maintained string that could drift), everything else is a fact about this specific build
 * rather than decoration copied from the prototype (which listed a placeholder repository URL and
 * an MIT license: this app is actually Apache-2.0, and the repository is real).
 */
export function AboutSection() {
  const [version, setVersion] = useState<string>();
  const [copyState, setCopyState] = useState<CopyState>('idle');

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

  const copyDiagnostics = async () => {
    // Fetched fresh here rather than threaded down as a prop: this is the one place in the app
    // that needs the daemon's status purely to report it, not to react to it, and a user hitting
    // "daemon failed to start" needs exactly this in what they paste into a bug report -- the
    // AI Runtime page's own banner shows the same text, but isn't copyable as structured text.
    const daemonStatus = await window.agentDock.getDaemonStatus().catch((err: unknown) => ({
      state: 'unavailable' as const,
      error: err instanceof Error ? err.message : 'could not read daemon status',
    }));
    const diagnostics = {
      application: 'Open Vacancy Radar',
      version: version ?? 'unknown',
      platform: navigator.userAgent,
      daemonStatus,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    setTimeout(() => setCopyState('idle'), 2000);
  };

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
      <div className="ovr-row flex items-center gap-2">
        <button type="button" className="btn btn-sm btn-outline" onClick={() => void copyDiagnostics()}>
          Copy diagnostics
        </button>
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
