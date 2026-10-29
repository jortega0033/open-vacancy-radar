import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  addSearchPlanSuggestions,
  approveSearchPlanDraft,
  captureSearchPlanSnapshot,
  dismissSearchPlanSuggestion,
  EMPTY_SEARCH_PLAN,
  isSearchPlanUsable,
  loadSearchPlan,
  backupUnreadableSearchPlan,
  isSearchPlanReadError,
  normalizeSearchPlanDraft,
  parseSearchPlanDraft,
  SEARCH_PLAN_MAX_VARIANTS,
  searchPlanDraftSchema,
  SearchPlanReadError,
  SearchPlanValidationError,
  searchPlanVariantId,
  writeSearchPlan,
} from '../../src/candidate/search-plan.js';

const NOW = new Date('2026-10-29T10:00:00.000Z');
const draft = (variants: { title: string; language?: string }[], extra: { primaryFunction?: string; markets?: string[] } = {}) =>
  searchPlanDraftSchema.parse({ primaryFunction: extra.primaryFunction ?? 'Frontend engineering', variants, markets: extra.markets ?? [] });

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('search plan (#686)', () => {
  it('starts empty and unusable: no approved title means no plan run', () => {
    expect(EMPTY_SEARCH_PLAN.revision).toBe(0);
    expect(isSearchPlanUsable(EMPTY_SEARCH_PLAN)).toBe(false);
  });

  it('approves a manual draft with no AI involved, keeping order, language and origin', () => {
    const plan = approveSearchPlanDraft(
      EMPTY_SEARCH_PLAN,
      draft(
        [{ title: ' React developer ' }, { title: 'Frontend engineer' }, { title: 'Frontend ontwikkelaar', language: 'Dutch' }],
        { markets: ['Netherlands', 'netherlands', ''] },
      ),
      NOW,
    );
    expect(plan.revision).toBe(1);
    expect(plan.variants.map((variant) => [variant.title, variant.language, variant.origin])).toEqual([
      ['React developer', '', 'user'],
      ['Frontend engineer', '', 'user'],
      ['Frontend ontwikkelaar', 'Dutch', 'user'],
    ]);
    expect(plan.markets).toEqual(['Netherlands']);
    expect(isSearchPlanUsable(plan)).toBe(true);
  });

  it('treats the same title in the same language as one variant, but keeps the same title in another language', () => {
    const normalized = normalizeSearchPlanDraft(
      draft([{ title: 'UI engineer' }, { title: 'ui   ENGINEER' }, { title: 'UI engineer', language: 'English' }]),
    );
    expect(normalized.variants.map((variant) => variant.title)).toEqual(['UI engineer', 'UI engineer']);
    expect(normalized.variants.map((variant) => variant.language)).toEqual(['', 'English']);
  });

  it('bounds the plan with a readable refusal instead of silently dropping titles', () => {
    const exactly = Array.from({ length: SEARCH_PLAN_MAX_VARIANTS }, (_, index) => ({ title: `Title ${index}` }));
    expect(normalizeSearchPlanDraft(draft(exactly)).variants).toHaveLength(SEARCH_PLAN_MAX_VARIANTS);
    const many = Array.from({ length: SEARCH_PLAN_MAX_VARIANTS * 2 }, (_, index) => ({ title: `Title ${index}` }));
    expect(() => normalizeSearchPlanDraft(draft(many))).toThrow(SearchPlanValidationError);
    expect(() => normalizeSearchPlanDraft(draft(many))).toThrow(/at most 12 titles; this one has 24\. Remove 12\./);
  });

  it('moves the revision only when approved content changes', () => {
    const first = approveSearchPlanDraft(EMPTY_SEARCH_PLAN, draft([{ title: 'React developer' }]), NOW);
    const same = approveSearchPlanDraft(first, draft([{ title: 'React developer' }]), new Date('2026-10-30T00:00:00.000Z'));
    expect(same.revision).toBe(first.revision);
    expect(same.updatedAt).toBe(first.updatedAt);
    const edited = approveSearchPlanDraft(first, draft([{ title: 'React developer' }, { title: 'UI engineer' }]), NOW);
    expect(edited.revision).toBe(first.revision + 1);
  });

  it('keeps AI and toolkit suggestions out of the plan until the person approves them', () => {
    const approved = approveSearchPlanDraft(EMPTY_SEARCH_PLAN, draft([{ title: 'React developer' }]), NOW);
    const suggested = addSearchPlanSuggestions(approved, 'toolkit', [{ title: 'Frontend engineer' }, { title: 'React developer' }, { title: '  ' }, 42], NOW);
    expect(suggested.variants).toEqual(approved.variants);
    expect(suggested.revision).toBe(approved.revision);
    expect(suggested.suggestions.map((suggestion) => suggestion.title)).toEqual(['Frontend engineer']);
    expect(captureSearchPlanSnapshot(suggested).variants.map((variant) => variant.title)).toEqual(['React developer']);

    const accepted = approveSearchPlanDraft(
      suggested,
      draft([{ title: 'React developer' }, { title: 'Frontend engineer' }].map((variant) => ({ ...variant }))),
      NOW,
    );
    expect(accepted.suggestions).toEqual([]);
    expect(accepted.revision).toBe(approved.revision + 1);

    const dismissed = dismissSearchPlanSuggestion(suggested, suggested.suggestions[0]!.id);
    expect(dismissed.suggestions).toEqual([]);
    expect(dismissed.revision).toBe(approved.revision);
  });

  it('captures a frozen snapshot that later edits cannot reach', () => {
    const first = approveSearchPlanDraft(
      EMPTY_SEARCH_PLAN,
      draft([{ title: 'React developer' }, { title: 'Frontend ontwikkelaar', language: 'Dutch' }], { markets: ['Netherlands'] }),
      NOW,
    );
    const snapshot = captureSearchPlanSnapshot(first);
    const second = approveSearchPlanDraft(first, draft([{ title: 'UI engineer' }]), NOW);

    expect(second.variants.map((variant) => variant.title)).toEqual(['UI engineer']);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.variants.map((variant) => variant.title)).toEqual(['React developer', 'Frontend ontwikkelaar']);
    expect(snapshot.workingLanguages).toEqual(['Dutch']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.variants)).toBe(true);
    expect(Object.isFrozen(snapshot.variants[0])).toBe(true);
    expect(() => (snapshot.variants as unknown as unknown[]).push({})).toThrow();
  });

  it('round-trips through the file, and reads a missing file as the empty plan', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ovr-search-plan-'));
    const file = path.join(directory, 'config', 'search-plan-v1.json');
    expect(await loadSearchPlan(file)).toEqual(EMPTY_SEARCH_PLAN);
    const plan = approveSearchPlanDraft(EMPTY_SEARCH_PLAN, draft([{ title: 'React developer' }]), NOW);
    await writeSearchPlan(file, plan);
    expect(await loadSearchPlan(file)).toEqual(plan);
    expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(1);
  });

  it('gives distinct titles distinct, stable, non-empty ids even when their readable slugs collide', () => {
    const corpus = [
      { title: 'C++ developer' },
      { title: 'C# developer' },
      { title: 'Front-end engineer' },
      { title: 'Front end engineer' },
      { title: 'Frontend engineer' },
      { title: 'Frontend-engineer!' },
      { title: 'UI engineer', language: 'English' },
      { title: 'UI engineer' },
    ];
    const plan = approveSearchPlanDraft(EMPTY_SEARCH_PLAN, draft(corpus), NOW);
    const ids = plan.variants.map((variant) => variant.id);
    expect(ids).toHaveLength(corpus.length);
    expect(new Set(ids).size).toBe(corpus.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    // Same title, other casing or spacing, same language: the same variant, so it is kept once.
    const deduped = approveSearchPlanDraft(EMPTY_SEARCH_PLAN, draft([{ title: 'UI Engineer' }, { title: '  ui   engineer ' }]), NOW);
    expect(deduped.variants).toHaveLength(1);
    // Stable: re-approving, reordering or editing a neighbour never changes an unchanged title's id.
    const reordered = approveSearchPlanDraft(plan, draft([...corpus].reverse()), NOW);
    expect(Object.fromEntries(reordered.variants.map((variant) => [`${variant.title}|${variant.language}`, variant.id]))).toEqual(
      Object.fromEntries(plan.variants.map((variant) => [`${variant.title}|${variant.language}`, variant.id])),
    );
    expect(searchPlanVariantId('C++ developer', '')).toBe(searchPlanVariantId('c++  Developer', ''));
  });

  it('refuses a title with no letters or numbers with a readable message, not a schema error', () => {
    const attempt = () => approveSearchPlanDraft(EMPTY_SEARCH_PLAN, draft([{ title: 'React developer' }, { title: '##' }]), NOW);
    expect(attempt).toThrow(SearchPlanValidationError);
    expect(attempt).toThrow('Title 2 ("##") has no letters or numbers, so no source can search for it. Change it or remove it.');
    // A malformed draft from the page is also a readable refusal.
    expect(() => parseSearchPlanDraft({ variants: 'React developer' })).toThrow(SearchPlanValidationError);
    expect(() => parseSearchPlanDraft({ variants: 'React developer' })).toThrow(/not in the expected form/);
    // Symbol-only suggestions are never stored for review either.
    const suggested = addSearchPlanSuggestions(EMPTY_SEARCH_PLAN, 'toolkit', [{ title: '###' }, { title: 'UI engineer' }], NOW);
    expect(suggested.suggestions.map((entry) => entry.title)).toEqual(['UI engineer']);
  });

  it('tells a damaged file, a newer-version file and an unopenable file apart, and keeps exact bytes in a backup', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'ovr-search-plan-'));
    const file = path.join(directory, 'search-plan-v1.json');

    await writeFile(file, '{ not json', 'utf8');
    await expect(loadSearchPlan(file)).rejects.toMatchObject({ name: 'SearchPlanReadError', reason: 'damaged' });

    await writeFile(file, JSON.stringify({ schemaVersion: 1, revision: 'x' }), 'utf8');
    await expect(loadSearchPlan(file)).rejects.toMatchObject({ reason: 'damaged' });

    const future = `${JSON.stringify({ schemaVersion: 2, revision: 9, variants: [{ id: 'a', title: 'Future title', weight: 3 }] })}\n`;
    await writeFile(file, future, 'utf8');
    const error = await loadSearchPlan(file).catch((caught: unknown) => caught);
    expect(isSearchPlanReadError(error)).toBe(true);
    expect((error as SearchPlanReadError).reason).toBe('newer_version');
    expect((error as SearchPlanReadError).message).toMatch(/newer version .* \(plan format 2\)\. This version cannot read it and will not change it\./);

    const backup = await backupUnreadableSearchPlan(file, NOW);
    expect(path.basename(backup)).toBe('search-plan-v1.json.unreadable-2026-10-29T10-00-00-000Z.bak');
    expect(await readFile(backup, 'utf8')).toBe(future);
    // A second backup at the same moment never overwrites the first.
    const second = await backupUnreadableSearchPlan(file, NOW);
    expect(second).not.toBe(backup);
    expect((await readdir(directory)).filter((name) => name.endsWith('.bak'))).toHaveLength(2);
    // The read and the backup left the original file untouched.
    expect(await readFile(file, 'utf8')).toBe(future);

    await expect(loadSearchPlan(directory)).rejects.toMatchObject({ reason: 'unreadable' });
  });
});
