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
 * Shows the dialog and reports whether the user approved.
 *
 * Returns `true` **only** for an exact click on the allow button. Every other outcome (Cancel,
 * Escape, closing the window, and any unexpected response index) is a refusal, because there is no
 * reading of an ambiguous result that should authorize filesystem access.
 */
export async function confirmWorkspaceGrant(
  parent: BrowserWindow | undefined,
  input: WorkspaceConfirmInput,
): Promise<boolean> {
  const options = buildConfirmOptions(input);
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return result.response === ALLOW_BUTTON_INDEX;
}
