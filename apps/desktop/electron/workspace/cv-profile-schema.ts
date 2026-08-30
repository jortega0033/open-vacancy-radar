import type { CvProfile } from './types.js';

/**
 * The single definition of `CvProfile`'s field list, save-time length limits, and per-field
 * meaning — consumed by three otherwise-independent call sites that used to hardcode their own
 * copy of this shape: `validate.ts` (save-time allow-list, main process), `cv-ai-parse.ts`
 * (AI-response coercion, renderer), and `prompts.ts` (the LLM prompt's JSON-schema description,
 * renderer). A field renamed or added here now changes all three by construction instead of by
 * remembering to edit three places, one of which (the prompt text) had no compiler check at all.
 *
 * Deliberately no runtime imports (the `CvProfile` import above is `import type`, erased at
 * compile time): this file is bundled into both the renderer (plain Vite) and the Electron main
 * process (`vite-plugin-electron`), and the only thing that makes that safe is that it never
 * touches an Electron- or Node-only API at runtime. `eslint.config.js` enforces this file
 * specifically with a `no-restricted-imports` rule — keep it that way rather than relying on this
 * comment alone.
 */

/** Every `CvProfile` field whose value is a plain, single-line string. `skills` and `summary` are
 * handled separately below — `skills` is an array, and `summary` gets a longer length budget. */
export const CV_PROFILE_SHORT_FIELDS = ['title', 'years', 'location', 'languages', 'auth'] as const;

export type CvProfileShortField = (typeof CV_PROFILE_SHORT_FIELDS)[number];

/** Field size budgets. Generous for real content, finite for a hostile or over-eager AI answer. */
export const CV_PROFILE_LIMITS = {
  /** Any of `CV_PROFILE_SHORT_FIELDS`, and each entry in `skills`. */
  shortField: 512,
  summary: 20_000,
  /** number of entries in `skills` */
  skills: 200,
} as const;

/**
 * Derived from `CvProfile` itself (`keyof`, erased at compile time) rather than hand-written, so a
 * field renamed or added on `CvProfile` is a compile error everywhere below until it's accounted
 * for — the whole point of this module — instead of a fifth place that can silently drift.
 */
export type CvProfileField = keyof CvProfile;

type AssertNever<T extends never> = T;

/**
 * Compile-time proof that `CV_PROFILE_SHORT_FIELDS` plus `'skills'`/`'summary'` account for every
 * `CvProfileField` and nothing more. If this line stops compiling, a field was added to `CvProfile`
 * without deciding here whether it's a short string, `skills`, or `summary` — exactly the class of
 * silent drift this module exists to prevent.
 */
type _AllFieldsClassified = AssertNever<Exclude<CvProfileField, CvProfileShortField | 'skills' | 'summary'>>;

/** Display order for the AI-parse prompt's JSON-shape line and bullet list — the field list a
 * human reads, not the validation grouping above (which splits `skills`/`summary` out because
 * they need different handling, not because they belong at the end conceptually). */
export const CV_PROFILE_FIELD_ORDER: readonly CvProfileField[] = [
  'title',
  'years',
  'location',
  'languages',
  'skills',
  'summary',
  'auth',
];

/** Compile-time proof every `CvProfileField` actually appears in `CV_PROFILE_FIELD_ORDER` — a
 * field missing from this array would otherwise compile fine and simply never appear in the
 * AI-parse prompt. */
type _FieldOrderIsComplete = AssertNever<Exclude<CvProfileField, (typeof CV_PROFILE_FIELD_ORDER)[number]>>;

/** One-line description of what each field means, reused to build the AI-parse prompt's bullet
 * list so it can never describe a field this module no longer declares. `Record<CvProfileField, _>`
 * already forces this to list every field and no others. */
export const CV_PROFILE_FIELD_DESCRIPTIONS: Record<CvProfileField, string> = {
  title: "the candidate's current or most recent job title.",
  years: 'years of relevant professional experience, as a short phrase (e.g. "5 years").',
  location: "the candidate's stated location or timezone.",
  languages: 'spoken/written languages with proficiency if stated (e.g. "Dutch (B2), English (native)").',
  auth: 'work authorization / visa status if the CV states it, otherwise "".',
  skills: 'an array of concrete technical skills actually named in the CV (technologies, frameworks, tools).',
  summary: "a 2-3 sentence neutral summary of the candidate's background, drawn only from the CV text.",
};
