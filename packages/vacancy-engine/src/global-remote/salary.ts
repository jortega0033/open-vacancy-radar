export const DEFAULT_SALARY_HOURS_PER_WEEK = 40;
export const DEFAULT_SALARY_WEEKS_PER_YEAR = 52;

export type SalaryFilterCriteria = {
  minimumAnnual: number;
  currency: string;
  includeUnknown: boolean;
};

/** Only this provenance may enter the comparable-salary path. */
export type SalaryProvenance =
  | 'reviewed_structured'
  | 'loose_text'
  | 'estimated'
  | 'ambiguous'
  | 'unreviewed';

export type SalaryNormalizationMethod =
  | 'advertised_annual'
  | 'monthly_to_annual'
  | 'hourly_to_annual'
  | 'missing'
  | 'invalid_amount'
  | 'missing_currency'
  | 'unsupported_period'
  | 'ambiguous_period'
  | 'unreviewed_source'
  | 'estimated_source'
  | 'ambiguous_source';

export type SalaryNormalization = {
  normalizedAnnualMinimum: number | null;
  normalizedCurrency: string | null;
  normalizationMethod: SalaryNormalizationMethod;
  assumptionProvenance: string | null;
  salaryProvenance: SalaryProvenance;
};

export type SalaryAssessment =
  | { kind: 'not_applicable' }
  | { kind: 'comparable'; normalizedAnnualMinimum: number; normalizedCurrency: string }
  | { kind: 'below_floor'; normalizedAnnualMinimum: number; normalizedCurrency: string }
  | { kind: 'unknown'; reason: string };

const ANNUAL_PERIODS = new Set([
  'annual',
  'annually',
  'year',
  'yearly',
  'yr',
  'p.a.',
  'pa',
  '1 year',
]);
const MONTHLY_PERIODS = new Set(['month', 'monthly', 'mo']);

function canonicalPeriod(period: string | null): string | null {
  if (period === null) return null;
  const value = period.trim().toLowerCase().replace(/\s+/gu, ' ');
  return value || null;
}

/**
 * Normalizes only periods whose annual meaning is explicit. Currency is retained as advertised;
 * this function deliberately has no exchange-rate path.
 */
export function normalizeSalary(
  minimum: number | null,
  currency: string | null,
  period: string | null,
  salaryProvenance: SalaryProvenance = 'unreviewed',
): SalaryNormalization {
  if (minimum === null) {
    return {
      normalizedAnnualMinimum: null,
      normalizedCurrency: null,
      normalizationMethod: 'missing',
      assumptionProvenance: null,
      salaryProvenance,
    };
  }
  if (salaryProvenance !== 'reviewed_structured') {
    const normalizationMethod = salaryProvenance === 'estimated'
      ? 'estimated_source'
      : salaryProvenance === 'ambiguous'
        ? 'ambiguous_source'
        : 'unreviewed_source';
    return {
      normalizedAnnualMinimum: null,
      normalizedCurrency: null,
      normalizationMethod,
      assumptionProvenance: null,
      salaryProvenance,
    };
  }
  if (!Number.isFinite(minimum) || minimum < 0) {
    return {
      normalizedAnnualMinimum: null,
      normalizedCurrency: null,
      normalizationMethod: 'invalid_amount',
      assumptionProvenance: null,
      salaryProvenance,
    };
  }
  const normalizedCurrency = currency?.trim().toUpperCase() || null;
  if (normalizedCurrency === null) {
    return {
      normalizedAnnualMinimum: null,
      normalizedCurrency: null,
      normalizationMethod: 'missing_currency',
      assumptionProvenance: null,
      salaryProvenance,
    };
  }
  const normalizedPeriod = canonicalPeriod(period);
  if (normalizedPeriod === null) {
    return {
      normalizedAnnualMinimum: null,
      normalizedCurrency: null,
      normalizationMethod: 'ambiguous_period',
      assumptionProvenance: null,
      salaryProvenance,
    };
  }
  if (ANNUAL_PERIODS.has(normalizedPeriod)) {
    return {
      normalizedAnnualMinimum: minimum,
      normalizedCurrency,
      normalizationMethod: 'advertised_annual',
      assumptionProvenance: 'Advertised annual period.',
      salaryProvenance,
    };
  }
  if (MONTHLY_PERIODS.has(normalizedPeriod)) {
    const annualMinimum = minimum * 12;
    if (!Number.isFinite(annualMinimum)) {
      return {
        normalizedAnnualMinimum: null,
        normalizedCurrency: null,
        normalizationMethod: 'invalid_amount',
        assumptionProvenance: null,
        salaryProvenance,
      };
    }
    return {
      normalizedAnnualMinimum: annualMinimum,
      normalizedCurrency,
      normalizationMethod: 'monthly_to_annual',
      assumptionProvenance: 'Advertised monthly period multiplied by 12 months.',
      salaryProvenance,
    };
  }
  if (normalizedPeriod === 'hour' || normalizedPeriod === 'hourly' || normalizedPeriod === 'hr') {
    const annualMinimum = minimum * DEFAULT_SALARY_HOURS_PER_WEEK * DEFAULT_SALARY_WEEKS_PER_YEAR;
    if (!Number.isFinite(annualMinimum)) {
      return {
        normalizedAnnualMinimum: null,
        normalizedCurrency: null,
        normalizationMethod: 'invalid_amount',
        assumptionProvenance: null,
        salaryProvenance,
      };
    }
    return {
      normalizedAnnualMinimum: annualMinimum,
      normalizedCurrency,
      normalizationMethod: 'hourly_to_annual',
      assumptionProvenance: `Configured assumption: ${DEFAULT_SALARY_HOURS_PER_WEEK} hours/week and ${DEFAULT_SALARY_WEEKS_PER_YEAR} weeks/year.`,
      salaryProvenance,
    };
  }
  return {
    normalizedAnnualMinimum: null,
    normalizedCurrency: null,
    normalizationMethod: 'unsupported_period',
    assumptionProvenance: `Source period "${period}" is not supported for annual comparison.`,
    salaryProvenance,
  };
}

