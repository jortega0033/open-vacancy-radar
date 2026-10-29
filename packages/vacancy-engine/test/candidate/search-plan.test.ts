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

  describe('variant id slug without a backtracking regular expression (CodeQL js/polynomial-redos)', () => {
    /** The round-1 implementation, kept here only as the reference the linear one must reproduce exactly. */
    function referenceId(title: string, language: string): string {
      const squash = (value: string) => value.trim().replace(/\s+/gu, ' ');
      const key = `${squash(title).toLocaleLowerCase()}::${squash(language).toLocaleLowerCase()}`;
      const slug = key
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 60)
        .replace(/-+$/gu, '');
      let hash = 0x811c9dc5;
      for (let index = 0; index < key.length; index += 1) {
        hash ^= key.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return `${slug || 'title'}-${hash.toString(16).padStart(8, '0')}`;
    }

    it('keeps every id byte-identical to the previous implementation', () => {
      expect(searchPlanVariantId('C++ developer', '')).toBe('c-developer-c3926686');
      expect(searchPlanVariantId('C# developer', '')).toBe('c-developer-2f4a0181');
      const titles = [
        'React developer', 'Frontend engineer', 'Front-end engineer', 'Front end engineer', '--Leading and trailing--', '  ##  ',
        'Ünïcödé Entwickler', 'Frontend ontwikkelaar', '前端工程师', 'A', '-', '- -', 'a--b__c  d', 'x'.repeat(59) + ' y', 'x'.repeat(60) + ' y',
        'x'.repeat(58) + ' -- yz', 'x'.repeat(59) + '-- y', 'emoji 😀 engineer', '😀😀😀', `${'ab '.repeat(40)}end`, '𝒜𝒷𝒸 developer'.repeat(8),
        '\u0000\u0001 control', 'tab\tseparated\nlines',
      ];
      for (const language of ['', 'Dutch', 'English ', '--']) {
        for (const title of titles) expect(searchPlanVariantId(title, language), `${title}|${language}`).toBe(referenceId(title, language));
      }
      // Pseudo-random mixtures of letters, digits and separators, including surrogate pairs.
      let seed = 686;
      const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
      const alphabet = ['a', 'Z', '7', 'é', '-', '-', ' ', '_', '+', '#', '😀', '字'];
      for (let sample = 0; sample < 400; sample += 1) {
        let text = '';
        const length = next() % 140;
        for (let index = 0; index < length; index += 1) text += alphabet[next() % alphabet.length];
        expect(searchPlanVariantId(text, ''), JSON.stringify(text)).toBe(referenceId(text, ''));
      }
    });

    it('stays linear on adversarial separator runs and gives the same id as the reference', () => {
      const long = 100_000;
      const hostile = [
        '-'.repeat(long),
        `${'-'.repeat(long)}a`,
        `a${'-'.repeat(long)}`,
        `${'-'.repeat(long)}a${'-'.repeat(long)}`,
        '-a'.repeat(long / 2),
        `${'!-'.repeat(long / 2)}!`,
        `${'a-'.repeat(40)}${'-'.repeat(long)}`,
        '#'.repeat(long),
        `${' '.repeat(long)}x${' '.repeat(long)}`,
      ];
      const started = performance.now();
      const ids = hostile.map((title) => searchPlanVariantId(title, ''));
      const elapsedMs = performance.now() - started;
      // Nine strings of ~100k separators: a linear scan is a few milliseconds; a quadratic one is minutes.
      expect(elapsedMs).toBeLessThan(2_000);
      expect(ids[0]!.startsWith('title-')).toBe(true);
      expect(ids[7]!.startsWith('title-')).toBe(true);
      expect(ids[1]!.startsWith('a-')).toBe(true);
      expect(ids[3]!).toMatch(/^a-[0-9a-f]{8}$/u);
      for (const id of ids) {
        // At most 60 slug units, a dash and 8 hex digits; only letters, numbers and single inner dashes.
        expect(id.length).toBeLessThanOrEqual(60 + 2 + 8);
        expect(id).toMatch(/^[\p{L}\p{N}-]+$/u);
        expect(id).not.toContain('--');
        expect(id.startsWith('-') || id.endsWith('-')).toBe(false);
      }
      expect(new Set(ids).size).toBe(hostile.length);
      // Same ids as the reference on the shorter hostile strings the reference can still run quickly.
      for (const title of hostile.slice(0, 3).map((value) => value.slice(0, 3_000))) {
        expect(searchPlanVariantId(title, '')).toBe(referenceId(title, ''));
      }
    });
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
