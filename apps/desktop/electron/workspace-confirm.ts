import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron';

/**
 * The native confirmation dialog a workspace grant cannot be issued without (ADI-06).
 *
 * This is the only moment in the whole grant flow where a human decides anything, so the wording is
 * part of the security surface, not presentation polish. Three rules govern it:
 *
 * 1. **Name the folder.** A confirmation that cannot say what is being approved is not a
 *    confirmation. The basename is shown, never the full path: it is enough to recognize the folder
 *    the user just picked in the previous dialog, and it keeps the string bounded.
 * 2. **State the effects honestly.** The grant carries the literal `'unbounded_cli'` (D4), and this
 *    dialog spells out what that actually means in plain language. A narrowed claim like "this agent
 *    can read files in this folder" would be false: over the `legacy-one-shot` transport the CLI is
 *    spawned with the folder as its working directory and is not constrained afterwards.
 * 3. **Cancel is the default.** `defaultId` and `cancelId` both point at Cancel, so Enter, Escape,
 *    and closing the window all decline. A dialog whose default is the permissive answer converts
 *    every accidental keypress into an approval.
 */

export type WorkspaceGrantEffects = 'unbounded_cli';

export interface WorkspaceConfirmInput {
  /** Bounded basename of the directory. Never a path. */
  displayName: string;
  /** Git branch, when the workspace is a repository and HEAD is not detached. */
  branch?: string;
  /** Whether the workspace has uncommitted changes, or whether that could not be determined. */
  dirty: boolean;
  /** Always the literal today. Typed rather than inlined so a future widening is a compile error. */
  effects: WorkspaceGrantEffects;
  /** Shown so the user knows which agent they are approving. */
  providerName: string;
}

/** Index of the Cancel button in `buildConfirmOptions().buttons`. Both `defaultId` and `cancelId`. */
export const CANCEL_BUTTON_INDEX = 0;
/** Index of the approving button. Only this index counts as consent. */
export const ALLOW_BUTTON_INDEX = 1;

/**
 * Builds the dialog options. Pure and exported so the wording, the button order, and the two
 * defaults can be asserted directly, without driving a real Electron dialog.
 */
export function buildConfirmOptions(input: WorkspaceConfirmInput): MessageBoxOptions {
  const branchLine = input.branch ? `Git branch: ${input.branch}` : 'Not a Git repository, or no current branch';
  const dirtyLine = input.dirty
    ? 'This folder has uncommitted changes, or the app could not confirm that it is clean.'
    : 'This folder has no uncommitted changes.';

  return {
    type: 'warning',
    title: 'Allow agent access to this folder?',
    message: `Allow ${input.providerName} to work in "${input.displayName}"?`,
    detail: [
      branchLine,
      dirtyLine,
      '',
      'This agent will be able to read, write, run commands, and access the network within this ' +
        'folder. The app cannot narrow those abilities: the agent runs as a command-line tool with ' +
        'your own account permissions.',
      '',
      'Only allow this for a folder you would be comfortable handing to a person you trust with ' +
        'your computer.',
    ].join('\n'),
    buttons: ['Cancel', 'Allow access'],
    defaultId: CANCEL_BUTTON_INDEX,
    cancelId: CANCEL_BUTTON_INDEX,
    // Without this, macOS renders the trailing button as a link-styled affordance rather than a
    // plain button, which reads as the safe, secondary choice while being the permissive one.
    noLink: true,
  };
}

/**
 * Shows a `dialog.showMessageBox` confirmation and reports whether the user approved.
 *
 * Returns `true` **only** for an exact click on `allowIndex` (defaulting to `ALLOW_BUTTON_INDEX`).
 * Every other outcome (Cancel, Escape, closing the window, and any unexpected response index) is a
 * refusal, because there is no reading of an ambiguous result that should authorize anything.
 * Shared by every native grant-confirmation dialog in the app (`confirmWorkspaceGrant` below,
 * `automatic-submission-grant.ts`'s `requestAutomationGrant`) so this rule, and the parent-window
 * branching, live in exactly one place rather than being re-typed at each call site.
 */
export async function showConfirmDialog(
  parent: BrowserWindow | undefined,
  options: MessageBoxOptions,
  allowIndex: number = ALLOW_BUTTON_INDEX,
): Promise<boolean> {
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return result.response === allowIndex;
}

/** Shows the workspace-grant dialog specifically. See `showConfirmDialog` for the shared consent rule. */
export async function confirmWorkspaceGrant(
  parent: BrowserWindow | undefined,
  input: WorkspaceConfirmInput,
): Promise<boolean> {
  return showConfirmDialog(parent, buildConfirmOptions(input));
}

export interface CvTranscriptionConsentInput {
  /** Bounded basename of the picked file. Never a path. */
  fileName: string;
  /** Display name of the provider this file would be sent to. */
  providerName: string;
}

/**
 * The native confirmation a scanned/image-only CV's original PDF cannot be sent for AI
 * transcription without (issue #396).
 *
 * This is the one and only place that consent is granted: `cv:select-and-read` shows it, and only
 * an exact click on the allow button leads to the file ever being staged at all (see
 * `cv-transcription-staging.ts`). A renderer-drawn confirmation was deliberately rejected for this
 * decision, for the same reason `confirmWorkspaceGrant` above uses a native one: a renderer-drawn
 * modal is just more DOM the renderer itself controls, so it proves nothing about what the user
 * actually saw or clicked, and it cannot stand between a compromised renderer and an IPC call it
 * is otherwise free to make. See `showConfirmDialog`'s own doc comment for the shared consent
 * rule (only the allow index counts; everything else, including closing the window, is a refusal).
 */
export function buildCvTranscriptionConsentOptions(input: CvTranscriptionConsentInput): MessageBoxOptions {
  return {
    type: 'warning',
    title: 'Transcribe with AI?',
    message: `Send "${input.fileName}" to ${input.providerName} for transcription?`,
    detail: [
      `"${input.fileName}" has no selectable text. It looks like a scanned image.`,
      '',
      `${input.providerName} can transcribe it for you, but that means sending the original file ` +
        'to your configured AI CLI for this one operation. The transcribed text will be shown to ' +
        'you for review before anything is saved.',
    ].join('\n'),
    buttons: ['Cancel', 'Send for transcription'],
    defaultId: CANCEL_BUTTON_INDEX,
    cancelId: CANCEL_BUTTON_INDEX,
    noLink: true,
  };
}

/** Shows the CV-transcription consent dialog specifically. See `showConfirmDialog` for the shared
 * consent rule. */
export async function confirmCvTranscription(
  parent: BrowserWindow | undefined,
  input: CvTranscriptionConsentInput,
): Promise<boolean> {
  return showConfirmDialog(parent, buildCvTranscriptionConsentOptions(input));
}
