import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LetterVersionRecord } from '../../../src/window.js';
import { LetterPreview } from '../../../src/components/letters/index.js';
import { buildLetterPdf } from '../../../src/components/letters/export.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';
import { makeLetter } from './fixtures.js';

const drawn: Uint8Array[] = [];
vi.mock('../../../src/components/cv/pdf-pages.js', () => ({
  openPdfForReview: vi.fn(async (bytes: Uint8Array) => {
    drawn.push(bytes);
    return {
      pageCount: 1,
      renderPage: async () => undefined,
      extractText: async () => 'page text',
      destroy: async () => undefined,
    };
  }),
}));

function version(n: number, body: string): LetterVersionRecord {
  return {
    id: `v${n}`,
    letterId: 'letter-1',
    version: n,
    title: 'Redwood cover',
    type: 'cover_letter',
    tone: 'natural',
    length: 'standard',
    cvId: null,
    body,
    contentHash: `${n}`.repeat(64),
    createdAt: `2026-08-2${n}T10:00:00.000Z`,
  };
}

const letter = makeLetter({ title: 'Redwood cover', body: 'Second text.', currentVersionId: 'v2', currentVersion: 2 });
const versions = [version(1, 'First text.'), version(2, 'Second text.')];

function setup(overrides: Record<string, unknown> = {}) {
  const saveFile = vi.fn().mockResolvedValue({ saved: true, path: '/tmp/Redwood cover.pdf' });
  installWorkspaceBridge({
    listLetterVersions: vi.fn().mockResolvedValue(versions),
    listLetterUsage: vi.fn().mockResolvedValue([
      { kind: 'recorded', applicationId: 'app-1', attemptId: null, company: 'Redwood', role: 'Engineer', versionId: 'v1', version: 1, provenance: 'user_confirmed', at: '2026-08-22T10:00:00.000Z' },
      { kind: 'linked', applicationId: 'app-2', attemptId: null, company: 'Freeday', role: 'Analyst', versionId: null, version: null, provenance: null, at: null },
    ]),
    ...overrides,
  });
  Object.defineProperty(window, 'system', { configurable: true, value: { ...(window as unknown as { system?: object }).system, saveFile } });
  return { saveFile };
}

afterEach(() => {
  drawn.length = 0;
  vi.restoreAllMocks();
});

describe('LetterPreview (#738)', () => {
  it('draws the current version and Export PDF saves exactly the bytes that were drawn', async () => {
    const { saveFile } = setup();
    render(<LetterPreview letter={letter} onBack={vi.fn()} onEdit={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByTestId('letter-preview-pages');
    expect(screen.getByRole('combobox', { name: /version/i })).toHaveValue('v2');

    fireEvent.click(screen.getByRole('button', { name: /export pdf/i }));
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    const saved = Buffer.from(saveFile.mock.calls[0]![0].data as string, 'base64');
    expect(Buffer.from(drawn.at(-1)!).equals(saved)).toBe(true);
    // And it is the same PDF the same version always builds.
    expect(Buffer.from(buildLetterPdf('Redwood cover', 'Second text.', { createdAt: versions[1]!.createdAt, contentHash: versions[1]!.contentHash })).equals(saved)).toBe(true);
  });

  it('lists the applications that used the letter with version and provenance', async () => {
    setup();
    render(<LetterPreview letter={letter} onBack={vi.fn()} onEdit={vi.fn()} onChanged={vi.fn()} />);
    const usedIn = await screen.findByRole('complementary', { name: 'Used in' });
    await waitFor(() => expect(within(usedIn).getByText(/On record, version 1 \(you confirmed you sent it\)/)).toBeInTheDocument());
    expect(within(usedIn).getByText('Linked only, no send recorded')).toBeInTheDocument();
    expect(within(usedIn).getByText('Engineer at Redwood')).toBeInTheDocument();
  });

  it('an older version is read-only; restoring it saves it as a new version', async () => {
    const restored = { ...letter, body: 'First text.', currentVersionId: 'v3', currentVersion: 3 };
    const restoreLetterVersion = vi.fn().mockResolvedValue(restored);
    const onChanged = vi.fn();
    const onEdit = vi.fn();
    setup({ restoreLetterVersion });
    render(<LetterPreview letter={letter} initialVersionId="v1" onBack={vi.fn()} onEdit={onEdit} onChanged={onChanged} />);
    await screen.findByTestId('letter-preview-pages');
    expect(screen.getByText('Older version, read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /restore this version/i }));
    await waitFor(() => expect(restoreLetterVersion).toHaveBeenCalledWith('letter-1', 'v1'));
    expect(onChanged).toHaveBeenCalledWith(restored);
    expect(await screen.findByText(/saved as version 3/i)).toBeInTheDocument();
  });

  it('says so when a requested version is no longer on record, and shows the current one', async () => {
    setup();
    render(<LetterPreview letter={letter} initialVersionId="gone" onBack={vi.fn()} onEdit={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByText(/no longer on record/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /version/i })).toHaveValue('v2');
  });
});

describe('buildLetterPdf', () => {
  it('builds identical bytes for the same pinned version', () => {
    const pin = { createdAt: '2026-08-21T10:00:00.000Z', contentHash: 'ab'.repeat(32) };
    expect(Buffer.from(buildLetterPdf('T', 'Body.', pin)).equals(Buffer.from(buildLetterPdf('T', 'Body.', pin)))).toBe(true);
  });
});
