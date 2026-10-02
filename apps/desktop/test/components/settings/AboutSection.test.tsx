import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AboutSection } from '../../../src/components/settings/AboutSection.js';
import { installBridges } from '../../cv-bridges.js';
import { installSystemBridge, installVacancyRadarBridge } from '../../workspace-bridge.js';

/** jsdom has no clipboard implementation, so install one we can assert against. */
function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
  return writeText;
}

type Report = {
  daemonStatus: unknown;
  generatedAt: string;
  page: string;
  previousPage: string;
  vacancyEngine: { ready: boolean; error?: string };
  providers: Array<{ id: string; installed: boolean; authenticated: string; ready: boolean }>;
};

async function previewText(): Promise<string> {
  const box = (await screen.findByLabelText('Diagnostics text')) as HTMLTextAreaElement;
  await waitFor(() => expect(box.value).toMatch(/^\{/));
  return box.value;
}

function issueBody(): string {
  const link = screen.getByRole('link', { name: 'Open GitHub issue' });
  return new URL(link.getAttribute('href') ?? '').searchParams.get('body') ?? '';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AboutSection', () => {
  it('shows a read-only preview that includes daemon status, engine status, page and provider states', async () => {
    installSystemBridge();
    installVacancyRadarBridge({ getStatus: vi.fn().mockResolvedValue({ ready: false, error: 'engine failed to open' }) });
    installBridges({
      agentDock: {
        getDaemonStatus: vi
          .fn()
          .mockResolvedValue({ state: 'unavailable', error: 'daemon failed to start: process exited before starting (code 1, signal null)' }),
        listProviders: vi.fn().mockResolvedValue([
          { id: 'claude', name: 'Claude Code', installed: true, authenticated: 'authenticated', capabilities: {} },
          { id: 'codex', name: 'Codex', installed: true, authenticated: 'unauthenticated', capabilities: {} },
        ]),
      },
    });

    render(<AboutSection currentPage="settings" previousPage="search" />);
    const box = (await screen.findByLabelText('Diagnostics text')) as HTMLTextAreaElement;
    expect(box).toHaveAttribute('readonly');
    const report = JSON.parse(await previewText()) as Report;

    expect(report.daemonStatus).toEqual({
      state: 'unavailable',
      error: 'daemon failed to start: process exited before starting (code 1, signal null)',
    });
    expect(report.page).toBe('settings');
    expect(report.previousPage).toBe('search');
    expect(report).not.toHaveProperty('route');
    expect(report.vacancyEngine).toEqual({ ready: false, error: 'engine failed to open' });
    expect(report.providers).toEqual([
      { id: 'claude', installed: true, authenticated: 'authenticated', ready: true },
      { id: 'codex', installed: true, authenticated: 'unauthenticated', ready: false },
    ]);
    expect(report.generatedAt).toEqual(expect.any(String));
  });

  it('reports a ready engine without an error field', async () => {
    installSystemBridge();
    installVacancyRadarBridge({ getStatus: vi.fn().mockResolvedValue({ ready: true }) });
    installBridges();

    render(<AboutSection currentPage="settings" />);
    const report = JSON.parse(await previewText()) as Report;
    expect(report.vacancyEngine).toEqual({ ready: true });
    expect(report.previousPage).toBe('none');
  });

  it('still builds a report, with fallback entries, when the status reads themselves fail', async () => {
    installSystemBridge();
    installVacancyRadarBridge({ getStatus: vi.fn().mockRejectedValue(new Error('engine IPC closed')) });
    installBridges({
      agentDock: {
        getDaemonStatus: vi.fn().mockRejectedValue(new Error('IPC channel closed')),
        listProviders: vi.fn().mockRejectedValue(new Error('providers IPC closed')),
      },
    });

    render(<AboutSection currentPage="settings" />);
    const report = JSON.parse(await previewText()) as Report & { providers: unknown };
    expect(report.daemonStatus).toEqual({ state: 'unavailable', error: 'IPC channel closed' });
    expect(report.vacancyEngine).toEqual({ ready: false, error: 'engine IPC closed' });
    expect(report.providers).toEqual({ error: 'providers IPC closed' });
  });

  it('copies exactly the previewed text', async () => {
    const writeText = stubClipboard();
    installSystemBridge();
    installVacancyRadarBridge({ getStatus: vi.fn().mockResolvedValue({ ready: true }) });
    installBridges();

    render(<AboutSection currentPage="settings" />);
    const shown = await previewText();
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toBe(shown);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('opens the GitHub issue with exactly the previewed text, without clicking Copy first', async () => {
    installSystemBridge();
    installVacancyRadarBridge({ getStatus: vi.fn().mockResolvedValue({ ready: false, error: 'engine locked' }) });
    installBridges({ agentDock: { getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }) } });

    render(<AboutSection currentPage="settings" />);
    const shown = await previewText();

    const link = screen.getByRole('link', { name: 'Open GitHub issue' });
    expect(link).toHaveAttribute('href', expect.stringContaining('/issues/new?'));
    expect(issueBody()).toContain('```json\n' + shown + '\n```');
    expect(issueBody()).not.toContain('Click Copy diagnostics first');
    expect(shown).toContain('"state": "ready"');
    expect(shown).toContain('engine locked');
  });

  it('refreshes the preview with fresh status, and the issue link follows it', async () => {
    // The preview is built on mount and again once the version arrives, so flip the answer by an
    // explicit switch rather than by call count.
    let engineDown = false;
    const getStatus = vi.fn(async () => (engineDown ? { ready: false, error: 'engine went down' } : { ready: true }));
    installSystemBridge();
    installVacancyRadarBridge({ getStatus });
    installBridges();

    render(<AboutSection currentPage="settings" />);
    expect(JSON.parse(await previewText()).vacancyEngine).toEqual({ ready: true });

    engineDown = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
    await waitFor(async () => {
      const box = screen.getByLabelText('Diagnostics text') as HTMLTextAreaElement;
      expect(box.value).toContain('engine went down');
    });
    const shown = (screen.getByLabelText('Diagnostics text') as HTMLTextAreaElement).value;
    expect(issueBody()).toContain(shown);
  });

  it('removes paths, home directories, token URLs and bearer tokens from the preview, the copy and the issue', async () => {
    const writeText = stubClipboard();
    installSystemBridge();
    installVacancyRadarBridge({
      getStatus: vi.fn().mockResolvedValue({
        ready: false,
        error:
          'cannot open C:\\Users\\Jake\\AppData\\Roaming\\Open Vacancy Radar\\vacancies.db and /Users/jake/Library/data.db, ' +
          'fetched https://example.test/callback?token=abc123secret&x=1 with Authorization: Bearer abcDEF123456.tokenvalue',
      }),
    });
    installBridges();

    render(<AboutSection currentPage="settings" />);
    const shown = await previewText();

    for (const leaked of ['C:\\Users', 'Jake', '/Users/jake', 'abc123secret', 'example.test', 'abcDEF123456', 'tokenvalue']) {
      expect(shown).not.toContain(leaked);
    }
    expect(shown).toContain('[redacted-path]');
    expect(shown).toContain('[redacted-url]');
    expect(shown).toContain('Bearer [redacted-token]');

    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toBe(shown);
    expect(issueBody()).not.toMatch(/abc123secret|C:\\Users|\/Users\/jake|abcDEF123456/);
  });
});
