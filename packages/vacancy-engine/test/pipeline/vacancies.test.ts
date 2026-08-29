import { describe, expect, it } from 'vitest';

import { AtsResponseError } from '../../src/ats/http.js';
import {
  categorizeSourceError,
  NetworkRequestAttribution,
} from '../../src/pipeline/vacancies.js';

describe('per-source physical request attribution', () => {
  it('keeps concurrent source counts isolated across asynchronous boundaries', async () => {
    const attribution = new NetworkRequestAttribution();

    await Promise.all([
      attribution.runForSource('source-a', async () => {
        attribution.recordNetworkRequest();
        await Promise.resolve();
        attribution.recordNetworkRequest();
      }),
      attribution.runForSource('source-b', async () => {
        await Promise.resolve();
        attribution.recordNetworkRequest();
      }),
    ]);
    attribution.recordNetworkRequest();

    expect(attribution.countForSource('source-a')).toBe(2);
    expect(attribution.countForSource('source-b')).toBe(1);
    expect(attribution.total).toBe(4);
  });
});

describe('adapter error categorization', () => {
  it.each([403, 406])('records adapter-detected access challenge %i as blocked', (status) => {
    expect(
      categorizeSourceError(new AtsResponseError('json_ld', 'access challenge', status)),
    ).toEqual({
      category: 'blocked',
      httpStatus: status,
      message: 'json_ld: access challenge',
    });
  });
});