export function assessSalary(
  normalization: Partial<SalaryNormalization> | undefined,
  criteria: SalaryFilterCriteria | null | undefined,
): SalaryAssessment {
  if (criteria === null || criteria === undefined) return { kind: 'not_applicable' };
  if (
    normalization?.salaryProvenance !== 'reviewed_structured' ||
    normalization?.normalizedAnnualMinimum === null ||
    normalization?.normalizedAnnualMinimum === undefined ||
    normalization.normalizedCurrency === null ||
    normalization.normalizedCurrency === undefined
  ) {
    return {
      kind: 'unknown',
      reason: normalization?.normalizationMethod ?? 'missing_normalization',
    };
  }
  if (normalization.normalizedCurrency.toUpperCase() !== criteria.currency.toUpperCase()) {
    return { kind: 'unknown', reason: 'currency_mismatch' };
  }
  return normalization.normalizedAnnualMinimum >= criteria.minimumAnnual
    ? {
        kind: 'comparable',
        normalizedAnnualMinimum: normalization.normalizedAnnualMinimum,
        normalizedCurrency: normalization.normalizedCurrency,
      }
    : {
        kind: 'below_floor',
        normalizedAnnualMinimum: normalization.normalizedAnnualMinimum,
        normalizedCurrency: normalization.normalizedCurrency,
      };
}

/** Parses the UI's one-value salary field without guessing between decimal and grouping locales. */
export function parseMinimumAnnualSalary(value: unknown): number | null {
  if (typeof value !== 'string') throw new Error('Minimum annual salary must be a string.');
  const input = value.trim().replace(/\u00a0/gu, ' ');
  if (input.length === 0) return null;
  if (!/^[0-9., ]+$/u.test(input) || input.startsWith(' ') || input.endsWith(' ')) {
    throw new Error(
      'Minimum annual salary must contain digits with one consistent grouping convention.',
    );
  }

  let numericText: string;
  const spaces = input.includes(' ');
  const commaCount = (input.match(/,/gu) ?? []).length;
  const dotCount = (input.match(/\./gu) ?? []).length;

  if (spaces) {
    const match = /^(\d{1,3}(?: \d{3})+)(?:([.,])(\d{1,2}))?$/u.exec(input);
    if (!match) throw new Error('Minimum annual salary has malformed grouping.');
    numericText = match[1]!.replaceAll(' ', '') + (match[2] ? `.${match[3]}` : '');
  } else if (commaCount > 0 && dotCount > 0) {
    const decimalSeparator = input.lastIndexOf(',') > input.lastIndexOf('.') ? ',' : '.';
    const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
    const escapedGrouping = groupingSeparator === '.' ? '\\.' : ',';
    const escapedDecimal = decimalSeparator === '.' ? '\\.' : ',';
    const pattern = new RegExp(
      `^\\d{1,3}(?:${escapedGrouping}\\d{3})+${escapedDecimal}\\d{1,2}$`,
      'u',
    );
    if (!pattern.test(input)) throw new Error('Minimum annual salary has malformed grouping.');
    numericText = input.replaceAll(groupingSeparator, '').replace(decimalSeparator, '.');
  } else if (commaCount > 1 || dotCount > 1) {
    const separator = commaCount > 1 ? ',' : '.';
    const pattern = separator === ',' ? /^\d{1,3}(?:,\d{3})+$/u : /^\d{1,3}(?:\.\d{3})+$/u;
    if (!pattern.test(input)) throw new Error('Minimum annual salary has malformed grouping.');
    numericText = input.replaceAll(separator, '');
  } else if (commaCount === 1 || dotCount === 1) {
    const separator = commaCount === 1 ? ',' : '.';
    const [whole, fraction] = input.split(separator);
    if (
      whole === undefined ||
      fraction === undefined ||
      whole.length === 0 ||
      !/^\d{1,2}$/u.test(fraction)
    ) {
      throw new Error(
        'Minimum annual salary is ambiguous. Use plain digits or an explicit decimal.',
      );
    }
    numericText = `${whole}.${fraction}`;
  } else {
    if (!/^\d+$/u.test(input)) throw new Error('Minimum annual salary has malformed digits.');
    numericText = input;
  }

  const numeric = Number(numericText);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > Number.MAX_SAFE_INTEGER) {
    throw new Error('Minimum annual salary must be a finite, non-negative amount.');
  }
  return Math.round(numeric);
}
