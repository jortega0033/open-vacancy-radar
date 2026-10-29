import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

/**
 * Issue #686 -- the person's reviewed search plan: what work they want to be searched for, as an
 * ordered set of equivalent titles, the working language each title is written in, and the markets
 * they care about.
 *
 * Three rules shape everything here:
 *
 * 1. Desired work is not a candidate fact. The plan lives in its own file and never reads or writes
 *    the candidate profile (current role, skills, languages the person speaks).
 * 2. Only an APPROVED variant can ever reach a search. A suggestion (from the Resume Toolkit or an
 *    AI answer) is stored apart in `suggestions` and has no effect on any run until the person adds
 *    it themselves.
 * 3. A run takes a frozen copy (`captureSearchPlanSnapshot`), so editing or removing a variant
 *    changes the NEXT run only.
 */
export const SEARCH_PLAN_SCHEMA_VERSION = 1;
export const SEARCH_PLAN_MAX_VARIANTS = 12;
export const SEARCH_PLAN_MAX_MARKETS = 10;
export const SEARCH_PLAN_MAX_SUGGESTIONS = 20;
const MAX_TITLE_CHARS = 100;
const MAX_LANGUAGE_CHARS = 40;
const MAX_FUNCTION_CHARS = 100;

export const searchPlanVariantOriginSchema = z.enum(['user', 'toolkit', 'ai']);
export type SearchPlanVariantOrigin = z.infer<typeof searchPlanVariantOriginSchema>;

export const searchPlanVariantSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  /** The working language this title is written in, as the person chose it. Empty = not stated. */
  language: z.string().trim().max(MAX_LANGUAGE_CHARS),
  origin: searchPlanVariantOriginSchema,
});
export type SearchPlanVariant = z.infer<typeof searchPlanVariantSchema>;

export const searchPlanSuggestionSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  language: z.string().trim().max(MAX_LANGUAGE_CHARS),
  origin: z.enum(['toolkit', 'ai']),
  suggestedAt: z.string(),
});
export type SearchPlanSuggestion = z.infer<typeof searchPlanSuggestionSchema>;

export const searchPlanSchema = z.object({
  schemaVersion: z.literal(SEARCH_PLAN_SCHEMA_VERSION),
  /** Counts approved changes only; suggestions never move it. */
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  primaryFunction: z.string().trim().max(MAX_FUNCTION_CHARS),
  variants: z.array(searchPlanVariantSchema).max(SEARCH_PLAN_MAX_VARIANTS),
  markets: z.array(z.string().trim().min(1).max(100)).max(SEARCH_PLAN_MAX_MARKETS),
  suggestions: z.array(searchPlanSuggestionSchema).max(SEARCH_PLAN_MAX_SUGGESTIONS),
});
export type SearchPlan = z.infer<typeof searchPlanSchema>;

/** What the renderer may send when it saves the plan. Ids, revision and suggestions are not its to set. */
export const searchPlanDraftSchema = z.object({
  primaryFunction: z.string().max(MAX_FUNCTION_CHARS * 3).default(''),
  variants: z
    .array(
      z.object({
        title: z.string(),
        language: z.string().default(''),
        origin: searchPlanVariantOriginSchema.default('user'),
      }),
    )
    .max(SEARCH_PLAN_MAX_VARIANTS * 3),
  markets: z.array(z.string()).max(SEARCH_PLAN_MAX_MARKETS * 3).default([]),
});
export type SearchPlanDraft = z.infer<typeof searchPlanDraftSchema>;

export const EMPTY_SEARCH_PLAN: SearchPlan = Object.freeze({
  schemaVersion: SEARCH_PLAN_SCHEMA_VERSION,
  revision: 0,
  updatedAt: '',
  primaryFunction: '',
  variants: [],
  markets: [],
  suggestions: [],
}) as SearchPlan;

