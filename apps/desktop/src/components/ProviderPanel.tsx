import type { ProviderStatus } from '@agent-dock/shared';

function authLabel(status: ProviderStatus): string {
  if (status.authenticated === 'authenticated') return 'yes';
  if (status.authenticated === 'unauthenticated') return 'no';
  return 'unknown';
}

export function ProviderPanel({ providers }: { providers: ProviderStatus[] }) {
  return (
    <div className="mt-4 flex flex-wrap gap-4">
      {providers.map((status) => (
        <div key={status.id} className="card card-border rounded-box border-base-300 bg-base-100 min-w-48">
          <div className="card-body gap-1 p-4 text-sm">
            <div className="card-title text-base font-bold">{status.name}</div>
            <div>Installed: {status.installed ? 'Yes' : 'No'}</div>
            <div>Authenticated: {authLabel(status)}</div>
            {status.version && <div>Version: {status.version}</div>}
            {status.error && (
              <div className="mt-1 border-l-2 border-base-content pl-2 text-xs font-medium">{status.error}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
