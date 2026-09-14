import {
  describeCvSourceContentGaps,
  selectSourceProjects,
  type CvSourceContact,
  type CvSourceDocument,
  type CvSourceEducationEntry,
  type CvSourceExperienceEntry,
  type CvSourceProjectEntry,
} from './workspace/cv-source-schema.js';
import type { CvProfile, LetterLength, LetterType } from './workspace/types.js';
import type { CandidateProfile, WorkEligibilityEvidence } from '@open-vacancy-radar/vacancy-engine';

/**
 * The shared generation input bundle (issue #281, research item R08).
 *
 * Before this, each drafting path gathered its own inputs: the CV features clamped the CV at
 * 14,000 characters and the job description at one limit, the unattended structured path used a
 * different one, the letters feature bounded its own instructions, and nothing carried the
 * reviewed source CV (#274), the candidate's preferences, the eligibility evidence (#280) or the
 * employer's own form questions into the same place. `jdComplete` defaulted to `true` on the
 * attempt record, so a job description nobody had read to the end was recorded as a complete one.
 *
 * This module is the one contract all of that goes through. Four properties it exists to hold, and
 * the reason each is here rather than in a prompt sentence:
 *
 * 1. **Nothing is dropped silently.** Every clamp is recorded as an `ExtractionRecord` with the
 *    characters seen against the characters there were, and a critical requirement sitting past a
 *    prompt's character budget is hoisted out of the full text into `criticalRequirements`, so it
 *    reaches the document and the eligibility read even when the body it came from does not.
 * 2. **Fitting a budget is not the same as being complete.** `assessJdCompleteness` reads the
 *    posting itself: an empty description, a stub too thin to state requirements, and a page that
 *    was cut off at the source are all incomplete however comfortably they fit in 6,000
 *    characters. Incompleteness is a recoverable readiness state with a stated resolution, never a
 *    silent pass and never a hard dead end.
 * 3. **The source CV is read, never written.** The bundle deep-copies and freezes the reviewed
 *    source, so no amount of downstream document building can edit the record the candidate
 *    confirmed.
 * 4. **Nothing is invented to fit.** Preferences and eligibility answers are three-valued the way
 *    #280 made them, and the prompt-facing helpers can only phrase an answer that was actually
 *    recorded. `describeUnsupportedClaims` is the structural half of that: a finished document
 *    that asserts a mobility, language or contact fact the bundle has no support for is detectable
 *    from its own text.
 *
 * Deliberately free of runtime `node:`/`electron` imports, the same discipline as
 * `cv-source-schema.ts` and `resume-schema.ts`: this is bundled into both the renderer (which
 * builds interactive prompts) and the Electron main process (which stages unattended documents),
 * and that is only safe while it touches no Node- or Electron-only API. The two `import type`
 * lines above are erased at compile time.
 */

/** Bumped whenever the bundle's own shape changes in a way that should invalidate cached
 * artifacts built from an older shape. It is part of the fingerprint below for exactly that. */
export const GENERATION_INPUT_BUNDLE_VERSION = 1;

/* ------------------------------------------------------------------ budgets ------------------- */

/**
 * Every character budget any generation path applies, in one table.
 *
 * The ticket's first piece of evidence is that these numbers were scattered: `prompts.ts` held a
 * CV limit and two different job-description limits, `letters/prompt.ts` held an instruction
 * limit, and none of them knew about the others. The prompt modules now read their constants from
 * here, so "which limit did this path use" has one answer.
 */
export const GENERATION_INPUT_BUDGETS = {
  /** A flat summary read of a CV: the top of the document is a fair summary of the document. */
  summaryCvChars: 14_000,
  /** The full structured source read (#274): a CV whose projects sit at the end must be seen. */
  sourceCvChars: 200_000,
  /** Interactive drafting, where the run is in front of a person waiting for it. */
  interactiveJdChars: 6_000,
  /** The unattended structured path, which reads the whole posting. */
  unattendedJdChars: 60_000,
  /** The candidate's own free-text steer. */
  candidateInstructionChars: 1_000,
  /** One `Label: value` line. A 200 KB job title is not a job title. */
  vacancyFieldChars: 300,
} as const;

/* -------------------------------------------------------------- document types ---------------- */

/**
 * Everything this app generates. `LetterType` is imported rather than re-spelled so a fifth letter
 * type cannot appear in the letters feature without this union and the tables below accounting for
 * it.
 */
export type GenerationDocumentType = 'tailored_cv' | LetterType;

export const GENERATION_DOCUMENT_TYPES: readonly GenerationDocumentType[] = [
  'tailored_cv',
  'motivation_letter',
  'cover_letter',
  'recruiter_message',
  'short_application_message',
];

/** Re-exported under a neutral name so nothing outside the letters feature has to import a
 * letter-shaped type to say how long a document should be. */
export type GenerationLength = LetterLength;

/**
 * What each document structurally is. Moved here from `letters/prompt.ts` (where the four letter
 * entries were first written, #155/#136) so one table answers "what does this document have to
 * contain" for the CV path too, rather than each generator holding its own idea of it.
 *
 * The differences between the entries are the point: a cover letter that reads like a motivation
 * letter, or a form answer that opens with "Dear hiring team", is the failure this table prevents.
 */
