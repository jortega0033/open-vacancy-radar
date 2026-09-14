import { describe, expect, it } from 'vitest';
import {
  discoveryAudit,
  isoPostedAt,
  isoPostedAtFromUnixSeconds,
  parseSalaryText,
  stringValue,
} from '../../src/global-remote/discovery-shared.js';

describe('discoveryAudit', () => {
  const baseInput = {
    key: 'himalayas:abc123',
    provider: 'himalayas' as const,
    company: 'Acme Inc.',
    title: 'Senior Frontend Engineer',
    location: 'Remote',
    employmentType: null,
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    raw: { id: 'abc123' },
    minimumAnnualBaseUsd: null,
  };

  it('sets sourceUrl to the same value as url, and leaves url itself unchanged (issue #278)', () => {
    const url = 'https://job-boards.greenhouse.io/acme/jobs/555000';
    const audit = discoveryAudit({ ...baseInput, url });
    expect(audit.url).toBe(url);
    expect(audit.sourceUrl).toBe(url);
  });

  it('resolves a requisition identity and a verified applyUrl for a recognized direct-ATS URL', () => {
    const url = 'https://job-boards.greenhouse.io/acme/jobs/555000';
    const audit = discoveryAudit({ ...baseInput, url });
    expect(audit.identity).toEqual({
      kind: 'requisition',
      key: 'greenhouse:acme:555000',
      employerKey: 'greenhouse:acme',
      requisitionId: '555000',
    });
    expect(audit.applyUrl).toMatchObject({ status: 'verified', url });
  });

  it('resolves an unresolved applyUrl for a generic careers page, and still returns a complete row', () => {
    const url = 'https://acme.com/careers';
    const audit = discoveryAudit({ ...baseInput, url });
    expect(audit.identity?.kind).toBe('semantic');
    expect(audit.applyUrl).toMatchObject({ status: 'unresolved', url });
    expect(audit.title).toBe(baseInput.title);
    expect(audit.company).toBe(baseInput.company);
  });

  it('records exactly one self-referencing source', () => {
    const url = 'https://job-boards.greenhouse.io/acme/jobs/555000';
    const audit = discoveryAudit({ ...baseInput, url });
    expect(audit.sources).toEqual([{ provider: 'himalayas', key: baseInput.key, url }]);
  });

  it('never changes the caller-supplied key, unaffected by identity resolution', () => {
    const url = 'https://acme.com/careers';
    const audit = discoveryAudit({ ...baseInput, url });
    expect(audit.key).toBe(baseInput.key);
  });

  it('records audited annual salary fields without applying FX', () => {
    const audit = discoveryAudit({
      ...baseInput,
      url: 'https://acme.com/jobs/123',
      currency: 'usd',
      salaryPeriod: 'month',
      advertisedMinimum: 10_000,
      salaryProvenance: 'reviewed_structured',
    });
    expect(audit).toMatchObject({
      advertisedMinimum: 10_000,
      normalizedAnnualMinimum: 120_000,
      normalizedCurrency: 'USD',
      normalizationMethod: 'monthly_to_annual',
      salaryProvenance: 'reviewed_structured',
      salaryProvider: 'himalayas',
      salarySourceKey: baseInput.key,
      salarySourceUrl: 'https://acme.com/jobs/123',
    });
  });

  it('does not normalize numbers loosely extracted from descriptions', () => {
    const looseSalary = parseSalaryText('15,000 employees. Estimated EUR 70,000 per year.');
    const audit = discoveryAudit({
      ...baseInput,
      url: 'https://acme.com/jobs/estimated',
      currency: looseSalary.currency,
      salaryPeriod: looseSalary.period,
      advertisedMinimum: looseSalary.minimum,
      salaryProvenance: 'loose_text',
      description: '15,000 employees. Estimated EUR 70,000 per year.',
    });
    expect(audit).toMatchObject({
      advertisedMinimum: 15_000,
      normalizedAnnualMinimum: null,
      normalizedCurrency: null,
      normalizationMethod: 'unreviewed_source',
      salaryProvenance: 'loose_text',
    });
  });
});

describe('stringValue', () => {
  it('returns null for non-string and empty/whitespace-only values', () => {
    expect(stringValue(null)).toBeNull();
    expect(stringValue(undefined)).toBeNull();
    expect(stringValue(42)).toBeNull();
    expect(stringValue('   ')).toBeNull();
  });

  it('trims and passes through a plain string unchanged', () => {
    expect(stringValue('  Senior Engineer  ')).toBe('Senior Engineer');
  });

  // QA regression: a real vacancy title from an upstream feed rendered literally as
  // "J. J. Keller &#038; Associates, Inc." instead of "J. J. Keller & Associates, Inc.". JSON.parse
  // never decodes HTML entities embedded in a string value, so a JSON-based discovery source that
  // hands back a pre-HTML-escaped company/title field left the raw escape sequence in place all the
  // way through to the UI, saved jobs, and AI letter-generation prompts.
  it('decodes numeric, named, and quote HTML entities left raw by a JSON feed', () => {
    expect(stringValue('J. J. Keller &#038; Associates, Inc.')).toBe('J. J. Keller & Associates, Inc.');
    expect(stringValue('Sales &amp; Marketing Lead')).toBe('Sales & Marketing Lead');
    expect(stringValue('Support the &quot;flagship&quot; account')).toBe('Support the "flagship" account');
  });

  it('leaves a literal angle bracket that is not part of a real tag untouched', () => {
    // Regression guard: a full HTML-parse-based decode (e.g. round-tripping through cheerio) would
    // interpret this as markup and silently drop content after it. The entity decoder must not do
    // that -- it only replaces recognized `&name;`/`&#NNN;` runs, nothing else.
    expect(stringValue('Engineer (Level 1 < 2) & Design')).toBe('Engineer (Level 1 < 2) & Design');
  });
});

