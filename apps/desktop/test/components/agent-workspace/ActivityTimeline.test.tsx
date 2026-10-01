import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '../../../src/window.js';
import { ActivityTimeline } from '../../../src/components/agent-workspace/index.js';
import { EMPTY_TIMELINE, insertEntry } from '../../../src/components/agent-workspace/timeline.js';
import type { SessionEntry } from '../../../src/components/agent-workspace/workspace-reducer.js';
import { sessionSummary, SESSION_A } from '../../agent-workspace-bridges.js';

/**
 * Render coverage for the `usage.rate_limits` row (ADI-26), which had none: the two bugs this file
 * guards against -- unrounded float percentages and a `RangeError` from an unrepresentable
 * `resetsAt` -- both slipped past every other test in this PR because every fixture elsewhere uses
 * round percentages and small, valid `resetsAt` values.
 */

function entryWith(item: ActivityEntry): SessionEntry {
  return {
    view: sessionSummary(SESSION_A),
    timeline: insertEntry(EMPTY_TIMELINE, item),
    historyComplete: true,
    liveStatus: 'live',
    unread: 0,
    archived: false,
    toolNamesByAlias: {},
  };
}

describe('ActivityTimeline: usage.rate_limits rendering (ADI-26)', () => {
  it('rounds a computed percentage rather than showing raw floating-point noise', () => {
    const entry = entryWith({
      seq: 0,
      at: 't',
      origin: 'live',
      kind: 'usage.rate_limits',
      primary: { usedPercent: 2.3166666666666664 },
    });
    render(<ActivityTimeline sessionId={SESSION_A} entry={entry} />);

    const text = screen.getByTestId('activity-timeline').textContent ?? '';
    expect(text).toContain('2.3% used');
    expect(text).toContain('97.7% remaining');
    expect(text).not.toContain('2.3166666666666664');
  });

  it('does not throw when resetsAt is far outside the representable Date range', () => {
    const entry = entryWith({
      seq: 0,
      at: 't',
      origin: 'live',
      kind: 'usage.rate_limits',
      primary: { usedPercent: 50, resetsAt: 999_999_999_999_999 },
    });

    expect(() => render(<ActivityTimeline sessionId={SESSION_A} entry={entry} />)).not.toThrow();
    expect(screen.getByTestId('activity-timeline').textContent).toContain('50% used');
  });
});
