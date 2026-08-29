import { load } from 'cheerio';

export type NetherlandsSalaryAssessment = {
  decision: 'meets' | 'below' | 'unverified';
  advertisedMonthlyBaseEur: number | null;
  reason: string;
};

const EURO_AMOUNT = /(?:€\s*|\bEUR\s*)(\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*([kK])?|(?:\b)(\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*([kK])?\s*(?:€|\bEUR\b)/gu;
const MONTHLY_PERIOD = /\b(?:per\s+month|monthly|a\s+month|month|p\s*\/\s*m|per\s+maand|maandelijks|maand)\b/iu;
const ANNUAL_PERIOD = /\b(?:per\s+year|annually|annual|yearly|a\s+year|per\s+annum|p\s*\.?a\.?|per\s+jaar|jaarlijks|jaar)\b/iu;
const SALARY_CONTEXT = /\b(?:base\s+salary|salary|base\s+pay|pay\s+range|compensation|remuneration|gross|bruto|salaris)\b/iu;
const NON_BASE_CONTEXT = /\b(?:bonus|equity|stock|shares?|allowance|budget|learning\s+budget|signing)\b/iu;

function numericAmount(raw: string, thousands: boolean): number | null {
  const compact = raw.replaceAll(/\s/gu, '');
  if (thousands) {
    const numeric = Number(compact.replace(',', '.'));
    return Number.isFinite(numeric) ? numeric * 1_000 : null;
  }
  const separators = [...compact.matchAll(/[.,]/gu)];
  if (separators.length === 0) {
    const numeric = Number(compact);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const lastSeparator = separators.at(-1)?.index ?? -1;
  const trailingDigits = compact.length - lastSeparator - 1;
  const normalized = trailingDigits === 3
    ? compact.replaceAll(/[.,]/gu, '')
    : compact.slice(0, lastSeparator).replaceAll(/[.,]/gu, '')
      + '.' + compact.slice(lastSeparator + 1);
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function plainText(value: string): string {
  return load(value).text().replace(/\s+/gu, ' ').trim();
}

export function assessNetherlandsSalary(
  vacancyText: string,
  minimumMonthlyBaseEur: number,
): NetherlandsSalaryAssessment {
  const text = plainText(vacancyText);
  const monthlyCandidates: number[] = [];
  for (const match of text.matchAll(EURO_AMOUNT)) {
    const amountText = match[1] ?? match[3];
    if (amountText === undefined) continue;
    const contextStart = Math.max(0, match.index - 100);
    const contextEnd = Math.min(text.length, match.index + match[0].length + 100);
    const context = text.slice(contextStart, contextEnd);
    const monthly = MONTHLY_PERIOD.test(context);
    const annual = ANNUAL_PERIOD.test(context);
    if (!monthly && !annual && !SALARY_CONTEXT.test(context)) continue;
    if (NON_BASE_CONTEXT.test(context) && !/\b(?:base\s+salary|salary|base\s+pay)\b/iu.test(context)) {
      continue;
    }
    const amount = numericAmount(amountText, (match[2] ?? match[4]) !== undefined);
    if (amount === null || amount <= 0) continue;
    if (monthly) {
      if (amount >= 1_000 && amount <= 50_000) monthlyCandidates.push(amount);
      continue;
    }
    if (annual || amount >= 20_000) {
      if (amount >= 12_000 && amount <= 1_000_000) monthlyCandidates.push(amount / 12);
    }
  }
  if (monthlyCandidates.length === 0) {
    return {
      decision: 'unverified',
      advertisedMonthlyBaseEur: null,
      reason: `No deterministic EUR base salary was found; the required floor is €${minimumMonthlyBaseEur.toLocaleString('en-US')} gross per month.`,
    };
  }
  const advertisedMonthlyBaseEur = Math.min(...monthlyCandidates);
  if (advertisedMonthlyBaseEur < minimumMonthlyBaseEur) {
    return {
      decision: 'below',
      advertisedMonthlyBaseEur,
      reason: `Advertised EUR base floor annualizes to €${Math.round(advertisedMonthlyBaseEur).toLocaleString('en-US')} per month, below the €${minimumMonthlyBaseEur.toLocaleString('en-US')} requirement.`,
    };
  }
  return {
    decision: 'meets',
    advertisedMonthlyBaseEur,
    reason: `Advertised EUR base floor is at least €${Math.round(advertisedMonthlyBaseEur).toLocaleString('en-US')} per month.`,
  };
}
