import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { resolveApplicationTargetPolicy } from './application-target-policies.js';
import { ALLOW_BUTTON_INDEX, CANCEL_BUTTON_INDEX, showConfirmDialog } from './workspace-confirm.js';
import * as workspace from './workspace/repository.js';
import type { WorkspaceDb } from './workspace/client.js';
import type { AutomationGrantRecord } from './workspace/types.js';

export { CANCEL_BUTTON_INDEX, ALLOW_BUTTON_INDEX };

/**
 * The one and only way an `automation_grants` row is ever created (#203 scope item 5's
 * auth-boundary hardening): a real native `dialog.showMessageBox`, following the exact same
 * discipline `workspace-confirm.ts`'s grant dialog already established -- Cancel as both
 * `defaultId` and `cancelId` so any accidental dismissal refuses, `noLink` so the approving button
 * never renders as the quiet secondary choice, and a pure `buildAutomationGrantConfirmOptions` so
 * the wording itself is directly testable without driving a real dialog. This is deliberately the
 * single narrow choke point `workspace.createAutomationGrant` is called from in this whole app;
 * see `workspace/types.ts`'s own comment on why that function isn't on `WorkspaceBridge` at all.
 */

/** A grant older than this needs a fresh confirmation -- there is no such thing as a permanent,
 * unattended-forever authorization. */
export const MAX_AUTOMATION_GRANT_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export interface AutomationGrantConfirmInput {
  displayName: string;
  /** ISO-8601. Shown in plain language so the person knows exactly how long this lasts. */
  expiresAt: string;
}

/** Builds the dialog options. Pure and exported so the wording and the two safe defaults can be
 * asserted directly, without driving a real Electron dialog. */
export function buildAutomationGrantConfirmOptions(input: AutomationGrantConfirmInput): MessageBoxOptions {
  const until = new Date(input.expiresAt).toLocaleString();
  return {
    type: 'warning',
    title: 'Allow automatic submission?',
    message: `Allow "${input.displayName}" applications to be submitted automatically, without reviewing each one, until ${until}?`,
    detail: [
      'The first application to any new employer is still always shown to you first, and every',
      'automatic submission passes the same content checks a manual one does.',
      '',
      'You can revoke this at any time from Settings.',
    ].join('\n'),
    buttons: ['Cancel', 'Allow automatic submission'],
    defaultId: CANCEL_BUTTON_INDEX,
    cancelId: CANCEL_BUTTON_INDEX,
    noLink: true,
  };
}

export type RequestAutomationGrantRefusalReason = 'unknown_policy' | 'not_eligible_for_automation' | 'invalid_duration' | 'declined';

export type RequestAutomationGrantResult =
  | { ok: true; grant: AutomationGrantRecord }
  | { ok: false; reason: RequestAutomationGrantRefusalReason };

/** Shows the dialog and, only on an exact click of the allow button, creates the grant. Every
 * other outcome (Cancel, Escape, closing the window, any unexpected response index) is a refusal,
 * the same "no ambiguous result authorizes anything" rule `confirmWorkspaceGrant` follows. */
export async function requestAutomationGrant(
  parent: BrowserWindow | undefined,
  db: WorkspaceDb,
  policyId: string,
  durationMs: number,
): Promise<RequestAutomationGrantResult> {
  const policy = resolveApplicationTargetPolicy(policyId);
  if (!policy) return { ok: false, reason: 'unknown_policy' };
  // Checked before ever showing the dialog: there is no legitimate reason to ask a person to
  // authorize automation for a target #197's own register hasn't cleared, so this never even
  // presents that as an option.
  if (!policy.termsEligibleForAutomation) return { ok: false, reason: 'not_eligible_for_automation' };
  if (durationMs <= 0 || durationMs > MAX_AUTOMATION_GRANT_DURATION_MS) return { ok: false, reason: 'invalid_duration' };

  const expiresAt = new Date(Date.now() + durationMs).toISOString();
  const options = buildAutomationGrantConfirmOptions({ displayName: policy.displayName, expiresAt });
  const approved = await showConfirmDialog(parent, options);
  if (!approved) return { ok: false, reason: 'declined' };

  const grant = workspace.createAutomationGrant(db, { policyId, expiresAt });
  return { ok: true, grant };
}