export const DOCUMENT_SHAPE: Record<GenerationDocumentType, readonly string[]> = {
  tailored_cv: [
    'stays the candidate’s own CV, reordered and re-emphasized for this posting, with every employer, title and date unchanged',
    'leads with the experience this vacancy actually asks for',
    'carries every project the candidate selected below, and no project they did not',
  ],
  motivation_letter: [
    'opens by naming the role and the company and stating, in one specific sentence, why this candidate is writing',
    'connects concrete experience from the CV to what this vacancy actually asks for, with real examples rather than adjectives',
    'closes briefly and without pressure',
  ],
  cover_letter: [
    'opens by naming the role and where it was found, then states the single strongest reason this candidate fits it',
    'gives evidence from the CV for that claim, and covers the most important requirement in the posting the candidate does meet',
    'closes with a plain statement of availability or interest, without pressure',
  ],
  recruiter_message: [
    'reads as a direct message, not a letter: one greeting line, no address block, no formal sign-off beyond a name-less closing line',
    'leads with the role and the one piece of the CV most relevant to it',
    'ends with a single low-pressure ask, such as a short call or the next step in their process',
  ],
  short_application_message: [
    'reads as the free-text box on an application form: no salutation, no sign-off, no letterhead',
    'names the role and gives the two most relevant pieces of evidence from the CV, and nothing else',
  ],
};

/**
 * Length is relative to the document, not absolute: a "detailed" recruiter message is still far
 * shorter than a "short" motivation letter. `tailored_cv` has no word range at all, because a CV's
 * length is the candidate's real history rather than a setting.
 */
export const DOCUMENT_LENGTH_WORDS: Record<GenerationDocumentType, Record<GenerationLength, string> | null> = {
  tailored_cv: null,
  motivation_letter: { short: '180-250', standard: '250-350', detailed: '350-500' },
  cover_letter: { short: '180-250', standard: '250-350', detailed: '350-500' },
  recruiter_message: { short: '60-90', standard: '90-140', detailed: '140-200' },
  short_application_message: { short: '40-70', standard: '70-110', detailed: '110-160' },
};

/** The job-description budget this document's generation path actually reads. */
export function jdBudgetFor(documentType: GenerationDocumentType): number {
  return documentType === 'tailored_cv'
    ? GENERATION_INPUT_BUDGETS.unattendedJdChars
    : GENERATION_INPUT_BUDGETS.interactiveJdChars;
}

/* --------------------------------------------------------------- the vacancy ------------------ */

/**
 * The vacancy fields a generation path needs.
 *
 * A structural subset, for the same reason `VacancyLead` is one of `DiscoveryVacancyAudit`: the
 * renderer's `VacancyLead` satisfies this without an adapter, and this module keeps no build-time
 * coupling to either.
 */
export interface GenerationVacancy {
  title: string;
  company: string;
  location: string;
  url: string;
  description?: string | null;
  requirements?: string[] | null;
  employmentType?: string | null;
  currency?: string | null;
  salaryPeriod?: string | null;
  advertisedMinimum?: number | null;
  /** ISO-8601 of when the posting text was captured, when the source carried one. */
  observedAt?: string | null;
}

/** The description and requirement lines as one body, exactly the text `formatVacancy` clamps. */
export function jobDescriptionBody(vacancy: GenerationVacancy): string {
  const requirements = (vacancy.requirements ?? []).filter((line) => line.trim().length > 0);
  return [vacancy.description ?? '', requirements.map((line) => `- ${line}`).join('\n')]
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
    .trim();
}

/* ------------------------------------------------------------- JD completeness ---------------- */

export type JdIncompleteReason =
  /** No description text and no requirement lines at all. */
  | 'no_posting_text'
  /** There is text, but not enough of it to be the posting rather than a teaser for it. */
  | 'posting_text_too_thin'
  /** Text exists and states nothing a candidate would be measured against. */
  | 'no_requirements_captured'
  /** The captured text ends mid-posting: an ellipsis, a "read more" control, or our own clamp. */
  | 'truncated_at_source';

/**
 * Below this, a description is a search-result teaser rather than a posting. Deliberately a
 * character floor and not a ceiling: the ticket's point is that *fitting* a budget proves nothing,
 * so completeness is judged on what the text contains, never on it being short enough to send.
 */
export const MIN_COMPLETE_JD_BODY_CHARS = 400;

/** Markers that the captured text stops before the posting does. */
const SOURCE_TRUNCATION_MARKERS: readonly RegExp[] = [
  /\[…truncated at [\d,]+ characters\]/u,
  /\b(?:read|show|see|view)\s+(?:the\s+)?(?:more|full\s+(?:description|posting|job\s+description))\b/iu,
  /\bcontinue\s+reading\b/iu,
  /(?:…|\.\.\.)\s*$/u,
];

/**
 * Phrases that mark a line as something the candidate is actually measured against. Used twice:
 * to decide whether a posting captured any requirements at all, and to hoist the critical ones out
 * of a body that a prompt budget will not carry in full.
 */
