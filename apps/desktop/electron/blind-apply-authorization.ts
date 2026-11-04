import { createHash } from 'node:crypto';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { CANCEL_BUTTON_INDEX, showConfirmDialog } from './workspace-confirm.js';
import {
  createBlindApplyAuthorization,
  getActiveBlindApplyAuthorization,
  type BlindApplyAuthorizationRecord,
} from './workspace/blind-apply-store.js';
import type { WorkspaceDb } from './workspace/client.js';
import type { BlindApplyEnableResult } from './blind-apply-types.js';

/**
 * The one and only way a Blind Apply authorization is created (#722): a real native
 * `dialog.showMessageBox`, shown once, listing exactly what the person is turning on.
 *
 * It follows the discipline the other grant dialogs in this app already set: Cancel is both the default
 * and the cancel button, so any dismissal refuses; `noLink` so the approving button never renders as the
 * quiet secondary choice; and the wording is built by a pure function so it can be asserted without
 * driving a dialog. The renderer can ask main to show this dialog and nothing else -- it supplies no
 * filters, no CV, no policy and no wording, so it cannot enable Blind Apply on its own, cannot widen
 * what was shown, and cannot make the dialog say less than it does.
 *
 * What it deliberately does not do: ask per job, ask for a number of applications, or ask for a date it
 * expires. There is no cap and no expiry by the person's own choice. One confirmation turns it on; the
 * Stop control turns it off; a changed CV or profile asks for this confirmation again.
 */

export interface BlindApplyConfirmInput {
  /** Plain names of the role families being enabled, e.g. `Frontend / UI engineering`. */
  roleFamilyNames: readonly string[];
  /** The hard filters being applied, each as one plain line. */
  filterLines: readonly string[];
  cvName: string;
  /** Where Blind Apply can really send. Empty means "nowhere real in this build". */
  realTargets: readonly string[];
}

export function buildBlindApplyConfirmOptions(input: BlindApplyConfirmInput): MessageBoxOptions {
  const supported =
    input.realTargets.length > 0
      ? `Sites it can send to: ${input.realTargets.join(', ')}.`
      : 'Sites it can send to now: none yet (a local test form only). Everything else stays "Apply yourself".';
  return {
    type: 'warning',
    title: 'Turn on Blind Apply?',
    message: 'Blind Apply will apply to matching roles for you, without asking about each one.',
    detail: [
      `Roles: ${input.roleFamilyNames.join(', ')}.`,
      ...input.filterLines.map((line) => `Filter: ${line}`),
      `CV used: ${input.cvName}.`,
      supported,
      '',
      'It sends only what is in your CV and profile, plus answers you chose to remember. It never',
      'invents an answer, ticks a consent box, signs in, or solves a bot check or verification code;',
      'those stop and wait for you. A role that is closed, already applied to, or not on a supported',
      'site is never sent.',
      '',
      'There is no daily limit. Stop Blind Apply at any time. If you change your CV or profile it',
      'pauses until you confirm it again.',
    ].join('\n'),
    buttons: ['Cancel', 'Turn on Blind Apply'],
    defaultId: CANCEL_BUTTON_INDEX,
    cancelId: CANCEL_BUTTON_INDEX,
    noLink: true,
  };
}

export function confirmTextHashOf(options: MessageBoxOptions): string {
  return createHash('sha256').update(`${options.title ?? ''}\n${options.message}\n${options.detail ?? ''}`).digest('hex');
}

/** Everything main must know to build and record the confirmation. Gathered by main, never by the renderer. */
export interface BlindApplyAuthorizationFacts {
  roleFamilies: string[];
  roleFamilyNames: string[];
  filtersSnapshot: Record<string, unknown>;
  filterLines: string[];
  profileVersion: string;
  cv: { id: string; name: string; contentHash: string } | null;
  /** Compiled policy ids that could receive an unattended Blind submission, at this moment. */
  policyIds: string[];
  realTargets: string[];
}

export interface BlindApplyAuthorizationDeps {
  db: WorkspaceDb;
  parent: BrowserWindow | undefined;
  /** Injected so a test can answer the dialog without Electron. */
  confirm?: (parent: BrowserWindow | undefined, options: MessageBoxOptions) => Promise<boolean>;
  now?: () => Date;
  /**
   * Runs after the person approves and before the new authorization is written. Main passes the same
   * Stop the Stop button runs, so the previous authorization's unsent work is cancelled and its pages
   * closed instead of lingering as Preparing / Needs you under an authorization that no longer acts.
   * If it throws, nothing new is authorized.
   */
  beforeReplace?: () => Promise<void>;
}

export type RequestBlindApplyResult =
  | { ok: true; authorization: BlindApplyAuthorizationRecord }
  | Extract<BlindApplyEnableResult, { ok: false }>;

/** Shows the dialog and, only on an exact click of the approving button, records the authorization. */
export async function requestBlindApplyAuthorization(
  deps: BlindApplyAuthorizationDeps,
  facts: BlindApplyAuthorizationFacts,
): Promise<RequestBlindApplyResult> {
  if (facts.roleFamilies.length === 0) return { ok: false, reason: 'no_role_family' };
  if (facts.cv === null) return { ok: false, reason: 'no_cv' };
  if (facts.profileVersion === '') return { ok: false, reason: 'no_profile' };

  const options = buildBlindApplyConfirmOptions({
    roleFamilyNames: facts.roleFamilyNames,
    filterLines: facts.filterLines,
    cvName: facts.cv.name,
    realTargets: facts.realTargets,
  });
  const approved = await (deps.confirm ?? showConfirmDialog)(deps.parent, options);
  if (!approved) return { ok: false, reason: 'declined' };

  await deps.beforeReplace?.();

  const authorization = createBlindApplyAuthorization(
    deps.db,
    {
      roleFamilies: facts.roleFamilies,
      filtersSnapshot: facts.filtersSnapshot,
      filtersHash: createHash('sha256').update(JSON.stringify(facts.filtersSnapshot)).digest('hex'),
      profileVersion: facts.profileVersion,
      sourceCvId: facts.cv.id,
      sourceCvContentHash: facts.cv.contentHash,
      useSavedAnswers: true,
      policyIds: facts.policyIds,
      confirmTextHash: confirmTextHashOf(options),
    },
    deps.now?.() ?? new Date(),
  );
  return { ok: true, authorization };
}

/** Whether Blind Apply is currently authorized. A plain read for callers that must not act otherwise. */
export function isBlindApplyAuthorized(db: WorkspaceDb): boolean {
  return getActiveBlindApplyAuthorization(db) !== null;
}