describe('isoPostedAt', () => {
  it('returns null for a null input', () => {
    expect(isoPostedAt(null)).toBeNull();
  });

  it('passes through an already-UTC ISO string with milliseconds', () => {
    expect(isoPostedAt('2026-08-18T15:18:59.077Z')).toBe('2026-08-18T15:18:59.077Z');
  });

  it('passes through an ISO string with an explicit offset', () => {
    expect(isoPostedAt('2026-08-31T06:50:02+00:00')).toBe('2026-08-31T06:50:02.000Z');
  });

  it('parses an RFC 822 date (RSS pubDate) directly', () => {
    expect(isoPostedAt('Thu, 27 Aug 2026 14:36:09 GMT')).toBe('2026-08-27T14:36:09.000Z');
  });

  it('treats a date-only string as UTC midnight', () => {
    expect(isoPostedAt('2026-08-31')).toBe('2026-08-31T00:00:00.000Z');
  });

  it('pins an offset-less date-time string to UTC instead of the local machine timezone', () => {
    expect(isoPostedAt('2026-08-31T06:44:39')).toBe('2026-08-31T06:44:39.000Z');
  });

  it('returns null for an unparseable string rather than throwing', () => {
    expect(isoPostedAt('not-a-date')).toBeNull();
  });
});

describe('isoPostedAtFromUnixSeconds', () => {
  it('returns null for a null input', () => {
    expect(isoPostedAtFromUnixSeconds(null)).toBeNull();
  });

  it('converts unix seconds to an ISO string', () => {
    expect(isoPostedAtFromUnixSeconds(1788241217)).toBe('2026-09-01T05:40:17.000Z');
  });
});

describe('parseSalaryText', () => {
  it('returns an all-null result for a null input', () => {
    expect(parseSalaryText(null)).toEqual({ minimum: null, currency: null, period: null });
  });

  it('extracts an hourly rate right next to the number', () => {
    expect(parseSalaryText('$45/hr, remote')).toMatchObject({ minimum: 45, currency: 'USD', period: 'hourly' });
  });

  it('extracts a monthly figure', () => {
    expect(parseSalaryText('EUR 4,500 monthly gross')).toMatchObject({
      minimum: 4_500,
      currency: 'EUR',
      period: 'monthly',
    });
  });

  it('extracts a weekly figure when the only period word actually describes the pay', () => {
    expect(parseSalaryText('GBP 500 per week')).toMatchObject({ minimum: 500, currency: 'GBP', period: 'weekly' });
  });

  it('extracts an annual figure', () => {
    expect(parseSalaryText('USD 120,000 per year')).toMatchObject({
      minimum: 120_000,
      currency: 'USD',
      period: 'annual',
    });
  });

  // QA regression: a real vacancy read as "GBP 25,000/weekly" while its own description read "£25,000
  // - 35,000 per year". The description mentioned working hours ("hours per week") ahead of the
  // salary figure, and the old hourly > monthly > weekly > annual priority order picked "weekly" from
  // that unrelated sentence purely because it was checked before "annual", regardless of which period
  // word actually sat next to the number.
  it('picks the period word nearest the salary figure over one from an unrelated sentence', () => {
    expect(
      parseSalaryText('Salary: £25,000 - 35,000 per year. Full-time, standard hours per week.'),
    ).toMatchObject({ minimum: 25_000, currency: 'GBP', period: 'annual' });
  });

  it('picks weekly when the weekly word is the one actually next to the figure, even with an annual figure earlier in the text', () => {
    expect(
      parseSalaryText('Contract runs for a full year. Weekly rate: $1,200 per week.'),
    ).toMatchObject({ minimum: 1_200, currency: 'USD', period: 'weekly' });
  });

  it('keeps the lower bound, currency, and period together for salary ranges', () => {
    expect(parseSalaryText('EUR 60,000 - 80,000 per year')).toMatchObject({
      minimum: 60_000,
      currency: 'EUR',
      period: 'annual',
    });
    expect(parseSalaryText('USD 5,000 - 6,000 monthly')).toMatchObject({
      minimum: 5_000,
      currency: 'USD',
      period: 'monthly',
    });
  });

  it('returns a null period when no known period word is present', () => {
    expect(parseSalaryText('USD 90,000')).toMatchObject({ minimum: 90_000, currency: 'USD', period: null });
  });

  it('returns an all-null result when no number is present', () => {
    expect(parseSalaryText('Competitive salary, remote role')).toEqual({
      minimum: null,
      currency: null,
      period: null,
    });
  });
});