const CRITICAL_REQUIREMENT_PATTERN =
  /\b(?:must|required|requires|requirement|mandatory|essential|minimum|at least|you have|you'll need|you will need|native|fluent|fluency|degree|bachelor|master|certification|certified|clearance|licen[cs]e|visa|work permit|eligib\w*|authoris\w*|authoriz\w*|years of experience)\b/iu;

export interface JdCompleteness {
  /** True only when none of the reasons below apply. Never defaulted to true. */
  complete: boolean;
  reasons: JdIncompleteReason[];
  /** One sentence per reason, in the user's terms. */
  details: string[];
  bodyChars: number;
  requirementLineCount: number;
}

function splitLines(body: string): string[] {
  return body
    .split(/\n+/u)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/u))
    .map((line) => line.replace(/^\s*[-*•]\s*/u, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * Reads the posting itself rather than the budget it happens to fit into (#281's second
 * acceptance check). An empty description, a one-line stub, a body that states no requirement, and
 * a page cut off by a "read more" control are each incomplete, and each says which it is.
 */
export function assessJdCompleteness(vacancy: GenerationVacancy): JdCompleteness {
  const body = jobDescriptionBody(vacancy);
  const lines = splitLines(body);
  const requirementLines = lines.filter((line) => CRITICAL_REQUIREMENT_PATTERN.test(line));
  const reasons: JdIncompleteReason[] = [];
  const details: string[] = [];

  if (body.length === 0) {
    reasons.push('no_posting_text');
    details.push(
      'No posting text was captured for this vacancy, so nothing is known about what it asks for beyond its title and location.',
    );
  } else if (body.length < MIN_COMPLETE_JD_BODY_CHARS) {
    reasons.push('posting_text_too_thin');
    details.push(
      `Only ${body.length.toLocaleString('en-US')} characters of posting text were captured, which is a listing summary rather than the posting itself.`,
    );
  }

  if (body.length > 0 && requirementLines.length === 0) {
    reasons.push('no_requirements_captured');
    details.push(
      'The captured text states nothing the candidate would be measured against, so a document written from it would be guessing at the requirements.',
    );
  }

  if (SOURCE_TRUNCATION_MARKERS.some((pattern) => pattern.test(body))) {
    reasons.push('truncated_at_source');
    details.push('The captured text stops before the posting does: it still carries the source page’s own cut-off marker.');
  }

  return {
    complete: reasons.length === 0,
    reasons,
    details,
    bodyChars: body.length,
    requirementLineCount: requirementLines.length,
  };
}

/** One hoisted requirement line, capped so a hostile posting cannot spend the whole budget here. */
const MAX_CRITICAL_REQUIREMENT_CHARS = 240;
export const MAX_CRITICAL_REQUIREMENTS = 20;

/**
 * Pulls the requirement-shaped lines out of the *whole* posting, before any prompt budget is
 * applied (#281's first acceptance check).
 *
 * This is what stops a mandatory language, a visa condition or a minimum-years line that happens
 * to sit at character 9,000 of a long posting from vanishing when the body is clamped to 6,000:
 * the clamp still applies to the body, and these lines travel separately, in full, into every
 * document prompt and into the readiness read. Requirement bullets are scanned before the
 * description so a posting that lists them explicitly gets its own list first.
 */
export function extractCriticalRequirements(vacancy: GenerationVacancy): string[] {
  const bulletLines = (vacancy.requirements ?? []).map((line) => line.trim()).filter((line) => line.length > 0);
  const descriptionLines = splitLines((vacancy.description ?? '').trim());
  const seen = new Set<string>();
  const critical: string[] = [];
  for (const line of [...bulletLines, ...descriptionLines]) {
    if (!CRITICAL_REQUIREMENT_PATTERN.test(line)) continue;
    const capped =
      line.length <= MAX_CRITICAL_REQUIREMENT_CHARS
        ? line
        : `${line.slice(0, MAX_CRITICAL_REQUIREMENT_CHARS - 1).trimEnd()}…`;
    const key = capped.toLowerCase().replace(/\s+/gu, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    critical.push(capped);
    if (critical.length >= MAX_CRITICAL_REQUIREMENTS) break;
  }
  return critical;
}

/* ------------------------------------------------------------ extraction ledger --------------- */

export type ExtractionField = 'source_cv_text' | 'job_description' | 'candidate_instructions';

/**
 * What was read, against what there was to read. Present for every input whether or not it was
 * truncated, so "nothing was dropped" is a recorded fact rather than the absence of a record.
 */
export interface ExtractionRecord {
  field: ExtractionField;
  sourceChars: number;
  includedChars: number;
  truncated: boolean;
  /** One sentence in the user's terms, always populated. */
  detail: string;
}

const EXTRACTION_FIELD_LABEL: Record<ExtractionField, string> = {
  source_cv_text: 'the CV text',
  job_description: 'the job description',
  candidate_instructions: 'the candidate’s own instructions',
};

export function recordExtraction(field: ExtractionField, text: string, budget: number): ExtractionRecord {
  const sourceChars = text.trim().length;
  const truncated = sourceChars > budget;
  const includedChars = truncated ? budget : sourceChars;
  return {
    field,
    sourceChars,
    includedChars,
    truncated,
    detail: truncated
      ? `${EXTRACTION_FIELD_LABEL[field]} was read to ${includedChars.toLocaleString('en-US')} of ${sourceChars.toLocaleString('en-US')} characters, so the rest of it did not reach this document.`
      : `${EXTRACTION_FIELD_LABEL[field]} was read in full (${sourceChars.toLocaleString('en-US')} characters).`,
  };
}

/* ---------------------------------------------------------------- preferences ----------------- */

/** How much a document may say about where the candidate can work from. */
export type MobilityDisclosure = 'omit' | 'state_if_relevant' | 'always_state';

/**
 * The candidate's own settings, as the generation paths need them.
 *
 * Every value here is either the candidate's or explicitly unset. There is no shipped country, no
 * shipped language and no shipped answer to "would you relocate": an unset field stays unset and
 * the documents say nothing about it, which is the only honest behaviour and the one this app's
 * no-default-bias rule requires.
 */
export interface GenerationPreferences {
  /** The language documents should be written in. Empty means "whatever the vacancy is written
   * in": the app ships no language of its own, so nothing here hardcodes English. */
  documentLanguage: string;
  /** The country the candidate would actually work from. Empty means not configured. */
  workCountry: string;
  /** Free text, read as a list, exactly as `CandidateProfile.constraints.professionalLanguage` is. */
  professionalLanguages: string;
  /** The candidate's own answer. `null` means they have never given one. */
  relocationWilling: boolean | null;
  /** Whether an Employer of Record arrangement is acceptable to them. `null` means never answered. */
  eorAcceptable: boolean | null;
  mobilityDisclosure: MobilityDisclosure;
}

/**
 * A profile nobody has filled in yet. Note what is absent: no country, no language, no relocation
 * or EOR answer. `mobilityDisclosure` is the one field with a starting value, and it is the
 * conservative one: mention where the candidate can work only when the vacancy's own evidence
 * makes it relevant, rather than volunteering it on every document or suppressing it entirely.
 */
export const UNCONFIGURED_GENERATION_PREFERENCES: GenerationPreferences = {
  documentLanguage: '',
  workCountry: '',
  professionalLanguages: '',
  relocationWilling: null,
  eorAcceptable: null,
  mobilityDisclosure: 'state_if_relevant',
};

/**
 * Bridges the search-side `CandidateProfile` (#280's own input) into these preferences.
 *
 * `documentLanguage` deliberately does not come from `professionalLanguage`: the languages someone
 * can work in and the language a specific application should be written in are different
 * questions, and answering the second with the first is exactly the kind of assumption the rest of
 * this module exists to refuse.
 */
export function generationPreferencesFromCandidateProfile(
  profile: CandidateProfile,
  overrides: Partial<GenerationPreferences> = {},
): GenerationPreferences {
  return {
    ...UNCONFIGURED_GENERATION_PREFERENCES,
    workCountry: profile.constraints.primaryCountry,
    professionalLanguages: profile.constraints.professionalLanguage,
    relocationWilling: profile.constraints.relocationWilling ?? null,
    ...overrides,
  };
}

/* ------------------------------------------------------------ form requirements --------------- */

/**
 * One question the employer's own application form asks, with whatever limit it imposes.
 *
 * Carried on the bundle rather than discovered by each generator because a 1,000-character box and
 * a "Why do you want to work here?" prompt change what the document has to be, and a generator
 * that never saw them produces something the form will reject or silently cut.
 */
export interface FormFieldRequirement {
  id: string;
  /** The employer's own question, verbatim. */
  prompt: string;
  required: boolean;
  maxChars: number | null;
  maxWords: number | null;
}

export interface DocumentConstraints {
  /** What this document type structurally has to contain. */
  shape: readonly string[];
  /** e.g. "250-350". Empty for a CV, whose length is the candidate's real history. */
  wordRange: string;
  /** The tightest character limit any required form field imposes, or null when none does. */
  maxChars: number | null;
  /** The tightest word limit any required form field imposes, or null when none does. */
  maxWords: number | null;
  /** The employer's own questions this document has to answer, in form order. */
  formPrompts: readonly FormFieldRequirement[];
}

function tightest(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);
  return present.length === 0 ? null : Math.min(...present);
}

/**
 * Resolves what this specific document has to look like: its own shape and word range, narrowed by
 * whatever the target's form actually allows. A form limit always wins over the app's word range,
 * because one of them is a preference and the other is a hard rejection.
 */
export function resolveDocumentConstraints(
  documentType: GenerationDocumentType,
  length: GenerationLength,
  formRequirements: readonly FormFieldRequirement[] = [],
): DocumentConstraints {
  const lengths = DOCUMENT_LENGTH_WORDS[documentType];
  return {
    shape: DOCUMENT_SHAPE[documentType],
    wordRange: lengths === null ? '' : lengths[length],
    maxChars: tightest(formRequirements.map((field) => field.maxChars)),
    maxWords: tightest(formRequirements.map((field) => field.maxWords)),
    formPrompts: [...formRequirements],
  };
}

/* --------------------------------------------------------------- the bundle ------------------- */

export type GenerationGapCode =
  | 'jd_incomplete'
  | 'source_cv_incomplete'
  | 'source_cv_unreviewed'
  | 'input_truncated'
  | 'required_form_prompt_unanswered';

export interface GenerationGap {
  code: GenerationGapCode;
  /** What is wrong, in the user's terms. */
  detail: string;
  /** What would clear it. Every gap here is recoverable; none is a dead end. */
  resolution: string;
}

/**
 * `incomplete_input` is a real, recoverable state and not a failure: the inputs are not yet good
 * enough for a document to be treated as final, each gap says what would fix it, and a caller that
 * wants to draft anyway can still do so with the incompleteness written into the prompt. What it
 * must never do is read as `ready`.
 */
export type GenerationReadinessState = 'ready' | 'incomplete_input';

export interface GenerationReadiness {
  state: GenerationReadinessState;
  gaps: GenerationGap[];
}

export interface GenerationInputBundle {
  readonly bundleVersion: number;
  readonly documentType: GenerationDocumentType;
  readonly length: GenerationLength;
  /** The raw CV file this was built from. */
  readonly cv: { readonly fileName: string; readonly text: string };
  /** #274's reviewed structured source. Deep-copied and frozen: read here, never written. */
  readonly sourceCv: CvSourceDocument | null;
  /** `selectSourceProjects` applied once, so every document built from this bundle shows the same
   * projects in the same order. */
  readonly selectedProjects: readonly CvSourceProjectEntry[];
  /** The corrected private profile. */
  readonly profile: CvProfile | null;
  readonly vacancy: GenerationVacancy;
  readonly jd: JdCompleteness;
  /** Requirement lines from the whole posting, before any prompt budget was applied. */
  readonly criticalRequirements: readonly string[];
  readonly preferences: GenerationPreferences;
  readonly eligibility: WorkEligibilityEvidence | null;
  readonly constraints: DocumentConstraints;
  readonly extraction: readonly ExtractionRecord[];
  readonly readiness: GenerationReadiness;
}

export interface GenerationInputBundleInput {
  documentType: GenerationDocumentType;
  length?: GenerationLength;
  cv: { fileName: string; text: string };
  sourceCv?: CvSourceDocument | null;
  profile?: CvProfile | null;
  vacancy: GenerationVacancy;
  preferences?: GenerationPreferences;
  eligibility?: WorkEligibilityEvidence | null;
  formRequirements?: readonly FormFieldRequirement[];
  /** The candidate's free-text steer for this document, when they gave one. */
  instructions?: string;
}

function cloneContact(contact: CvSourceContact): CvSourceContact {
  return { ...contact, links: [...contact.links] };
}

function cloneExperience(entry: CvSourceExperienceEntry): CvSourceExperienceEntry {
  return { ...entry, bullets: [...entry.bullets] };
}

function cloneEducation(entry: CvSourceEducationEntry): CvSourceEducationEntry {
  return { ...entry };
}

function cloneProject(project: CvSourceProjectEntry): CvSourceProjectEntry {
  return { ...project, technologies: [...project.technologies], links: [...project.links] };
}

/**
 * A typed deep copy, then a deep freeze.
 *
 * Written out field by field rather than through `structuredClone` for two reasons: it cannot
 * silently carry a field this module has not accounted for, and it does not depend on a global
 * whose availability differs between the renderer, the main process and the test environment.
 *
 * The freeze is what makes "without ever modifying the user's master CV" structural rather than a
 * convention: a document builder handed this bundle cannot write through it even by accident.
 */
function freezeSource(source: CvSourceDocument): CvSourceDocument {
  const copy: CvSourceDocument = {
    ...source,
    contact: cloneContact(source.contact),
    experience: source.experience.map(cloneExperience),
    education: source.education.map(cloneEducation),
    projects: source.projects.map(cloneProject),
  };
  Object.freeze(copy.contact.links);
  Object.freeze(copy.contact);
  for (const entry of copy.experience) {
    Object.freeze(entry.bullets);
    Object.freeze(entry);
  }
  for (const entry of copy.education) Object.freeze(entry);
  for (const project of copy.projects) {
    Object.freeze(project.technologies);
    Object.freeze(project.links);
    Object.freeze(project);
  }
  Object.freeze(copy.experience);
  Object.freeze(copy.education);
  Object.freeze(copy.projects);
  return Object.freeze(copy);
}

function describeReadiness(
  jd: JdCompleteness,
  sourceCv: CvSourceDocument | null,
  extraction: readonly ExtractionRecord[],
  constraints: DocumentConstraints,
): GenerationReadiness {
  const gaps: GenerationGap[] = [];

  if (!jd.complete) {
    gaps.push({
      code: 'jd_incomplete',
      detail: jd.details.join(' '),
      resolution:
        'Open the posting and capture its full text, or mark the job description as reviewed by hand, before treating a document built from it as final.',
    });
  }

  if (sourceCv !== null) {
    for (const reason of describeCvSourceContentGaps(sourceCv)) {
      gaps.push({
        code: 'source_cv_incomplete',
        detail: reason,
        resolution: 'Re-run the source CV extraction so the whole document is read, then confirm the result.',
      });
    }
    if (sourceCv.reviewedAt.trim().length === 0) {
      gaps.push({
        code: 'source_cv_unreviewed',
        detail: 'the extracted source CV has not been reviewed and confirmed yet',
        resolution: 'Open the source CV review drawer, correct anything wrong, and confirm it.',
      });
    }
  }

  for (const record of extraction) {
    if (!record.truncated) continue;
    gaps.push({
      code: 'input_truncated',
      detail: record.detail,
      resolution:
        'Shorten this input, or generate through a path with a larger budget, so the whole of it reaches the document.',
    });
  }

  for (const field of constraints.formPrompts) {
    if (!field.required || field.prompt.trim().length > 0) continue;
    gaps.push({
      code: 'required_form_prompt_unanswered',
      detail: `the target's form has a required field ("${field.id}") whose question was never captured`,
      resolution: 'Capture the form field’s own question so the document can answer it.',
    });
  }

  return { state: gaps.length === 0 ? 'ready' : 'incomplete_input', gaps };
}

/**
 * Assembles one bundle. Pure: no I/O, no clock, no randomness, so the same inputs always produce
 * the same bundle and therefore the same fingerprint.
 */
export function buildGenerationInputBundle(input: GenerationInputBundleInput): GenerationInputBundle {
  const length: GenerationLength = input.length ?? 'standard';
  const sourceCv = input.sourceCv ? freezeSource(input.sourceCv) : null;
  const constraints = resolveDocumentConstraints(input.documentType, length, input.formRequirements ?? []);

  const cvBudget = sourceCv === null ? GENERATION_INPUT_BUDGETS.summaryCvChars : GENERATION_INPUT_BUDGETS.sourceCvChars;
  const extraction: ExtractionRecord[] = [
    recordExtraction('source_cv_text', input.cv.text, cvBudget),
    recordExtraction('job_description', jobDescriptionBody(input.vacancy), jdBudgetFor(input.documentType)),
  ];
  if (input.instructions !== undefined && input.instructions.trim().length > 0) {
    extraction.push(
      recordExtraction('candidate_instructions', input.instructions, GENERATION_INPUT_BUDGETS.candidateInstructionChars),
    );
  }

  const jd = assessJdCompleteness(input.vacancy);

  return Object.freeze({
    bundleVersion: GENERATION_INPUT_BUNDLE_VERSION,
    documentType: input.documentType,
    length,
    cv: Object.freeze({ fileName: input.cv.fileName, text: input.cv.text }),
    sourceCv,
    selectedProjects: Object.freeze(sourceCv === null ? [] : selectSourceProjects(sourceCv)),
    profile: input.profile ?? null,
    vacancy: input.vacancy,
    jd,
    criticalRequirements: Object.freeze(extractCriticalRequirements(input.vacancy)),
    preferences: input.preferences ?? UNCONFIGURED_GENERATION_PREFERENCES,
    eligibility: input.eligibility ?? null,
    constraints,
    extraction: Object.freeze(extraction),
    readiness: describeReadiness(jd, sourceCv, extraction, constraints),
  });
}

/* ------------------------------------------------------------- prompt context ----------------- */

/**
 * The bundle's contribution to a prompt, as plain data.
 *
 * Deliberately strings rather than a bundle reference: `cv/prompts.ts` and `letters/prompt.ts`
 * keep owning every word they send (the whole reason prompt text lives in those two reviewable
 * modules), and this type only says *where* the bundle's extra rules and labelled blocks are
 * spliced in. The phrasing itself is built by `components/generation/prompts.ts`, which is the one
 * place that turns a bundle into sentences.
 */
export interface GenerationPromptContext {
  /** Extra rule lines, placed with the document's other rules and before any data block. */
  rules: readonly string[];
  /** Extra `=== LABEL ===` blocks, placed before the candidate CV block. */
  blocks: readonly string[];
}

/* ------------------------------------------------------------- cache invalidation ------------- */

/**
 * A deterministic projection of everything that can change what a document says.
 *
 * Only fields that actually reach a document are included, and they are included in a fixed order:
 * a fingerprint that changed when an irrelevant field did would invalidate good artifacts, and one
 * that missed a relevant field would keep a stale document looking valid, which is the failure
 * #281's last acceptance check is about.
 */
function fingerprintProjection(bundle: GenerationInputBundle): unknown[] {
  return [
    bundle.bundleVersion,
    bundle.documentType,
    bundle.length,
    bundle.cv.fileName,
    bundle.cv.text,
    bundle.sourceCv === null
      ? null
      : [
          bundle.sourceCv.contact.name,
          bundle.sourceCv.contact.title,
          bundle.sourceCv.contact.location,
          bundle.sourceCv.contact.email,
          bundle.sourceCv.contact.phone,
          [...bundle.sourceCv.contact.links],
          bundle.sourceCv.summary,
          bundle.sourceCv.experience.map((entry) => [
            entry.company,
            entry.title,
            entry.dates,
            entry.engagement,
            entry.client,
            [...entry.bullets],
          ]),
          bundle.sourceCv.education.map((entry) => [entry.institution, entry.credential, entry.dates]),
          bundle.sourceCv.complete,
          bundle.sourceCv.reviewedAt,
        ],
    bundle.selectedProjects.map((project) => [
      project.id,
      project.name,
      project.role,
      project.dates,
      project.organization,
      project.description,
      [...project.technologies],
      [...project.links],
      project.pinned,
    ]),
    bundle.profile === null
      ? null
      : [
          bundle.profile.title,
          bundle.profile.years,
          bundle.profile.location,
          bundle.profile.languages,
          [...bundle.profile.skills],
          bundle.profile.summary,
          bundle.profile.auth,
        ],
    [
      bundle.vacancy.title,
      bundle.vacancy.company,
      bundle.vacancy.location,
      bundle.vacancy.url,
      bundle.vacancy.employmentType ?? null,
      bundle.vacancy.currency ?? null,
      bundle.vacancy.salaryPeriod ?? null,
      bundle.vacancy.advertisedMinimum ?? null,
      jobDescriptionBody(bundle.vacancy),
    ],
    [bundle.jd.complete, [...bundle.jd.reasons]],
    [...bundle.criticalRequirements],
    [
      bundle.preferences.documentLanguage,
      bundle.preferences.workCountry,
      bundle.preferences.professionalLanguages,
      bundle.preferences.relocationWilling,
      bundle.preferences.eorAcceptable,
      bundle.preferences.mobilityDisclosure,
    ],
    bundle.eligibility === null
      ? null
      : [
          bundle.eligibility.candidateWorkCountry.answer,
          bundle.eligibility.candidateWorkCountry.detail,
          bundle.eligibility.mandatoryLanguage.answer,
          bundle.eligibility.mandatoryLanguage.detail,
          bundle.eligibility.visaSponsorship.answer,
          bundle.eligibility.visaSponsorship.detail,
          bundle.eligibility.employerOfRecord.answer,
          bundle.eligibility.employerOfRecord.detail,
          bundle.eligibility.candidateRelocationWillingness.answer,
          bundle.eligibility.employerRelocationSupport.answer,
          bundle.eligibility.salaryGeography.label,
        ],
    [
      [...bundle.constraints.shape],
      bundle.constraints.wordRange,
      bundle.constraints.maxChars,
      bundle.constraints.maxWords,
      bundle.constraints.formPrompts.map((field) => [field.id, field.prompt, field.required, field.maxChars, field.maxWords]),
    ],
    bundle.extraction.map((record) => [record.field, record.sourceChars, record.includedChars, record.truncated]),
    bundle.readiness.state,
  ];
}

/**
 * A change-detection fingerprint, not a security control.
 *
 * Deliberately a pure function with no `node:crypto` dependency, because this module is bundled
 * into the renderer too. The hashes that have to resist a deliberate collision -- the source CV
 * content hash, the JD snapshot hash, the accepted-document byte hash -- are sha256 and stay where
 * they are (`application-submit-gate.ts`, `document-acceptance.ts`); this one only has to change
 * when the inputs change. Four independent FNV-1a lanes give 128 bits of that.
 */
export function generationInputFingerprint(bundle: GenerationInputBundle): string {
  const serialized = JSON.stringify(fingerprintProjection(bundle));
  const offsets = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  const lanes = offsets.map((offset) => {
    let hash = offset >>> 0;
    for (let index = 0; index < serialized.length; index += 1) {
      hash ^= serialized.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  });
  return `g${bundle.bundleVersion}-${lanes.join('')}`;
}

/**
 * Whether a document generated earlier may still be presented as current.
 *
 * The comparison is against the fingerprint recorded *when the artifact was produced*, never one
 * recomputed from the artifact itself: a hash derived from the document would agree with itself
 * whatever the inputs have since become, which is exactly the silent reuse this prevents. An
 * artifact with no recorded fingerprint is stale by definition, not trusted by default.
 */
export function isGeneratedArtifactCurrent(recordedFingerprint: string | null, bundle: GenerationInputBundle): boolean {
  if (recordedFingerprint === null || recordedFingerprint.trim().length === 0) return false;
  return recordedFingerprint === generationInputFingerprint(bundle);
}

/* -------------------------------------------------------------- claim checking ---------------- */

export type UnsupportedClaimCode =
  /** A contact detail in the document that the reviewed source CV does not carry. */
  | 'fabricated_contact_fact'
  /** A statement about relocation, EOR or work authorization the bundle has no answer for. */
  | 'unsupported_mobility_claim'
  /** A language proficiency claim the candidate's own configuration does not support. */
  | 'unsupported_language_claim';

export interface UnsupportedClaim {
  code: UnsupportedClaimCode;
  detail: string;
  /** The offending fragment of the document, so the reader can find it. */
  quote: string;
}

/** Short enough for any real international number, long enough that a year or an amount is not
 * mistaken for one. */
const MIN_PHONE_DIGITS = 8;

const EMAIL_PATTERN = /[^\s<>@]+@[^\s<>@]+\.[a-z]{2,}/giu;
const PHONE_PATTERN = /\+?\d[\d\s().-]{7,}\d/gu;

const RELOCATION_CLAIM = /\bi\s+(?:am|'m)\s+(?:happy|willing|ready|open)\s+to\s+relocat\w*|\bi\s+(?:can|will|would)\s+relocat\w*/iu;
const EOR_CLAIM =
  /\bi\s+(?:can|am able to|would)\s+(?:be\s+)?(?:engaged|employed|hired|onboarded)\s+(?:through|via)\s+an?\s+(?:employer of record|eor)\b|\bi\s+(?:am|'m)\s+(?:available|happy)\s+to\s+work\s+(?:through|via)\s+an?\s+(?:employer of record|eor)\b/iu;
const WORK_AUTHORIZATION_CLAIM =
  /\bi\s+(?:am|'m)\s+(?:fully\s+)?(?:authoris\w+|authoriz\w+|eligible|permitted|entitled)\s+to\s+work\s+in\s+([^.,;\n]{2,60})/iu;
const LANGUAGE_CLAIM = /\b(?:fluent|fluency|native|bilingual|proficient)\s+(?:in|speaker of)\s+([A-Za-z][A-Za-z\s]{1,30})/giu;

function normalizeLanguageToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ');
}

function configuredLanguages(bundle: GenerationInputBundle): string[] {
  const fromPreferences = bundle.preferences.professionalLanguages;
  const fromProfile = bundle.profile?.languages ?? '';
  return [fromPreferences, fromProfile]
    .join(',')
    .split(/[,/;]|\band\b/iu)
    .map((part) => normalizeLanguageToken(part.replace(/\([^)]*\)/gu, '')))
    .filter((part) => part.length > 0);
}

function contactValues(bundle: GenerationInputBundle): string[] {
  if (bundle.sourceCv === null) return [];
  const contact = bundle.sourceCv.contact;
  return [contact.email, contact.phone, ...contact.links]
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function digitsOnly(value: string): string {
  return value.replace(/\D/gu, '');
}

/**
 * Reads a finished document back against the bundle it was supposed to be built from, and reports
 * every fact it asserts that the bundle does not support (#281's last acceptance check).
 *
 * Deliberately narrow and literal rather than a general fact-checker. Each rule targets one claim
 * a generator is actually tempted to manufacture in order to satisfy a requirement it cannot
 * otherwise meet: a contact detail that makes a form field non-empty, a relocation or EOR
 * statement that makes a location requirement go away, a fluency claim that clears a mandatory
 * language. A false positive here costs the user a glance at their own document; the failure mode
 * on the other side is an application that states something untrue about them.
 */
export function describeUnsupportedClaims(text: string, bundle: GenerationInputBundle): UnsupportedClaim[] {
  const claims: UnsupportedClaim[] = [];
  const known = contactValues(bundle);

  if (bundle.sourceCv !== null) {
    for (const match of text.matchAll(EMAIL_PATTERN)) {
      const value = match[0].toLowerCase();
      if (known.some((candidate) => candidate.includes(value))) continue;
      claims.push({
        code: 'fabricated_contact_fact',
        detail: 'the document carries an email address the reviewed source CV does not list',
        quote: match[0],
      });
    }
    // Only contact values that are themselves phone-length are compared. An email address or a
    // URL contributes no digits, and `"anything".endsWith("")` is true, so comparing against them
    // would make every number in the document look like a known one.
    const knownDigits = known.map(digitsOnly).filter((candidate) => candidate.length >= MIN_PHONE_DIGITS);
    for (const match of text.matchAll(PHONE_PATTERN)) {
      const value = digitsOnly(match[0]);
      if (value.length < MIN_PHONE_DIGITS) continue;
      if (knownDigits.some((candidate) => candidate.endsWith(value) || value.endsWith(candidate))) continue;
      claims.push({
        code: 'fabricated_contact_fact',
        detail: 'the document carries a phone number the reviewed source CV does not list',
        quote: match[0].trim(),
      });
    }
  }

  const relocation = RELOCATION_CLAIM.exec(text);
  if (relocation !== null && bundle.preferences.relocationWilling !== true) {
    claims.push({
      code: 'unsupported_mobility_claim',
      detail:
        bundle.preferences.relocationWilling === null
          ? 'the document states a willingness to relocate that the candidate has never recorded an answer to'
          : 'the document states a willingness to relocate that contradicts the candidate’s recorded answer',
      quote: relocation[0],
    });
  }

  const eor = EOR_CLAIM.exec(text);
  if (eor !== null && bundle.preferences.eorAcceptable !== true) {
    claims.push({
      code: 'unsupported_mobility_claim',
      detail:
        bundle.preferences.eorAcceptable === null
          ? 'the document offers an Employer of Record arrangement the candidate has never said is acceptable'
          : 'the document offers an Employer of Record arrangement the candidate has said is not acceptable',
      quote: eor[0],
    });
  }

  const authorization = WORK_AUTHORIZATION_CLAIM.exec(text);
  if (authorization !== null) {
    const supported =
      bundle.eligibility?.candidateWorkCountry.answer === 'yes' ||
      (bundle.profile?.auth ?? '').trim().length > 0;
    if (!supported) {
      claims.push({
        code: 'unsupported_mobility_claim',
        detail: 'the document claims work authorization that neither the eligibility evidence nor the profile supports',
        quote: authorization[0],
      });
    }
  }

  const languages = configuredLanguages(bundle);
  for (const match of text.matchAll(LANGUAGE_CLAIM)) {
    const claimed = normalizeLanguageToken(match[1] ?? '');
    if (claimed.length === 0) continue;
    if (languages.some((language) => language.includes(claimed) || claimed.includes(language))) continue;
    claims.push({
      code: 'unsupported_language_claim',
      detail: `the document claims ${match[1]?.trim() ?? 'a language'} proficiency the candidate’s configured languages do not support`,
      quote: match[0].trim(),
    });
  }

  return claims;
}
