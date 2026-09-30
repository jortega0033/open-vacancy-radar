import { describe, expect, it } from 'vitest';
import { vacancyKeyFor } from '../src/components/cv/vacancy-key.js';
import type { VacancyLead } from '../src/components/cv/types.js';

const VACANCY: VacancyLead = {
  title: 'Senior Frontend Engineer',
  company: 'Redwood Software',
  location: 'Amsterdam, Netherlands',
  url: 'https://example.invalid/jobs/1',
};

describe('vacancyKeyFor (#419)', () => {
  it('keys on the URL when one exists', () => {
    expect(vacancyKeyFor(VACANCY)).toBe('url:https://example.invalid/jobs/1');
  });

  it('is stable for the same URL across separate lead objects', () => {
    expect(vacancyKeyFor(VACANCY)).toBe(vacancyKeyFor({ ...VACANCY }));
  });

  it('falls back to a normalized role/company/location composite with no URL', () => {
    const handTyped = { ...VACANCY, url: '' };
    expect(vacancyKeyFor(handTyped)).toBe('fields:senior frontend engineer|redwood software|amsterdam, netherlands');
  });

  it('normalizes case and whitespace in the fallback, so two spellings key together', () => {
    const a = { ...VACANCY, url: '', title: 'Senior Frontend Engineer' };
    const b = { ...VACANCY, url: '', title: '  senior   frontend   engineer  ' };
    expect(vacancyKeyFor(a)).toBe(vacancyKeyFor(b));
  });
});
