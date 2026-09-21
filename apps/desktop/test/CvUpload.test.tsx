import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryVacancyAudit } from '@open-vacancy-radar/vacancy-engine';
import { CvUpload } from '../src/components/cv/CvUpload.js';
import type { VacancyLead } from '../src/components/cv/types.js';
import { installBridges } from './cv-bridges.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Compile-time contract, not a runtime one: the Vacancy Leads screen will hand these components a
 * `DiscoveryVacancyAudit` straight from the engine, so if that type ever stops satisfying
 * `VacancyLead` this file fails `pnpm typecheck`, before anyone wires the screens together.
 */
const _assignabilityCheck = (audit: DiscoveryVacancyAudit): VacancyLead => audit;
void _assignabilityCheck;

describe('CvUpload', () => {
  it('reads the picked CV through the bridge and reports the file name and character count', async () => {
    const bridges = installBridges({
      cv: {
        selectAndRead: vi
          .fn()
          .mockResolvedValue({ status: 'ok', fileName: 'jake-cv.pdf', text: 'a'.repeat(1234) }),
      },
    });
    const onCvChange = vi.fn();

    render(<CvUpload cv={null} onCvChange={onCvChange} providerLabel="Claude Code" />);
    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));

    await waitFor(() =>
      expect(onCvChange).toHaveBeenCalledWith({
        fileName: 'jake-cv.pdf',
        text: 'a'.repeat(1234),
        textSource: 'text_layer',
      }),
    );
    expect(bridges.cv.selectAndRead).toHaveBeenCalledTimes(1);

    render(
      <CvUpload
        cv={{ fileName: 'jake-cv.pdf', text: 'a'.repeat(1234) }}
        onCvChange={onCvChange}
        providerLabel="Claude Code"
      />,
    );
    expect(await screen.findByText(/jake-cv\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/1,234 characters/)).toBeInTheDocument();
  });

  it("names the actually-configured provider, not a hardcoded Claude Code, in the CLI disclosure", async () => {
    installBridges();
    render(<CvUpload cv={null} onCvChange={vi.fn()} providerLabel="Codex" />);

    expect(screen.getByText(/your own Codex CLI/)).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code CLI/)).not.toBeInTheDocument();
  });

  it('treats a cancelled dialog as a no-op: no CV change, no error banner', async () => {
    installBridges({ cv: { selectAndRead: vi.fn().mockResolvedValue(null) } });
    const onCvChange = vi.fn();

    render(<CvUpload cv={null} onCvChange={onCvChange} providerLabel="Claude Code" />);
    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));

    await waitFor(() => expect(screen.queryByText(/reading and extracting/i)).not.toBeInTheDocument());
    expect(onCvChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces an extraction failure with the underlying reason, unwrapped from the IPC prefix', async () => {
    installBridges({
      cv: {
        selectAndRead: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "Error invoking remote method 'cv:select-and-read': Error: no selectable text found in \"scan.pdf\"",
            ),
          ),
      },
    });

    render(<CvUpload cv={null} onCvChange={vi.fn()} providerLabel="Claude Code" />);
    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('no selectable text found in "scan.pdf"');
    expect(alert).not.toHaveTextContent('invoking remote method');
  });

  it('can show and hide the extracted text so the user can verify the PDF parsed sensibly', async () => {
    installBridges();
    render(
      <CvUpload
        cv={{ fileName: 'cv.md', text: 'Frontend architect, Angular.' }}
        onCvChange={vi.fn()}
        providerLabel="Claude Code"
      />,
    );

    expect(screen.queryByText('Frontend architect, Angular.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show extracted text/i }));
    expect(await screen.findByText('Frontend architect, Angular.')).toBeInTheDocument();
  });

  it('drives the full scanned-PDF fallback end to end: transcription, review, then save (issue #396)', async () => {
    // Consent for this feature is a native `dialog.showMessageBox` main.ts shows from
    // `cv:select-and-read` itself, before that IPC call ever resolves -- not a renderer-drawn
    // dialog this component renders (see `useCvPicker.ts`'s own doc comment for why). So by the
    // time `selectAndRead` resolves with `'scanned-pdf'` here, the user has already consented; this
    // test starts from that point and drives transcription, review, and save.
    const bridges = installBridges({
      cv: {
        selectAndRead: vi.fn().mockResolvedValue({
          status: 'scanned-pdf',
          fileName: 'scan.pdf',
          pageCount: 2,
          candidateId: 'candidate-e2e',
        }),
      },
    });
    const onCvChange = vi.fn();

    render(<CvUpload cv={null} onCvChange={onCvChange} providerLabel="Claude Code" />);
    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));

    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    expect(vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0]).toMatchObject({
      attachmentCandidateId: 'candidate-e2e',
    });
    expect(await screen.findByText(/transcribing/i)).toBeInTheDocument();

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Jake Ortega. Angular architect.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    const textarea = await screen.findByLabelText(/transcribed cv text/i);
    expect(textarea).toHaveValue('Jake Ortega. Angular architect.');

    fireEvent.click(screen.getByRole('button', { name: /looks correct, use this text/i }));

    await waitFor(() =>
      expect(onCvChange).toHaveBeenCalledWith({
        fileName: 'scan.pdf',
        text: 'Jake Ortega. Angular architect.',
        textSource: 'ai_transcription',
      }),
    );
  });

  it('shows the unavailable guidance and dismisses it, for a scanned PDF main declined to offer transcription for', async () => {
    installBridges({
      cv: {
        selectAndRead: vi
          .fn()
          .mockResolvedValue({ status: 'scanned-pdf-unavailable', fileName: 'scan.pdf', pageCount: 40, reason: 'too-many-pages' }),
      },
    });

    render(<CvUpload cv={null} onCvChange={vi.fn()} providerLabel="Claude Code" />);
    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/too many pages/i);

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
