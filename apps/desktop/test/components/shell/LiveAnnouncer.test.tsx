import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LiveAnnouncerProvider, useAnnounce } from '../../../src/components/shell/index.js';
import {
  PROGRESS_ANNOUNCE_STEP,
  progressAnnouncement,
  scanFinishedAnnouncement,
} from '../../../src/components/search/scan-announcements.js';

let announceRef: (text: string) => void = () => {};
function Capture() {
  announceRef = useAnnounce();
  return null;
}

describe('LiveAnnouncer', () => {
  it('mounts the polite region before any text exists and updates it on announce', () => {
    render(
      <LiveAnnouncerProvider>
        <Capture />
      </LiveAnnouncerProvider>,
    );
    const region = screen.getByTestId('live-announcer');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');

    act(() => announceRef('Scan started'));
    expect(region).toHaveTextContent('Scan started');
  });

  it('changes the region content when the same text is announced twice', () => {
    render(
      <LiveAnnouncerProvider>
        <Capture />
      </LiveAnnouncerProvider>,
    );
    const region = screen.getByTestId('live-announcer');
    act(() => announceRef('Scan started'));
    const first = region.textContent;
    act(() => announceRef('Scan started'));
    expect(region.textContent).not.toBe(first);
  });

  it('is a no-op outside a provider', () => {
    render(<Capture />);
    expect(() => announceRef('anything')).not.toThrow();
  });
});

describe('scan announcement text', () => {
  it('speaks progress only after a full step of new arrivals', () => {
    expect(progressAnnouncement(PROGRESS_ANNOUNCE_STEP - 1, 0)).toBeUndefined();
    expect(progressAnnouncement(PROGRESS_ANNOUNCE_STEP, 0)).toBe('40 live vacancies so far');
    expect(progressAnnouncement(PROGRESS_ANNOUNCE_STEP + 5, PROGRESS_ANNOUNCE_STEP)).toBeUndefined();
    expect(progressAnnouncement(80, 40)).toBe('80 live vacancies so far');
  });

  it('words the finish with the vacancy count', () => {
    expect(scanFinishedAnnouncement(273)).toBe('Scan finished, 273 vacancies');
    expect(scanFinishedAnnouncement(1)).toBe('Scan finished, 1 vacancy');
  });
});
