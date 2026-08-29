import { describe, expect, it } from 'vitest';

import { deriveCampaignSourceScanResult } from '../../src/pipeline/company-campaign.js';

describe('company campaign source-scan outcome precedence', () => {
  it('uses a successful current source scan even when another source failed', () => {
    expect(
      deriveCampaignSourceScanResult([
        { status: 'failed', vacanciesSeen: 0 },
        { status: 'succeeded', vacanciesSeen: 12 },
      ]),
    ).toEqual({ outcome: 'active', reasonCode: 'vacancies_scanned' });
  });

  it.each([
    ['blocked', 'blocked', 'source_scan_blocked'],
    ['failed', 'error', 'source_scan_failed'],
    ['manual_review', 'manual_review', 'source_scan_manual_review'],
    ['unsupported', 'unsupported', 'source_scan_unsupported'],
  ] as const)('maps a current %s source outcome to %s', (status, outcome, reasonCode) => {
    expect(deriveCampaignSourceScanResult([{ status, vacanciesSeen: 0 }])).toEqual({
      outcome,
      reasonCode,
    });
  });
});
