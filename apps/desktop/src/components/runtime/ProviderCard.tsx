import { Check } from '@phosphor-icons/react';
import type { ProviderCapabilities, ProviderStatus } from '@agent-dock/shared';
import { CopyButton } from '../shell/index.js';
import { detectPlatform, providerGuidance } from './provider-guidance.js';

const CAPABILITY_LABEL: ReadonlyArray<{ key: keyof ProviderCapabilities; label: string }> = [
  { key: 'resume', label: 'Resume' },
  { key: 'tools', label: 'Tools' },
  { key: 'usage', label: 'Usage' },
  { key: 'thinking', label: 'Thinking' },
];

function authLabel(status: ProviderStatus): string {
  if (status.authenticated === 'authenticated') return 'Authenticated';
  if (status.authenticated === 'unauthenticated') return 'Not authenticated';
  return 'Unknown';
}

function readyLabel(status: ProviderStatus): string {
  if (!status.installed) return 'Not installed';
  if (status.authenticated === 'authenticated') return 'Ready';
  if (status.authenticated === 'unauthenticated') return 'Not authenticated';
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
  /** Re-reads provider status. Without it the card shows no "Check again" button. */
  onCheckAgain?: () => void;
  checkState?: ProviderCheckState;
}

/**
 * One CLI's status, matching the prototype's provider card (`export-src.html` AI Runtime screen):
 * a ready dot, an Installed/Authentication/Version/Model grid, capability chips, and a button that
 * either sets this provider as the one AI features run through or explains why it can't yet.
 * Every field here is real data from `window.agentDock.listProviders()`: nothing is invented for
 * the sake of matching the mockup's layout.
 */
export function ProviderCard({ status, isDefault, onUseAsDefault, saving, onCheckAgain, checkState }: ProviderCardProps) {
  const capabilities = CAPABILITY_LABEL.filter(({ key }) => status.capabilities[key]);
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
          <dt className="text-base-content/60">Installed</dt>
          <dd className="font-medium">{status.installed ? 'Yes' : 'No'}</dd>
          <dt className="text-base-content/60">Authentication</dt>
          <dd className="font-medium">{authLabel(status)}</dd>
          <dt className="text-base-content/60">Version</dt>
          <dd className="font-medium">{status.version ?? 'Unknown'}</dd>
        </dl>

        {capabilities.length > 0 && (
          <div>
            <div className="mb-1.5 ovr-eyebrow">
              Capabilities
            </div>
            <div className="flex flex-wrap gap-1.5">
              {capabilities.map(({ key, label }) => (
                <span key={key} className="badge badge-outline badge-sm">
                  {label}
                </span>
              ))}
            </div>
          </div>
        )}

        {status.error && <div className="border-l-2 border-base-content pl-2 text-xs">{status.error}</div>}

        {needsInstall && (
          <div className="rounded-box bg-base-200 p-3 text-xs" data-testid={`provider-fix-${status.id}`}>
            <p className="font-medium">{status.name} is not installed on this computer.</p>
            <p className="mt-1">
              <a href={guidance.guideUrl} target="_blank" rel="noopener noreferrer" className="link">
                Installation guide
              </a>
            </p>
            {guidance.install ? (
              <>
                <p className="mt-2">Run this in {guidance.install.shell}:</p>
                <code className="mt-1 block rounded bg-base-300 px-2 py-1 font-mono break-all">{guidance.install.command}</code>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <CopyButton text={guidance.install.command} label="Copy install command" />
                  {checkAgain}
                </div>
              </>
            ) : (
              <>
                <p className="mt-2">Follow the installation guide for your system, then check again.</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">{checkAgain}</div>
              </>
            )}
          </div>
        )}

        {needsSignIn && (
          <div className="rounded-box bg-base-200 p-3 text-xs" data-testid={`provider-fix-${status.id}`}>
            <p className="font-medium">
              Open a terminal and run <span className="font-mono">{guidance.loginCommand}</span>, then sign in.
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

        <button
          type="button"
          className="btn btn-sm mt-1"
          disabled={!status.installed || isDefault || saving}
          onClick={onUseAsDefault}
        >
          {/* An uninstalled CLI never reads "Default": the "Default" badge above already covers the
              is-this-the-configured-default case, and the install steps sit in the panel above. */}
          {status.installed && isDefault ? <>Default <Check size={14} weight="bold" aria-hidden="true" className="inline" /></> : 'Use as default'}
        </button>
      </div>
    </div>
  );
}
