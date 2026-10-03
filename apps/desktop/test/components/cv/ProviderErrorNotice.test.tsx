import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import type { ProviderId, ProviderStatus } from '@agent-dock/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiOutput } from '../../../src/components/cv/AiOutput.js';
import { ProviderErrorNotice } from '../../../src/components/cv/ProviderErrorNotice.js';
import { resetProviderLimitsForTest, setProviderOverride } from '../../../src/provider-limits.js';
import { useEffectiveProvider } from '../../../src/use-effective-provider.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';

const LIMIT = "You've hit your session limit, resets 12:10pm (Europe/Amsterdam)";

function status(id: ProviderId, overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return { id, name: id === 'claude' ? 'Claude Code' : 'Codex', installed: true, authenticated: 'authenticated', ...overrides } as ProviderStatus;
}

function installProviders(list: ProviderStatus[]) {
  (window as unknown as { agentDock: unknown }).agentDock = {
    listProviders: vi.fn().mockResolvedValue(list),
  };
}

beforeEach(() => {
  resetProviderLimitsForTest();
  setProviderOverride(null);
});
afterEach(() => {
  setProviderOverride(null);
});

describe('ProviderErrorNotice (#461)', () => {
  it('turns a usage limit into a warning with the reset time and says the work was kept', async () => {
    installProviders([status('claude'), status('codex', { installed: false })]);
    render(<ProviderErrorNotice error={LIMIT} providerId="claude" onRetry={vi.fn()} />);

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveClass('alert-warning');
    expect(notice).not.toHaveClass('alert-error');
    expect(notice).toHaveTextContent('Claude Code has reached its usage limit until 12:10pm (Europe/Amsterdam). Your work so far is kept.');
    // The raw text is available, behind Details only.
    const details = within(notice).getByText('Details').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent(LIMIT);
  });

  it('offers the other provider only when it is installed and signed in', async () => {
    installProviders([status('claude'), status('codex', { authenticated: 'unauthenticated' })]);
    const { unmount } = render(<ProviderErrorNotice error={LIMIT} providerId="claude" onRetry={vi.fn()} />);
    await screen.findByRole('alert');
    await waitFor(() => expect((window.agentDock.listProviders as ReturnType<typeof vi.fn>)).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /use codex for now/i })).not.toBeInTheDocument();
    unmount();

    installProviders([status('claude'), status('codex')]);
    render(<ProviderErrorNotice error={LIMIT} providerId="claude" onRetry={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Use Codex for now' })).toBeInTheDocument();
  });

  it('switches for this session only and reruns just the failed step with the new provider', async () => {
    installProviders([status('claude'), status('codex')]);
    installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ defaultProvider: 'claude' }) });
    const runs: ProviderId[] = [];

    function Harness() {
      const { provider } = useEffectiveProvider();
      const [failed] = useState(true);
      return failed ? (
        <ProviderErrorNotice error={LIMIT} providerId={provider} onRetry={() => runs.push(provider)} />
      ) : null;
    }
    render(<Harness />);

    fireEvent.click(await screen.findByRole('button', { name: 'Use Codex for now' }));

    await waitFor(() => expect(runs).toEqual(['codex']));
    // The saved default was never rewritten.
    expect(window.workspace.updateSettings).not.toHaveBeenCalled();
  });

  it('keeps Try again unavailable until a parsed reset time has passed', async () => {
    installProviders([status('claude')]);
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const clock = `${future.getHours() % 12 || 12}:${String(future.getMinutes()).padStart(2, '0')}${future.getHours() >= 12 ? 'pm' : 'am'}`;
    render(<ProviderErrorNotice error={`session limit, resets ${clock} (${local})`} providerId="claude" onRetry={vi.fn()} />);
    const retry = await screen.findByRole('button', { name: /^try again after/i });
    expect(retry).toBeDisabled();
  });

  it('guides a missing sign-in without calling it a usage limit', async () => {
    installProviders([status('claude')]);
    render(<ProviderErrorNotice error="Not logged in. Please run claude login" providerId="claude" onRetry={vi.fn()} />);
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('Claude Code is not signed in');
    expect(notice).not.toHaveTextContent(/usage limit/i);
  });

  it('leaves an unclassified failure as the plain error it was', async () => {
    installProviders([status('claude')]);
    render(<ProviderErrorNotice error="the agent finished without returning any text" providerId="claude" onRetry={vi.fn()} />);
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveClass('alert-error');
    expect(notice).toHaveTextContent('the agent finished without returning any text');
  });
});

describe('AiOutput with a usage limit (#461)', () => {
  it('shows the guided notice and keeps the partial output that was already streamed', async () => {
    installProviders([status('claude')]);
    render(
      <AiOutput
        status="failed"
        text="Partial analysis so far."
        error={LIMIT}
        idleHint="idle"
        busyLabel="busy"
        label="analysis"
        providerId="claude"
        onRetry={vi.fn()}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveClass('alert-warning');
    expect(screen.getByRole('log', { name: 'analysis' })).toHaveTextContent('Partial analysis so far.');
  });
});
