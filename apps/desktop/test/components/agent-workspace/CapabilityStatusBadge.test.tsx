import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityStatusBadge } from '../../../src/components/agent-workspace/CapabilityStatusBadge.js';
import { NewSessionPanel } from '../../../src/components/agent-workspace/NewSessionPanel.js';

describe('CapabilityStatusBadge', () => {
  it('shows its label and puts the detail in the tooltip', () => {
    render(<CapabilityStatusBadge status="partial" label="Some paths only" detail="Works on one runtime." />);
    const badge = screen.getByTestId('capability-status-badge');
    expect(badge.textContent).toBe('Some paths only');
    expect(badge.getAttribute('title')).toBe('Works on one runtime.');
    expect(badge.getAttribute('data-status')).toBe('partial');
  });
});

describe('NewSessionPanel capability honesty (#164)', () => {
  it('says the folder is where the agent starts, not a limit on it', () => {
    render(
      <NewSessionPanel
        pendingStarts={{}}
        capacity={undefined}
        defaultProvider="claude"
        newClientKey={() => 'k'}
        onStart={vi.fn()}
        onDismiss={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.getByTestId('capability-status-badge').textContent).toBe('Not limited to the folder');
    expect(screen.queryByText(/works only in the folder/i)).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('—');
  });
});
