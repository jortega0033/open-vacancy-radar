import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CvLibraryPage } from '../../../src/components/cv-library/index.js';
import type { CvBridge, CvDocumentRecord } from '../../../src/window.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';

function makeCv(overrides: Partial<CvDocumentRecord> = {}): CvDocumentRecord {
  return {
    id: overrides.id ?? 'cv-1',
    name: 'Frontend CV',
    kind: 'uploaded',
    targetRole: 'Senior Frontend Engineer',
    text: 'Angular. TypeScript. 8 years.',
    profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
    isDefault: false,
    uploadedAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

function installCvBridge(overrides: Partial<CvBridge> = {}): CvBridge {
  const bridge: CvBridge = {
    selectAndRead: vi.fn().mockResolvedValue(null),
    getWorkspaceDir: vi.fn().mockResolvedValue('/userData/ai-workspace'),
    ...overrides,
  };
  (window as unknown as { cv: CvBridge }).cv = bridge;
  return bridge;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CvLibraryPage', () => {
  it('shows an empty state when the library has no documents', async () => {
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([]) });
    installCvBridge();

    render(<CvLibraryPage />);

    await waitFor(() => expect(screen.getByText(/no cvs on file/i)).toBeInTheDocument());
    expect(screen.getByTestId('empty-state-illustration').getAttribute('style')).toContain('empty-cv');
  });

  it('renders the CV list with a default marker', async () => {
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([
        makeCv({ id: 'a', name: 'Frontend CV', isDefault: true }),
        makeCv({ id: 'b', name: 'Manual Profile', kind: 'manual', isDefault: false }),
      ]),
    });
    installCvBridge();

    render(<CvLibraryPage />);

    await waitFor(() => expect(screen.getByText('Frontend CV')).toBeInTheDocument());
    expect(screen.getByText('Manual Profile')).toBeInTheDocument();
    // The "Default" column header also matches this text, so scope to the badge itself.
    expect(screen.getByText('Default', { selector: '.badge' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set as default/i })).toBeInTheDocument();
  });

  it('validates required fields and splits/joins skills when adding a manual profile', async () => {
    const created = makeCv({
      id: 'new-1',
      name: 'New Manual CV',
      kind: 'manual',
      profile: {
        title: 'Frontend Architect',
        years: '8',
        location: 'Remote',
        languages: 'English',
        skills: ['Angular', 'TypeScript'],
        summary: '',
        auth: '',
      },
    });
    const createCvDocument = vi.fn().mockResolvedValue(created);
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([]), createCvDocument });
    installCvBridge();

    render(<CvLibraryPage />);
    await waitFor(() => expect(screen.getByText(/no cvs on file/i)).toBeInTheDocument());

    // The empty state's own call-to-action shares this label with the header button.
    const addButtons = screen.getAllByRole('button', { name: /add manual profile/i });
    const addButton = addButtons[0];
    if (!addButton) throw new Error('expected at least one "Add manual profile" button');
    fireEvent.click(addButton);
    const dialog = await screen.findByRole('dialog', { name: /add manual cv profile/i });

    // Submitting a blank name shows the inline validation message and does not call the bridge.
    fireEvent.click(within(dialog).getByRole('button', { name: /add cv/i }));
    expect(await within(dialog).findByText(/name is required/i)).toBeInTheDocument();
    expect(createCvDocument).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'New Manual CV' } });
    fireEvent.change(within(dialog).getByLabelText(/skills/i), { target: { value: 'Angular, TypeScript ,  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /add cv/i }));

    await waitFor(() => expect(createCvDocument).toHaveBeenCalledTimes(1));
    expect(createCvDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'New Manual CV',
        kind: 'manual',
        profile: expect.objectContaining({ skills: ['Angular', 'TypeScript'] }),
      }),
    );

    await waitFor(() => expect(screen.getByText('New Manual CV')).toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: /add manual cv profile/i })).not.toBeInTheDocument();
  });

  it('pre-fills the drawer on edit, joining skills back to comma text, and calls updateCvDocument', async () => {
    const record = makeCv({
      id: 'edit-1',
      name: 'Existing CV',
      profile: {
        title: 'Frontend Dev',
        years: '5',
        location: 'Amsterdam',
        languages: 'Dutch, English',
        skills: ['React', 'CSS'],
        summary: 'Builds things.',
        auth: 'EU citizen',
      },
    });
    const updateCvDocument = vi.fn().mockResolvedValue({ ...record, name: 'Renamed CV' });
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([record]), updateCvDocument });
    installCvBridge();

    render(<CvLibraryPage />);
    await waitFor(() => expect(screen.getByText('Existing CV')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit cv/i });

    expect(within(dialog).getByLabelText(/^name/i)).toHaveValue('Existing CV');
    expect(within(dialog).getByLabelText(/skills/i)).toHaveValue('React, CSS');
    expect(within(dialog).getByLabelText(/summary/i)).toHaveValue('Builds things.');

    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'Renamed CV' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateCvDocument).toHaveBeenCalledTimes(1));
    expect(updateCvDocument).toHaveBeenCalledWith('edit-1', expect.objectContaining({ name: 'Renamed CV' }));
    await waitFor(() => expect(screen.getByText('Renamed CV')).toBeInTheDocument());
  });

  it('sets a CV as default and updates the list from the returned array', async () => {
    const a = makeCv({ id: 'a', name: 'CV A', isDefault: true });
    const b = makeCv({ id: 'b', name: 'CV B', isDefault: false });
    const setDefaultCvDocument = vi.fn().mockResolvedValue([
      { ...a, isDefault: false },
      { ...b, isDefault: true },
    ]);
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([a, b]), setDefaultCvDocument });
    installCvBridge();

    render(<CvLibraryPage />);
    await waitFor(() => expect(screen.getByText('CV A')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /set as default/i }));

    await waitFor(() => expect(setDefaultCvDocument).toHaveBeenCalledWith('b'));
    // Exactly one badge (excluding the "Default" column header) proves the demotion round-tripped.
    await waitFor(() => expect(screen.getAllByText('Default', { selector: '.badge' })).toHaveLength(1));

    const rows = screen.getAllByRole('row');
    const rowB = rows.find((row) => within(row).queryByText('CV B'));
    expect(rowB).toBeDefined();
    expect(within(rowB!).getByText('Default', { selector: '.badge' })).toBeInTheDocument();
  });

  it('deletes a CV through the confirm dialog', async () => {
    const record = makeCv({ id: 'del-1', name: 'To Delete' });
    const deleteCvDocument = vi.fn().mockResolvedValue({ deleted: true });
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([record]), deleteCvDocument });
    installCvBridge();

    render(<CvLibraryPage />);
    await waitFor(() => expect(screen.getByText('To Delete')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const confirmDialog = await screen.findByRole('alertdialog');
    expect(confirmDialog).toHaveTextContent(/cannot be undone/i);
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(deleteCvDocument).toHaveBeenCalledWith('del-1'));
    await waitFor(() => expect(screen.getByText(/no cvs on file/i)).toBeInTheDocument());
  });

  it('cancels a delete without calling deleteCvDocument', async () => {
    const record = makeCv({ id: 'keep-1', name: 'Keep Me' });
    const deleteCvDocument = vi.fn().mockResolvedValue({ deleted: true });
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([record]), deleteCvDocument });
    installCvBridge();

    render(<CvLibraryPage />);
    await waitFor(() => expect(screen.getByText('Keep Me')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const confirmDialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deleteCvDocument).not.toHaveBeenCalled();
    expect(screen.getByText('Keep Me')).toBeInTheDocument();
  });

  it('uploads a CV: picks a file through window.cv, then persists it via SaveCvToLibrary', async () => {
    const created = makeCv({ id: 'uploaded-1', name: 'resume.pdf', kind: 'uploaded' });
    const createCvDocument = vi.fn().mockResolvedValue(created);
    const listCvDocuments = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([created]);
    installWorkspaceBridge({ listCvDocuments, createCvDocument });
    const selectAndRead = vi.fn().mockResolvedValue({ fileName: 'resume.pdf', text: 'Angular developer.' });
    installCvBridge({ selectAndRead });

    render(<CvLibraryPage />);
    await waitFor(() => expect(screen.getByText(/no cvs on file/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^upload cv$/i }));
    await waitFor(() => expect(selectAndRead).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('button', { name: /save to cv library/i }));

    await waitFor(() =>
      expect(createCvDocument).toHaveBeenCalledWith({
        name: 'resume.pdf',
        kind: 'uploaded',
        text: 'Angular developer.',
      }),
    );

    await waitFor(() => expect(listCvDocuments).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('resume.pdf')).toBeInTheDocument());
  });

  it('surfaces a load error without crashing', async () => {
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockRejectedValue(new Error('database unreachable')) });
    installCvBridge();

    render(<CvLibraryPage />);

    await waitFor(() => expect(screen.getByText(/database unreachable/i)).toBeInTheDocument());
  });
});
