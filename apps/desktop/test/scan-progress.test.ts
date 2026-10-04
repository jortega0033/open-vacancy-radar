import { describe, expect, it } from 'vitest';
import { describeScanProgress, formatElapsed } from '../src/components/search/scan-progress.js';

describe('describeScanProgress (#459)', () => {
  const started = 1_000_000;

  it('draws a real fraction from completed source groups and shows elapsed time and rows', () => {
    const view = describeScanProgress(
      { scanning: true, scanId: 's1', startedAt: started, sourcesDone: 4, sourcesTotal: 11, vacanciesSoFar: 212 },
      started + 102_000,
    );
    expect(view.headline).toBe('Checked 4 of 11 source groups');
    expect(view.fraction).toBeCloseTo(4 / 11);
    expect(view.elapsed).toBe('1:42');
    expect(view.vacancies).toBe('212 listings checked');
  });

  it('is indeterminate before the first event, rather than inventing a fraction', () => {
    const view = describeScanProgress({ scanning: true, scanId: 's1', startedAt: started }, started + 5_000);
    expect(view.fraction).toBeNull();
    expect(view.headline).toBe('Starting the scan…');
    expect(view.elapsed).toBe('0:05');
    expect(view.vacancies).toBeNull();
  });

  it('is indeterminate again once every group has reported and the run is matching sponsors', () => {
    const view = describeScanProgress(
      { scanning: true, scanId: 's1', startedAt: started, sourcesDone: 11, sourcesTotal: 11, vacanciesSoFar: 1 },
      started + 200_000,
    );
    expect(view.fraction).toBeNull();
    expect(view.headline).toMatch(/all 11 source groups checked/i);
    expect(view.vacancies).toBe('1 listing checked');
  });

  it('says it is stopping, and shows no fraction, while a stop winds down', () => {
    const view = describeScanProgress(
      { scanning: true, scanId: 's1', startedAt: started, sourcesDone: 4, sourcesTotal: 11, stopping: true },
      started + 10_000,
    );
    expect(view.headline).toBe('Stopping the scan…');
    expect(view.fraction).toBeNull();
  });

  it('formats elapsed time as m:ss and never negative', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(-5_000)).toBe('0:00');
  });
});
