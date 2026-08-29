export type SponsorIdentity = {
  legalName: string;
  normalizedName: string;
  searchName: string;
  kvkNumber: string | null;
};

function preserveLegalName(input: string): string {
  return input
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDisplayName(input: string): string {
  let value = preserveLegalName(input)
    .normalize('NFKC')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'");

  while (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

export function normalizeLegalName(input: string): string {
  return normalizeDisplayName(input)
    .toLocaleLowerCase('nl-NL')
    .replace(/\bb\s*\.?\s*v\s*\.?$/u, 'bv')
    .replace(/\bn\s*\.?\s*v\s*\.?$/u, 'nv')
    .replace(/\bv\s*\.?\s*o\s*\.?\s*f\s*\.?$/u, 'vof')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createSearchName(input: string): string {
  return normalizeLegalName(input)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeKvkNumber(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 0 && input.trim().length === 0) return null;
  if (!/^\d{8}$/.test(digits)) {
    throw new Error(`Invalid KVK number: ${input}`);
  }
  return digits;
}

export function createSponsorIdentity(legalName: string, kvkNumber: string): SponsorIdentity {
  const cleanedLegalName = preserveLegalName(legalName);
  if (cleanedLegalName.length === 0) throw new Error('Sponsor legal name is empty');
  return {
    legalName: cleanedLegalName,
    normalizedName: normalizeLegalName(cleanedLegalName),
    searchName: createSearchName(cleanedLegalName),
    kvkNumber: normalizeKvkNumber(kvkNumber),
  };
}
