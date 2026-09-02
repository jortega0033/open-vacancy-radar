import { beforeEach, describe, expect, it, vi } from 'vitest';

const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn() }));

vi.mock('electron', () => ({ dialog: { showMessageBox } }));

const {
  ALLOW_BUTTON_INDEX,
  CANCEL_BUTTON_INDEX,
  buildConfirmOptions,
  confirmWorkspaceGrant,
} = await import('../electron/workspace-confirm.js');

const INPUT = {
  displayName: 'my-project',
  branch: 'main',
  dirty: false,
  effects: 'unbounded_cli',
  providerName: 'Claude Code',
} as const;

beforeEach(() => {
  showMessageBox.mockReset();
});

describe('the confirmation dialog defaults to refusing', () => {
  it('points both defaultId and cancelId at Cancel', () => {
    const options = buildConfirmOptions({ ...INPUT });
    expect(options.buttons?.[CANCEL_BUTTON_INDEX]).toBe('Cancel');
    expect(options.defaultId).toBe(CANCEL_BUTTON_INDEX);
    expect(options.cancelId).toBe(CANCEL_BUTTON_INDEX);
    // Enter, Escape, and closing the window therefore all decline. A dialog whose default is the
    // permissive answer converts an accidental keypress into filesystem access.
    expect(options.defaultId).toBe(options.cancelId);
  });

  it('sets noLink, so the approving button is not rendered as the quiet secondary choice', () => {
    expect(buildConfirmOptions({ ...INPUT }).noLink).toBe(true);
  });

  it('treats every non-approval response as a refusal', async () => {
    for (const response of [CANCEL_BUTTON_INDEX, 99, -1]) {
      showMessageBox.mockResolvedValueOnce({ response });
      await expect(confirmWorkspaceGrant(undefined, { ...INPUT })).resolves.toBe(false);
    }
    showMessageBox.mockResolvedValueOnce({ response: ALLOW_BUTTON_INDEX });
    await expect(confirmWorkspaceGrant(undefined, { ...INPUT })).resolves.toBe(true);
  });
});

describe('what the dialog actually says', () => {
  it('names the folder and the provider', () => {
    const options = buildConfirmOptions({ ...INPUT });
    expect(options.message).toContain('my-project');
    expect(options.message).toContain('Claude Code');
  });

  it('discloses the unbounded effects in plain language, without narrowing them', () => {
    const detail = buildConfirmOptions({ ...INPUT }).detail ?? '';
    // The D4 disclosure. A narrowed claim ("can read files here") would be false over this repo's
    // one transport, and a false claim in a security dialog is worse than no claim.
    expect(detail).toContain('read, write, run commands, and access the network');
    expect(detail).not.toMatch(/read-only|only read|cannot write/i);
  });

  it('shows the branch when there is one, and says so plainly when there is not', () => {
    expect(buildConfirmOptions({ ...INPUT }).detail).toContain('Git branch: main');
    const noBranch = buildConfirmOptions({ ...INPUT, branch: undefined });
    expect(noBranch.detail).toContain('Not a Git repository');
  });

  it('states the dirty case as "or could not confirm", matching the fail-closed check behind it', () => {
    // `isWorkspaceDirty` answers true when `git status` fails, so the dialog must not claim more
    // than the check proved.
    const dirty = buildConfirmOptions({ ...INPUT, dirty: true });
    expect(dirty.detail).toContain('uncommitted changes, or the app could not confirm');
    const clean = buildConfirmOptions({ ...INPUT, dirty: false });
    expect(clean.detail).toContain('no uncommitted changes');
  });

  it('uses no em dash anywhere in the user-facing text', () => {
    const options = buildConfirmOptions({ ...INPUT });
    const text = [options.title, options.message, options.detail, ...(options.buttons ?? [])].join(' ');
    expect(text).not.toContain('—');
  });

  it('carries no path: only the folder`s own name reaches the dialog', () => {
    const options = buildConfirmOptions({ ...INPUT });
    const text = [options.title, options.message, options.detail].join(' ');
    expect(text).not.toMatch(/[A-Za-z]:\\/);
    expect(text).not.toContain('/Users/');
  });
});
