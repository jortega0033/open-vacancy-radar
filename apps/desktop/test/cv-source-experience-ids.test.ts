import { describe, expect, it } from 'vitest';
import {
  mintExperienceId,
  reconcileExperienceIds,
  withStableExperienceIds,
  type CvSourceExperienceEntry,
} from '../electron/workspace/cv-source-schema.js';
import { toCvSourceDocument } from '../src/components/cv/source-cv-response.js';

function role(overrides: Partial<CvSourceExperienceEntry> = {}): CvSourceExperienceEntry {
  return {
    id: '',
    company: 'Redwood Software',
    title: 'Frontend Engineer',
    dates: '2021 - 2023',
    engagement: 'employment',
    client: '',
    bullets: [],
    ...overrides,
  };
}

const COMPLETE = { complete: true, incompleteReason: '', coveredChars: 10, sourceChars: 10 };

describe('mintExperienceId (#419)', () => {
  it('is random and never positional', () => {
    const first = mintExperienceId();
    expect(first).toMatch(/^experience-[0-9a-f-]{36}$/u);
    expect(mintExperienceId()).not.toBe(first);
  });
});

describe('withStableExperienceIds (#419)', () => {
  it('leaves every existing unique id untouched, through a reorder', () => {
    const list = [role({ id: 'a1', title: 'One' }), role({ id: 'b2', title: 'Two' }), role({ id: 'c3', title: 'Three' })];
    const reordered = [list[2]!, list[0]!, list[1]!];
    expect(withStableExperienceIds(reordered).map((entry) => entry.id)).toEqual(['c3', 'a1', 'b2']);
  });

  it('keeps an id when the entry is edited', () => {
    const edited = role({ id: 'a1', title: 'Staff Engineer', bullets: ['New bullet'] });
    expect(withStableExperienceIds([edited])[0]?.id).toBe('a1');
  });

  it('backfills a record that has no id with the legacy value the migration writes', () => {
    expect(withStableExperienceIds([role(), role({ id: 'x' })]).map((entry) => entry.id)).toEqual(['experience-1', 'x']);
  });

  it('gives two roles with the same employer and title distinct ids, even when both were stored with one id', () => {
    const twin = role({ id: 'dup' });
    const ids = withStableExperienceIds([twin, { ...twin }]).map((entry) => entry.id);
    expect(ids[0]).toBe('dup');
    expect(ids[1]).not.toBe('dup');
    expect(new Set(ids).size).toBe(2);
  });
});

describe('reconcileExperienceIds (#419)', () => {
  const saved = [
    role({ id: 'keep-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - 2023' }),
    role({ id: 'keep-2', company: 'Harbour Analytics', title: 'Data Engineer', dates: '2019 - 2021' }),
  ];

  it('carries ids across a re-extraction in a different order', () => {
    const extracted = [
      role({ company: 'Harbour Analytics', title: 'Data Engineer', dates: '2019 - 2021' }),
      role({ company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - 2023' }),
    ];
    const { experience, needsReview } = reconcileExperienceIds(saved, extracted);
    expect(experience.map((entry) => entry.id)).toEqual(['keep-2', 'keep-1']);
    expect(needsReview).toEqual([]);
  });

  it('matches whatever differs only in case or spacing', () => {
    const extracted = [role({ company: '  redwood   software ', title: 'FRONTEND ENGINEER', dates: '2021 - 2023' })];
    expect(reconcileExperienceIds(saved, extracted).experience[0]?.id).toBe('keep-1');
  });

  it('flags an entry whose text changed instead of renumbering it onto an old role', () => {
    const extracted = [
      role({ company: 'Redwood Software', title: 'Senior Frontend Engineer', dates: '2021 - 2023' }),
      role({ company: 'Harbour Analytics', title: 'Data Engineer', dates: '2019 - 2021' }),
    ];
    const { experience, needsReview } = reconcileExperienceIds(saved, extracted);
    expect(experience[0]?.id).not.toBe('keep-1');
    expect(experience[0]?.id).toMatch(/^experience-/u);
    expect(experience[1]?.id).toBe('keep-2');
    expect(needsReview).toEqual(['Senior Frontend Engineer at Redwood Software']);
  });

  it('never merges two identical roles: ambiguous matches get fresh ids and are flagged', () => {
    const twins = [
      role({ id: 'twin-a', company: 'Northwind Freight', title: 'Engineer', dates: '2020 - 2021' }),
      role({ id: 'twin-b', company: 'Northwind Freight', title: 'Engineer', dates: '2020 - 2021' }),
    ];
    const extracted = twins.map((entry) => ({ ...entry, id: '' }));
    const { experience, needsReview } = reconcileExperienceIds(twins, extracted);
    const ids = experience.map((entry) => entry.id);
    expect(ids).not.toContain('twin-a');
    expect(ids).not.toContain('twin-b');
    expect(new Set(ids).size).toBe(2);
    expect(needsReview).toHaveLength(2);
  });

  it('keeps same-employer roles with different titles apart', () => {
    const existing = [
      role({ id: 'junior', company: 'Northwind Freight', title: 'Junior Engineer', dates: '2018 - 2020' }),
      role({ id: 'senior', company: 'Northwind Freight', title: 'Senior Engineer', dates: '2020 - 2023' }),
    ];
    const extracted = [
      role({ company: 'Northwind Freight', title: 'Senior Engineer', dates: '2020 - 2023' }),
      role({ company: 'Northwind Freight', title: 'Junior Engineer', dates: '2018 - 2020' }),
    ];
    expect(reconcileExperienceIds(existing, extracted).experience.map((entry) => entry.id)).toEqual(['senior', 'junior']);
  });

  it('mints ids without flagging anything when there is no saved record to compare against', () => {
    const { experience, needsReview } = reconcileExperienceIds([], [role(), role({ title: 'Other' })]);
    expect(new Set(experience.map((entry) => entry.id)).size).toBe(2);
    expect(needsReview).toEqual([]);
  });
});

describe('source extraction ids (#419)', () => {
  it('assigns each extracted role its own non-positional id, including two identical roles', () => {
    const twin = { company: 'Northwind Freight', title: 'Engineer', dates: '2020', engagement: 'employment', client: '', bullets: [] };
    const source = toCvSourceDocument({ experience: [twin, twin] }, COMPLETE);
    const ids = source.experience.map((entry) => entry.id);
    expect(ids.every((id) => /^experience-[0-9a-f-]{36}$/u.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });
});
