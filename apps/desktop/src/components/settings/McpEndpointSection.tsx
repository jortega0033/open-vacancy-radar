import { useCallback, useEffect, useState } from 'react';
import type { AppSettingsPatch, AppSettingsRecord, CvDocumentRecord, McpClientGrantRecord } from '../../window.js';
import { ConfirmDialog, ErrorBanner } from '../shell/index.js';
import { SettingsRow, SettingsSection, SettingsSubheading, ToggleSwitch } from './controls.js';

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** 30 days, the same "a grant does not silently outlive the reason it was created" reasoning
 * `automationGrants`'s own UI likely follows elsewhere -- long enough that a real working
 * integration is not re-authorized every session, short enough that a forgotten grant expires
 * on its own rather than needing to be remembered and revoked. */
const DEFAULT_GRANT_DURATION_DAYS = 30;

interface McpEndpointSectionProps {
  settings: AppSettingsRecord;
  cvDocuments: CvDocumentRecord[];
  disabled?: boolean;
  onToggled: (patch: AppSettingsPatch) => void;
}

function isActive(grant: McpClientGrantRecord): boolean {
  return !grant.revokedAt && grant.expiresAt > new Date().toISOString();
}

/**
 * #421: the endpoint's on/off switch, its current address (once running), and the named client
 * grants a candidate has created against it. Deliberately scoped to the `source_cv` grant type
 * only in this UI -- #421's own "Candidate flow" describes granting access to "one reviewed
 * source CV" as the primary path, and the `case_ids` scope this app's data layer also supports
 * (`mcp-grant-schema.ts`) has no case picker built yet; that is future UI, not a corner cut here.
 *
 * The one-time credential a new grant mints is never seen by this component: `createMcpClientGrant`
 * resolves to the grant record alone, and the secret itself is shown to the candidate through a
 * native dialog main.ts opens directly (see that handler's own doc comment for why).
 */
