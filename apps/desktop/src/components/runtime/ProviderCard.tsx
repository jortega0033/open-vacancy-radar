import { Check } from '@phosphor-icons/react';
import type { ProviderStatus } from '@agent-dock/shared';
import { CopyButton } from '../shell/index.js';
import { detectPlatform, providerGuidance } from './provider-guidance.js';

function authLabel(status: ProviderStatus): string {
  if (status.authenticated === 'authenticated') return 'Signed in';
  if (status.authenticated === 'unauthenticated') return 'Not signed in';
  return 'Unknown';
}

function readyLabel(status: ProviderStatus): string {
  if (!status.installed) return 'Not installed';
  if (status.authenticated === 'authenticated') return 'Ready';
  if (status.authenticated === 'unauthenticated') return 'Not signed in';
  return 'Unknown';
}

/** Green only for the one state that actually means "this CLI can run a session right now". */
function readyDotClass(status: ProviderStatus): string {
  return status.installed && status.authenticated === 'authenticated' ? 'bg-success' : 'bg-base-content/30';
}

/** Where a "Check again" on this card stands. `blocked` means the re-read still found the CLI unusable. */
export type ProviderCheckState = 'checking' | 'ready' | 'blocked';

export interface ProviderCardProps {
  status: ProviderStatus;
  /** Whether this is the provider AI features currently run through. */
  isDefault: boolean;
  onUseAsDefault: () => void;
  /** True while a "use as default" save for this card is in flight. */
  saving: boolean;
  /** Whether to offer the "Use this one" button. The page hides it when there is nothing to choose between. */
  showPicker?: boolean;
  /** Re-reads provider status. Without it the card shows no "Check again" button. */
  onCheckAgain?: () => void;
  checkState?: ProviderCheckState;
}

/**
 * One CLI's status, matching the prototype's provider card (`export-src.html` AI Runtime screen):
 * a ready dot, a sign-in line, the version behind "Details", and a button that
 * sets this provider as the one AI features run through when there is a choice to make.
 * Every field here is real data from `window.agentDock.listProviders()`: nothing is invented for
 * the sake of matching the mockup's layout.
 */
export function ProviderCard({ status, isDefault, onUseAsDefault, saving, showPicker = true, onCheckAgain, checkState }: ProviderCardProps) {
  const needsInstall = !status.installed;
  const needsSignIn = status.installed && status.authenticated !== 'authenticated';
  const guidance = providerGuidance(status.id, detectPlatform(navigator.userAgent));
  const checkAgain = onCheckAgain && (
    <button type="button" className="btn btn-xs btn-outline" onClick={onCheckAgain} disabled={checkState === 'checking'}>
      Check again
    </button>
  );

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <div className="text-sm font-bold">{status.name}</div>
            {/* Independent of whether the CLI is actually usable: the persisted default can point
                at a provider that isn't installed (e.g. a fresh machine with no CLI yet), and that
                is exactly the case this badge must still surface rather than hide. */}
            {isDefault && <span className="badge badge-outline badge-sm">Default</span>}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-base-content/70">
            <span className={`size-1.5 rounded-full ${readyDotClass(status)}`} aria-hidden="true" />
            {readyLabel(status)}
          </div>
        </div>

        <dl className="grid grid-cols-[110px_1fr] gap-x-2.5 gap-y-1.5 text-xs">
          <dt className="text-base-content/60">Sign-in</dt>
          <dd className="font-medium">{authLabel(status)}</dd>
        </dl>

        <details className="text-xs">
          <summary className="cursor-pointer font-medium">Details</summary>
          <dl className="mt-1.5 grid grid-cols-[110px_1fr] gap-x-2.5 gap-y-1.5">
            <dt className="text-base-content/60">Version</dt>
            <dd className="font-medium">{status.version ?? 'Unknown'}</dd>
          </dl>
        </details>

        {status.error && (
          <div className="border-l-2 border-base-content pl-2 text-xs">
            <p>Something went wrong checking this tool.</p>
            <details className="mt-1">
              <summary className="cursor-pointer font-medium">Details</summary>
              <pre className="mt-1 max-h-40 overflow-auto break-words whitespace-pre-wrap">{status.error}</pre>
            </details>
          </div>
        )}

        {needsInstall && (
          <div className="rounded-box bg-base-200 p-3 text-xs" data-testid={`provider-fix-${status.id}`}>
            <p className="font-medium">Install {status.name}, then check again.</p>
            <p className="mt-1">
              <a href={guidance.guideUrl} target="_blank" rel="noopener noreferrer" className="link">
                Installation guide
              </a>
            </p>
            {guidance.install && (
              <details className="mt-2">
                <summary className="cursor-pointer font-medium">Show install command</summary>
                <p className="mt-1">Run this in {guidance.install.shell}:</p>
                <code className="mt-1 block rounded bg-base-300 px-2 py-1 font-mono break-all">{guidance.install.command}</code>
                <div className="mt-2">
                  <CopyButton text={guidance.install.command} label="Copy install command" />
                </div>
              </details>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">{checkAgain}</div>
          </div>
        )}

        {needsSignIn && (
          <div className="rounded-box bg-base-200 p-3 text-xs" data-testid={`provider-fix-${status.id}`}>
            <p className="font-medium">
              Sign in by running <span className="font-mono">{guidance.loginCommand}</span> in a terminal, then check again.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CopyButton text={guidance.loginCommand} label="Copy sign-in command" />
              {checkAgain}
            </div>
          </div>
        )}

        {checkState && (
          <p className="text-xs" role="status">
            {checkState === 'checking' && 'Checking…'}
            {checkState === 'ready' && `${status.name} is ready.`}
            {checkState === 'blocked' && (needsInstall ? 'Still not installed.' : 'Still not signed in.')}
          </p>
        )}

        {showPicker && (
          <button
            type="button"
            className="btn btn-sm mt-1"
            disabled={!status.installed || isDefault || saving}
            onClick={onUseAsDefault}
          >
            {/* An uninstalled tool never reads "Default": the "Default" badge above already covers the
                is-this-the-configured-default case, and the install steps sit in the panel above. */}
            {status.installed && isDefault ? <>Default <Check size={14} weight="bold" aria-hidden="true" className="inline" /></> : 'Use this one'}
          </button>
        )}
      </div>
    </div>
  );
}
