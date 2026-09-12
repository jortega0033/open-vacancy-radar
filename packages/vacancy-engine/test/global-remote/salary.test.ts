import { describe, expect, it } from 'vitest';
import {
  assessSalary,
  normalizeSalary,
  parseMinimumAnnualSalary,
} from '../../src/global-remote/salary.js';

describe('audited salary normalization', () => {
  it('normalizes annual and monthly advertised minimums without changing currency', () => {
    expect(normalizeSalary(60_000, 'eur', 'annual', 'reviewed_structured')).toMatchObject({
      normalizedAnnualMinimum: 60_000,
      normalizedCurrency: 'EUR',
      normalizationMethod: 'advertised_annual',
    });
    expect(normalizeSalary(5_000, 'EUR', 'monthly', 'reviewed_structured')).toMatchObject({
      normalizedAnnualMinimum: 60_000,
      normalizedCurrency: 'EUR',
      normalizationMethod: 'monthly_to_annual',
    });
  });

  it('normalizes supported hourly values with explicit assumption provenance', () => {
    expect(normalizeSalary(30, 'USD', 'hourly', 'reviewed_structured')).toMatchObject({
      normalizedAnnualMinimum: 62_400,
      normalizedCurrency: 'USD',
      normalizationMethod: 'hourly_to_annual',
      assumptionProvenance: 'Configured assumption: 40 hours/week and 52 weeks/year.',
    });
  });

  it('keeps missing, ambiguous, unsupported, and currency-less values unknown', () => {
    expect(normalizeSalary(null, 'EUR', 'annual').normalizationMethod).toBe('missing');
    expect(normalizeSalary(50_000, 'EUR', null, 'reviewed_structured').normalizationMethod).toBe('ambiguous_period');
    expect(normalizeSalary(1_000, 'EUR', 'weekly', 'reviewed_structured').normalizedAnnualMinimum).toBeNull();
    expect(normalizeSalary(50_000, null, 'annual', 'reviewed_structured').normalizationMethod).toBe('missing_currency');
  });

  it('compares only audited values in the selected currency', () => {
    const criteria = { minimumAnnual: 60_000, currency: 'EUR', includeUnknown: true };
    expect(assessSalary(normalizeSalary(60_000, 'EUR', 'annual', 'reviewed_structured'), criteria).kind).toBe(
      'comparable',
    );
    expect(assessSalary(normalizeSalary(59_999, 'EUR', 'annual', 'reviewed_structured'), criteria).kind).toBe(
      'below_floor',
    );
    expect(assessSalary(normalizeSalary(80_000, 'USD', 'annual', 'reviewed_structured'), criteria)).toMatchObject({
      kind: 'unknown',
      reason: 'currency_mismatch',
    });
  });

  it('never treats loose or estimated description extraction as comparable', () => {
    expect(normalizeSalary(70_000, 'EUR', 'annual', 'loose_text')).toMatchObject({
      normalizedAnnualMinimum: null,
      normalizedCurrency: null,
      normalizationMethod: 'unreviewed_source',
    });
    expect(normalizeSalary(70_000, 'EUR', 'annual', 'estimated')).toMatchObject({
      normalizedAnnualMinimum: null,
      normalizedCurrency: null,
      normalizationMethod: 'estimated_source',
    });
  });

  it('binds a structured range minimum to its supplied currency and period', () => {
    const criteria = { minimumAnnual: 60_000, currency: 'EUR', includeUnknown: true };
    expect(assessSalary(normalizeSalary(5_000, 'EUR', 'monthly', 'reviewed_structured'), criteria)).toMatchObject({
      kind: 'comparable',
      normalizedAnnualMinimum: 60_000,
      normalizedCurrency: 'EUR',
    });
    expect(assessSalary(normalizeSalary(60_000, 'USD', 'annual', 'reviewed_structured'), criteria).kind).toBe('unknown');
  });
});

describe('strict minimum annual salary parsing', () => {
  it.each([
    ['60000', 60000],
    ['60 000', 60000],
    ['60,000.50', 60001],
    ['60.000,50', 60001],
    ['1,234,567', 1_234_567],
  ])('accepts unambiguous input %j', (input, expected) => {
    expect(parseMinimumAnnualSalary(input)).toBe(expected);
  });

  it.each(['1,234', '1.234', '60,000,50', '60.000.50', '-1', '1e5', '12 34'])(
    'rejects ambiguous or malformed input %j',
    (input) => {
      expect(() => parseMinimumAnnualSalary(input)).toThrow();
    },
  );

  it('treats an empty field as no salary filter', () => {
    expect(parseMinimumAnnualSalary('   ')).toBeNull();
  });
});