export function McpEndpointSection({ settings, cvDocuments, disabled, onToggled }: McpEndpointSectionProps) {
  const [status, setStatus] = useState<{ running: boolean; port: number | null } | null>(null);
  const [grants, setGrants] = useState<McpClientGrantRecord[] | null>(null);
  const [listError, setListError] = useState<string>();

  const [grantName, setGrantName] = useState('');
  const [grantCvId, setGrantCvId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();

  const [revokeTarget, setRevokeTarget] = useState<McpClientGrantRecord | null>(null);
  const [revoking, setRevoking] = useState(false);

  const refreshStatus = useCallback(() => {
    void window.workspace.getMcpServerStatus().then(setStatus, () => setStatus({ running: false, port: null }));
  }, []);

  const refreshGrants = useCallback(() => {
    void window.workspace.listMcpClientGrants().then(
      (list) => setGrants(list),
      (err) => setListError(describeError(err, 'Could not load the connected apps.')),
    );
  }, []);

  useEffect(() => {
    refreshStatus();
    refreshGrants();
  }, [refreshStatus, refreshGrants]);

  // The endpoint takes a moment to bind after the toggle turns on (and to release after it turns
  // off); re-reading once, shortly after a toggle, shows the real outcome instead of leaving the
  // address line on whatever it said before the toggle was touched.
  useEffect(() => {
    const timer = setTimeout(refreshStatus, 500);
    return () => clearTimeout(timer);
  }, [settings.mcpEndpointEnabled, refreshStatus]);

  const createGrant = useCallback(() => {
    const name = grantName.trim();
    if (!name) {
      setCreateError('Give this app a name.');
      return;
    }
    if (!grantCvId) {
      setCreateError('Choose which CV this app may tailor.');
      return;
    }
    setCreating(true);
    setCreateError(undefined);
    const expiresAt = new Date(Date.now() + DEFAULT_GRANT_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    void window.workspace.createMcpClientGrant({ name, scopeType: 'source_cv', sourceCvId: grantCvId, expiresAt }).then(
      (grant) => {
        setGrants((prev) => [grant, ...(prev ?? [])]);
        setGrantName('');
        setCreating(false);
      },
      (err) => {
        setCreateError(describeError(err, 'Could not allow this app.'));
        setCreating(false);
      },
    );
  }, [grantName, grantCvId]);

  const confirmRevoke = useCallback(() => {
    if (!revokeTarget) return;
    setRevoking(true);
    void window.workspace.revokeMcpClientGrant(revokeTarget.id).then(
      (updated) => {
        setGrants((prev) => (prev ?? []).map((g) => (g.id === updated.id ? updated : g)));
        setRevokeTarget(null);
        setRevoking(false);
      },
      (err) => {
        setListError(describeError(err, 'Could not remove this app.'));
        setRevoking(false);
        setRevokeTarget(null);
      },
    );
  }, [revokeTarget]);

  const cvName = useCallback((cvId: string) => cvDocuments.find((cv) => cv.id === cvId)?.name ?? '(deleted CV)', [cvDocuments]);

  return (
    <SettingsSection title="Connect other AI apps">
      <SettingsRow
        label="Let other AI apps help tailor CVs"
        description="Lets an app you approve below suggest changes to your CV. Nothing changes until you approve it here, and nothing leaves this computer."
      >
        <ToggleSwitch
          label="Let other AI apps help tailor CVs"
          checked={settings.mcpEndpointEnabled}
          disabled={disabled}
          onChange={(mcpEndpointEnabled) => onToggled({ mcpEndpointEnabled })}
        />
      </SettingsRow>

      {settings.mcpEndpointEnabled && (
        <details className="ovr-row border-b border-base-300">
          <summary className="cursor-pointer text-sm font-medium">Technical details</summary>
          <p className="mt-2 text-sm text-base-content/70">
            Address:{' '}
            <span role="status">
              {status?.running && status.port ? `http://127.0.0.1:${status.port}` : 'starting…'}
            </span>
          </p>
        </details>
      )}

      {settings.mcpEndpointEnabled && (
        <div className="mt-4">
          <SettingsSubheading>Allowed apps</SettingsSubheading>

          {listError && <ErrorBanner className="mt-2">{listError}</ErrorBanner>}

          <div className="ovr-row flex flex-wrap items-end gap-2 border-b border-base-300">
            <div>
              <label htmlFor="mcp-grant-name" className="mb-1 block text-xs text-base-content/60">
                App name
              </label>
              <input
                id="mcp-grant-name"
                type="text"
                className="input input-sm"
                placeholder="e.g. My Claude Desktop"
                value={grantName}
                disabled={disabled || creating}
                onChange={(event) => setGrantName(event.currentTarget.value)}
              />
            </div>
            <div>
              <label htmlFor="mcp-grant-cv" className="mb-1 block text-xs text-base-content/60">
                CV this app may tailor
              </label>
              <select
                id="mcp-grant-cv"
                className="select select-sm"
                value={grantCvId}
                disabled={disabled || creating || cvDocuments.length === 0}
                onChange={(event) => setGrantCvId(event.currentTarget.value)}
              >
                <option value="">Choose a CV</option>
                {cvDocuments.map((cv) => (
                  <option key={cv.id} value={cv.id}>
                    {cv.name}
                  </option>
                ))}
              </select>
            </div>
            <button type="button" className="btn btn-sm btn-primary" disabled={disabled || creating} onClick={createGrant}>
              {creating && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
              Allow app
            </button>
          </div>
          {createError && <ErrorBanner className="mt-2">{createError}</ErrorBanner>}

          {grants === null ? (
            <p className="mt-2 text-sm text-base-content/60">Loading…</p>
          ) : grants.length === 0 ? (
            <p className="mt-2 text-sm text-base-content/60">No apps connected.</p>
          ) : (
            <ul className="mt-2">
              {grants.map((grant) => (
                <li key={grant.id} className="ovr-row flex items-center justify-between gap-3 border-b border-base-300">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{grant.name}</span>
                      {!isActive(grant) && <span className="badge badge-ghost badge-sm">{grant.revokedAt ? 'Removed' : 'Expired'}</span>}
                    </div>
                    <p className="mt-0.5 text-xs text-base-content/60">
                      {grant.scopeType === 'source_cv' ? `Can tailor: ${cvName(grant.sourceCvId)} · ` : ''}
                      {'Expires '}
                      {new Date(grant.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                  {isActive(grant) && (
                    <button type="button" className="btn btn-sm btn-outline flex-none" onClick={() => setRevokeTarget(grant)}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {revokeTarget && (
        <ConfirmDialog
          title="Remove this app's access?"
          message={`"${revokeTarget.name}" loses access right away. You can allow it again later.`}
          confirmLabel="Remove access"
          onConfirm={confirmRevoke}
          onCancel={() => setRevokeTarget(null)}
        />
      )}
      {revoking && <span className="sr-only">Revoking…</span>}
    </SettingsSection>
  );
}
