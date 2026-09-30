import { describe, expect, it } from 'vitest';
import { EMPTY_CV_SOURCE, stableCvSourceJson, type CvSourceDocument } from '../electron/workspace/cv-source-schema.js';

describe('stableCvSourceJson (#419)', () => {
  it('produces the same string for the same content regardless of key insertion order', () => {
    const idFirst = { id: 'experience-1', company: 'Redwood', title: 'Engineer' };
    const idLast = { company: 'Redwood', title: 'Engineer', id: 'experience-1' };
    // Sanity check on the premise: plain JSON.stringify *does* differ by key order.
    expect(JSON.stringify(idFirst)).not.toBe(JSON.stringify(idLast));

    const a: CvSourceDocument = { ...EMPTY_CV_SOURCE, experience: [idFirst as CvSourceDocument['experience'][number]] };
    const b: CvSourceDocument = { ...EMPTY_CV_SOURCE, experience: [idLast as CvSourceDocument['experience'][number]] };
    expect(stableCvSourceJson(a)).toBe(stableCvSourceJson(b));
  });

  it('this is exactly the withStableExperienceIds-backfill-vs-fresh-write scenario (#419)', async () => {
    // A legacy record: `id` never existed, so backfilling it is a genuinely new key, appended.
    const { withStableExperienceIds } = await import('../electron/workspace/cv-source-schema.js');
    const legacyEntry = { company: 'Redwood', title: 'Engineer', dates: '', engagement: 'employment', client: '', bullets: [] } as unknown as CvSourceDocument['experience'][number];
    const backfilled = withStableExperienceIds([legacyEntry]);

    // A fresh write: `parseSourceExperience` builds `id` as the first property.
    const freshEntry = { id: 'experience-1', company: 'Redwood', title: 'Engineer', dates: '', engagement: 'employment' as const, client: '', bullets: [] };

    const legacySource: CvSourceDocument = { ...EMPTY_CV_SOURCE, experience: backfilled };
    const freshSource: CvSourceDocument = { ...EMPTY_CV_SOURCE, experience: [freshEntry] };

    expect(stableCvSourceJson(legacySource)).toBe(stableCvSourceJson(freshSource));
  });

  it('still reflects a genuine content difference', () => {
    const a: CvSourceDocument = { ...EMPTY_CV_SOURCE, summary: 'Frontend engineer.' };
    const b: CvSourceDocument = { ...EMPTY_CV_SOURCE, summary: 'Backend engineer.' };
    expect(stableCvSourceJson(a)).not.toBe(stableCvSourceJson(b));
  });

  it('sorts keys recursively through nested objects and arrays', () => {
    const a: CvSourceDocument = {
      ...EMPTY_CV_SOURCE,
      contact: { name: 'Jamie', title: 'Engineer', location: '', email: '', phone: '', links: ['a', 'b'] },
    };
    const b: CvSourceDocument = {
      ...EMPTY_CV_SOURCE,
      contact: { title: 'Engineer', name: 'Jamie', phone: '', email: '', location: '', links: ['a', 'b'] },
    };
    expect(stableCvSourceJson(a)).toBe(stableCvSourceJson(b));
  });
});