function squash(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

/** Same title written in the same language is one variant, however it is cased or spaced. */
export function searchPlanVariantKey(title: string, language: string): string {
  return `${squash(title).toLocaleLowerCase()}::${squash(language).toLocaleLowerCase()}`;
}

/** Stable id derived from the content, so the same variant keeps its id across edits and runs. */
export function searchPlanVariantId(title: string, language: string): string {
  return searchPlanVariantKey(title, language)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
}

function boundedText(value: string, max: number): string {
  return Array.from(squash(value)).slice(0, max).join('');
}

/**
 * Trims, de-duplicates and bounds a draft into the approved content of a plan. Blank titles are
 * dropped, order is kept, and a title that appears twice in the same language keeps its first place.
 */
export function normalizeSearchPlanDraft(draft: SearchPlanDraft): {
  primaryFunction: string;
  variants: SearchPlanVariant[];
  markets: string[];
} {
  const seen = new Set<string>();
  const variants: SearchPlanVariant[] = [];
  for (const raw of draft.variants) {
    const title = boundedText(raw.title, MAX_TITLE_CHARS);
    if (!title) continue;
    const language = boundedText(raw.language, MAX_LANGUAGE_CHARS);
    const key = searchPlanVariantKey(title, language);
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({ id: searchPlanVariantId(title, language), title, language, origin: raw.origin });
    if (variants.length === SEARCH_PLAN_MAX_VARIANTS) break;
  }
  const markets: string[] = [];
  for (const raw of draft.markets) {
    const market = boundedText(raw, 100);
    if (market && !markets.some((existing) => existing.toLocaleLowerCase() === market.toLocaleLowerCase())) {
      markets.push(market);
    }
    if (markets.length === SEARCH_PLAN_MAX_MARKETS) break;
  }
  return { primaryFunction: boundedText(draft.primaryFunction, MAX_FUNCTION_CHARS), variants, markets };
}

function approvedContentKey(content: { primaryFunction: string; variants: readonly SearchPlanVariant[]; markets: readonly string[] }): string {
  return JSON.stringify([
    content.primaryFunction,
    content.variants.map((variant) => [variant.id, variant.title, variant.language, variant.origin]),
    content.markets,
  ]);
}

/**
 * Applies an approved edit. The revision moves only when the approved content actually changed, and
 * a suggestion that has now been approved leaves the suggestion list.
 */
export function approveSearchPlanDraft(current: SearchPlan, draft: SearchPlanDraft, now: Date = new Date()): SearchPlan {
  const content = normalizeSearchPlanDraft(draft);
  const changed = approvedContentKey(content) !== approvedContentKey(current);
  const approved = new Set(content.variants.map((variant) => searchPlanVariantKey(variant.title, variant.language)));
  return searchPlanSchema.parse({
    schemaVersion: SEARCH_PLAN_SCHEMA_VERSION,
    revision: changed ? current.revision + 1 : current.revision,
    updatedAt: changed ? now.toISOString() : current.updatedAt,
    ...content,
    suggestions: current.suggestions.filter(
      (suggestion) => !approved.has(searchPlanVariantKey(suggestion.title, suggestion.language)),
    ),
  });
}

const suggestionInputSchema = z.object({
  title: z.string(),
  language: z.string().default(''),
});

/**
 * Records suggestions for review. They never touch `variants` or `revision`: a title already in the
 * plan, or already suggested, is skipped, and an oversized batch is bounded instead of rejected.
 */
export function addSearchPlanSuggestions(
  current: SearchPlan,
  origin: 'toolkit' | 'ai',
  inputs: readonly unknown[],
  now: Date = new Date(),
): SearchPlan {
  const known = new Set([
    ...current.variants.map((variant) => searchPlanVariantKey(variant.title, variant.language)),
    ...current.suggestions.map((suggestion) => searchPlanVariantKey(suggestion.title, suggestion.language)),
  ]);
  const added: SearchPlanSuggestion[] = [];
  for (const raw of inputs) {
    const parsed = suggestionInputSchema.safeParse(raw);
    if (!parsed.success) continue;
    const title = boundedText(parsed.data.title, MAX_TITLE_CHARS);
    if (!title) continue;
    const language = boundedText(parsed.data.language, MAX_LANGUAGE_CHARS);
    const key = searchPlanVariantKey(title, language);
    if (known.has(key)) continue;
    known.add(key);
    added.push({ id: searchPlanVariantId(title, language), title, language, origin, suggestedAt: now.toISOString() });
  }
  return searchPlanSchema.parse({
    ...current,
    suggestions: [...current.suggestions, ...added].slice(0, SEARCH_PLAN_MAX_SUGGESTIONS),
  });
}

export function dismissSearchPlanSuggestion(current: SearchPlan, id: string): SearchPlan {
  return searchPlanSchema.parse({
    ...current,
    suggestions: current.suggestions.filter((suggestion) => suggestion.id !== id),
  });
}

/** True when at least one approved title exists, which is what makes the plan usable for a run. */
export function isSearchPlanUsable(plan: Pick<SearchPlan, 'variants'>): boolean {
  return plan.variants.length > 0;
}

/**
 * The frozen description of a plan that one scan run carries. It holds copies of the approved text,
 * never references into the saved plan, so nothing done to the plan afterwards can reach it.
 */
export interface SearchPlanSnapshot {
  readonly schemaVersion: typeof SEARCH_PLAN_SCHEMA_VERSION;
  readonly revision: number;
  readonly primaryFunction: string;
  readonly variants: readonly Readonly<SearchPlanVariant>[];
  readonly markets: readonly string[];
  /** The distinct working languages the person selected on their approved titles, in plan order. */
  readonly workingLanguages: readonly string[];
}

export function captureSearchPlanSnapshot(plan: SearchPlan): SearchPlanSnapshot {
  const workingLanguages: string[] = [];
  for (const variant of plan.variants) {
    if (variant.language && !workingLanguages.some((value) => value.toLocaleLowerCase() === variant.language.toLocaleLowerCase())) {
      workingLanguages.push(variant.language);
    }
  }
  return Object.freeze({
    schemaVersion: SEARCH_PLAN_SCHEMA_VERSION,
    revision: plan.revision,
    primaryFunction: plan.primaryFunction,
    variants: Object.freeze(plan.variants.map((variant) => Object.freeze({ ...variant }))),
    markets: Object.freeze([...plan.markets]),
    workingLanguages: Object.freeze(workingLanguages),
  });
}

/** A missing file is the empty plan; a damaged one throws, exactly like the candidate profile. */
export async function loadSearchPlan(filePath: string): Promise<SearchPlan> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return EMPTY_SEARCH_PLAN;
    throw error;
  }
  return searchPlanSchema.parse(JSON.parse(content));
}

/** Temp-file-then-rename, so a crash mid-write cannot leave a truncated plan behind. */
export async function writeSearchPlan(filePath: string, plan: SearchPlan): Promise<void> {
  const validated = searchPlanSchema.parse(plan);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}
