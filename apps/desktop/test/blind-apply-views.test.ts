// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { blindFilterLines, candidateFromAuditRow, excludedCompaniesFromSnapshot } from '../electron/blind-apply-views.js';

describe('Blind Apply confirmation lines and snapshot (#736)', () => {
  it('names the excluded companies in the confirmation, and says nothing when there are none', () => {
    expect(blindFilterLines({ excludedCompanies: [{ name: 'Acme', domains: ['acme.com'] }, { name: 'Northwind', domains: [] }] })).toEqual([
      'Excluded companies: Acme, Northwind',
    ]);
    expect(blindFilterLines({ excludedCompanies: [] })).toEqual([]);
    expect(blindFilterLines({})).toEqual([]);
  });

  it('reads the list back from a stored snapshot, tolerating an older snapshot and malformed entries', () => {
    expect(excludedCompaniesFromSnapshot({ country: 'PT' })).toEqual([]);
    expect(excludedCompaniesFromSnapshot({ excludedCompanies: 'Acme' })).toEqual([]);
    expect(
      excludedCompaniesFromSnapshot({
        excludedCompanies: [{ name: 'Acme', domains: ['acme.com', 7] }, { name: '  ' }, { domains: ['x.com'] }, null, 'Acme'],
      }),
    ).toEqual([{ name: 'Acme', domains: ['acme.com'] }]);
  });

  it('keeps the listing URL on the candidate so a domain alias can match it even when the apply link differs', () => {
    const candidate = candidateFromAuditRow({
      key: 'k',
      company: 'Acme',
      title: 'Frontend Engineer',
      url: 'https://careers.acme.example/jobs/1',
      decision: 'official_review_candidate',
      applyUrl: { status: 'verified', url: 'https://boards.ats.example/acme/1' },
    });
    expect(candidate).toMatchObject({ applyUrl: 'https://boards.ats.example/acme/1', listingUrl: 'https://careers.acme.example/jobs/1' });
  });
});
