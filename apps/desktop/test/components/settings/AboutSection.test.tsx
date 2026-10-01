import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AboutSection } from '../../../src/components/settings/AboutSection.js';
import { installBridges } from '../../cv-bridges.js';
import { installSystemBridge } from '../../workspace-bridge.js';

/** jsdom has no clipboard implementation, so install one we can assert against. */
function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
  return writeText;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AboutSection', () => {
  it('includes the current daemon status in the copied diagnostics', async () => {
    const writeText = stubClipboard();
    installSystemBridge();
    installBridges({
      agentDock: {
        getDaemonStatus: vi
          .fn()
          .mockResolvedValue({ state: 'unavailable', error: 'daemon failed to start: process exited before starting (code 1, signal null)' }),
      },
    });

    render(<AboutSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = JSON.parse(writeText.mock.calls[0]?.[0] as string) as {
      daemonStatus: unknown;
      route: string;
      generatedAt: string;
    };
    expect(copied.daemonStatus).toEqual({
      state: 'unavailable',
      error: 'daemon failed to start: process exited before starting (code 1, signal null)',
    });
    expect(copied.route).toBe('/');
    expect(copied.generatedAt).toEqual(expect.any(String));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('still copies diagnostics, with a fallback status, when reading daemon status itself fails', async () => {
    const writeText = stubClipboard();
    installSystemBridge();
    installBridges({
      agentDock: { getDaemonStatus: vi.fn().mockRejectedValue(new Error('IPC channel closed')) },
    });

    render(<AboutSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = JSON.parse(writeText.mock.calls[0]?.[0] as string) as { daemonStatus: unknown };
    expect(copied.daemonStatus).toEqual({ state: 'unavailable', error: 'IPC channel closed' });
  });

  it('offers a prefilled GitHub issue link after copying diagnostics', async () => {
    const writeText = stubClipboard();
    installSystemBridge();
    installBridges({
      agentDock: { getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }) },
    });

    render(<AboutSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const link = screen.getByRole('link', { name: 'Open GitHub issue' });
    expect(link).toHaveAttribute('href', expect.stringContaining('/issues/new?'));
    const body = new URL(link.getAttribute('href') ?? '').searchParams.get('body');
    expect(body).toContain('"daemonStatus": {\n    "state": "ready"');
  });

  it('redacts sensitive diagnostics before copying and opening an issue', async () => {
    const writeText = stubClipboard();
    installSystemBridge();
    installBridges({
      agentDock: {
        getDaemonStatus: vi.fn().mockResolvedValue({
          state: 'unavailable',
          error:
            'failed at C:\\Users\\Jake\\AppData\\Local\\Open Vacancy Radar\\agent.log token=secret-123 for jake@example.com',
        }),
      },
    });

    render(<AboutSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toContain('[redacted-path]');
    expect(copied).toContain('token=[redacted-secret]');
    expect(copied).toContain('[redacted-email]');
    expect(copied).not.toContain('C:\\Users\\Jake');
    expect(copied).not.toContain('secret-123');
    expect(copied).not.toContain('jake@example.com');

    const link = screen.getByRole('link', { name: 'Open GitHub issue' });
    const body = new URL(link.getAttribute('href') ?? '').searchParams.get('body') ?? '';
    expect(body).toContain('[redacted-path]');
    expect(body).not.toContain('C:\\Users\\Jake');
  });
});
