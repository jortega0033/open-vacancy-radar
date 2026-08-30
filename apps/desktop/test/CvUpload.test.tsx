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
      cv: { selectAndRead: vi.fn().mockResolvedValue({ fileName: 'jake-cv.pdf', text: 'a'.repeat(1234) }) },
    });
    const onCvChange = vi.fn();

    render(<CvUpload cv={null} onCvChange={onCvChange} />);
    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));

    await waitFor(() =>
      expect(onCvChange).toHaveBeenCalledWith({ fileName: 'jake-cv.pdf', text: 'a'.repeat(1234) }),
    );
    expect(bridges.cv.selectAndRead).toHaveBeenCalledTimes(1);

    render(<CvUpload cv={{ fileName: 'jake-cv.pdf', text: 'a'.repeat(1234) }} onCvChange={onCvChange} />);
    expect(await screen.findByText(/jake-cv\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/1,234 characters/)).toBeInTheDocument();
  });

  it('treats a cancelled dialog as a no-op: no CV change, no error banner', async () => {
    installBridges({ cv: { selectAndRead: vi.fn().mockResolvedValue(null) } });
    const onCvChange = vi.fn();

    render(<CvUpload cv={null} onCvChange={onCvChange} />);
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

    render(<CvUpload cv={null} onCvChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('no selectable text found in "scan.pdf"');
    expect(alert).not.toHaveTextContent('invoking remote method');
  });

  it('can show and hide the extracted text so the user can verify the PDF parsed sensibly', async () => {
    installBridges();
    render(<CvUpload cv={{ fileName: 'cv.md', text: 'Frontend architect, Angular.' }} onCvChange={vi.fn()} />);

    expect(screen.queryByText('Frontend architect, Angular.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show extracted text/i }));
    expect(await screen.findByText('Frontend architect, Angular.')).toBeInTheDocument();
  });
});
