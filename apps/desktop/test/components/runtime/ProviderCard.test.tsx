import { render, screen } from '@testing-library/react';
import type { ProviderStatus } from '@agent-dock/shared';
import { describe, expect, it } from 'vitest';
import { ProviderCard } from '../../../src/components/runtime/ProviderCard.js';

const READY = { id: 'claude', name: 'Claude Code', installed: true, authenticated: 'authenticated', version: '1.0.0' } as ProviderStatus;

describe('ProviderCard usage limit (#461)', () => {
  it('says ready when nothing reported a limit', () => {
    render(<ProviderCard status={READY} isDefault saving={false} onUseAsDefault={() => undefined} />);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText(/limit/i)).not.toBeInTheDocument();
  });

  it('reflects a reported limit and its reset time instead of a plain Ready', () => {
    render(
      <ProviderCard
        status={READY}
        isDefault
        saving={false}
        onUseAsDefault={() => undefined}
        limit={{ provider: 'claude', reachedAt: 1, resetLabel: '12:10pm (Europe/Amsterdam)' }}
      />,
    );
    expect(screen.getByText('Usage limit reached')).toBeInTheDocument();
    expect(screen.getByText('Limit reached, resets 12:10pm (Europe/Amsterdam)')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });

  it('does not let a limit hide a provider that is not installed', () => {
    render(
      <ProviderCard
        status={{ ...READY, installed: false } as ProviderStatus}
        isDefault={false}
        saving={false}
        onUseAsDefault={() => undefined}
        limit={{ provider: 'claude', reachedAt: 1 }}
      />,
    );
    expect(screen.getByText('Not installed')).toBeInTheDocument();
  });
});
