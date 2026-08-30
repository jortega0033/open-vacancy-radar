import { useEffect, useState } from 'react';
import { SettingsSection } from './controls.js';

const REPOSITORY_URL = 'https://github.com/jortega0033/open-vacancy-radar';

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * About information for this build. The version comes from `app.getVersion()` instead of a
 * hand-maintained string. The license and repository values replace the prototype placeholders
 * with this project's Apache-2.0 license and repository URL.
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
    const diagnostics = {
      application: 'Open Vacancy Radar',
      version: version ?? 'unknown',
      platform: navigator.userAgent,
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
            Could not copy to the clipboard.
          </span>
        )}
      </div>
    </SettingsSection>
  );
}
