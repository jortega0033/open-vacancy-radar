import type { ProviderCapabilities, ProviderStatus } from '@agent-dock/shared';

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

export interface ProviderCardProps {
  status: ProviderStatus;
  /** Whether this is the provider AI features currently run through. */
  isDefault: boolean;
  onUseAsDefault: () => void;
  /** True while a "use as default" save for this card is in flight. */
  saving: boolean;
}

/**
 * One CLI's status, matching the prototype's provider card (`export-src.html` AI Runtime screen):
 * a ready dot, an Installed/Authentication/Version/Model grid, capability chips, and a button that
 * either sets this provider as the one AI features run through or explains why it can't yet.
 * Every field here is real data from `window.agentDock.listProviders()`: nothing is invented for
 * the sake of matching the mockup's layout.
 */
export function ProviderCard({ status, isDefault, onUseAsDefault, saving }: ProviderCardProps) {
  const capabilities = CAPABILITY_LABEL.filter(({ key }) => status.capabilities[key]);

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
          <dt className="text-base-content/60">Model</dt>
          <dd className="font-medium">CLI default</dd>
        </dl>

        {capabilities.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-base-content/60 uppercase">
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

        <button
          type="button"
          className="btn btn-sm mt-1"
          disabled={!status.installed || isDefault || saving}
          onClick={onUseAsDefault}
        >
          {/* "Not installed" always wins: the "Default" badge above already covers the
              is-this-the-configured-default case, and this button must never claim a CLI that
              cannot run a session is ready just because it happens to be the persisted default. */}
          {!status.installed ? 'Not installed' : isDefault ? 'Default ✓' : 'Use as default'}
        </button>
      </div>
    </div>
  );
}
