import { describe, expect, it } from 'vitest';

import {
  type SponsorSnapshotTransition,
  validateSponsorSnapshotTransition,
} from '../../src/ind/repository.js';

function transition(
  overrides: Partial<SponsorSnapshotTransition> = {},
): SponsorSnapshotTransition {
  return {
    sourceLastUpdated: new Date('2026-08-03T00:00:00.000Z'),
    uniqueSponsorCount: 12_000,
    membershipHash: 'a'.repeat(64),
    ...overrides,
  };
}

describe('official sponsor snapshot transition safety', () => {
  it('rejects an implausibly small initial snapshot', () => {
    expect(
      validateSponsorSnapshotTransition(null, transition({ uniqueSponsorCount: 9_999 })),
    ).toContain('implausible_sponsor_count');
  });

  it('rejects a declared source-date regression', () => {
    const previous = transition({
      sourceLastUpdated: new Date('2026-08-03T00:00:00.000Z'),
    });
    const next = transition({
      sourceLastUpdated: new Date('2026-08-02T00:00:00.000Z'),
    });

    expect(validateSponsorSnapshotTransition(previous, next)).toContain('source_date_regression');
  });

  it('rejects a sponsor-count drop of exactly ten percent', () => {
    const previous = transition({ uniqueSponsorCount: 12_000 });
    const next = transition({
      sourceLastUpdated: new Date('2026-08-04T00:00:00.000Z'),
      uniqueSponsorCount: 10_800,
    });

    expect(validateSponsorSnapshotTransition(previous, next)).toContain('sponsor_count_drop');
  });

  it('rejects a membership change under the same declared source date', () => {
    const previous = transition({ membershipHash: 'a'.repeat(64) });
    const next = transition({ membershipHash: 'b'.repeat(64) });

    expect(validateSponsorSnapshotTransition(previous, next)).toContain(
      'same_date_membership_change',
    );
  });

  it('accepts a plausible later snapshot and a stable same-date snapshot', () => {
    const previous = transition();
    const later = transition({
      sourceLastUpdated: new Date('2026-08-04T00:00:00.000Z'),
      uniqueSponsorCount: 11_001,
      membershipHash: 'b'.repeat(64),
    });

    expect(validateSponsorSnapshotTransition(previous, later)).toBeNull();
    expect(validateSponsorSnapshotTransition(previous, transition())).toBeNull();
  });
});
