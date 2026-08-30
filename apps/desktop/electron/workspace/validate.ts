/**
 * Input validation for every `workspace:*` IPC channel.
 *
 * This is the trust boundary. The renderer is the untrusted side (it renders content the app
 * fetched from the internet), so nothing it sends is allowed to reach Drizzle unexamined. Three
 * rules hold everywhere in this file:
 *
 *  1. **Allow-list, never spread.** Each parser builds a fresh object one named field at a time.
 *     An unknown property on the incoming payload cannot survive, so a renderer cannot smuggle a
 *     column (`id`, `isDefault`, …) into an update it has no business setting.
 *  2. **Every string is length-bounded.** The workspace database is on the user's disk with no
 *     quota; without a bound, one bad `create` call is an unbounded disk write.
 *  3. **Errors say what is wrong, never what was sent.** The message is echoed back through IPC
 *     and may end up in a log; the value itself might be CV text or personal notes.
 *
 * Everything here is pure: no database and no Electron. It is separate from
 * the handlers: it is exhaustively unit-testable on its own (see test/workspace-validate.test.ts).
 */

import type {
  ApplicationFilter,
  ApplicationInput,
  ApplicationPatch,
  ApplicationStatus,
  AppSettingsPatch,
  CvDocumentInput,
  CvDocumentPatch,
  CvKind,
  CvProfile,
  DefaultAiProvider,
  DensityPreference,
  LetterInput,
  LetterLength,
  LetterPatch,
  LetterStatus,
  LetterTone,
  LetterType,
  Market,
  SavedJobInput,
  SavedJobPatch,
  SavedJobStatus,
  SidebarStartPreference,
  StartPage,
  ThemePreference,
} from './types.js';

/** Field size budgets. Generous for real content, finite for a hostile caller. */
export const LIMITS = {
  /** id / role / company / location / url / status-ish free text */
  short: 512,
  /** notes, summaries, next steps */
  medium: 20_000,
  /** an extracted CV; a long PDF is realistically well under this */
  cvText: 2_000_000,
  /** a generated letter */
  letterBody: 200_000,
  /** number of entries in cvProfile.skills */
  skills: 200,
} as const;

export class WorkspaceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceInputError';
  }
}

function fail(message: string): never {
  throw new WorkspaceInputError(message);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') fail(`"${field}" must be a string`);
  if (value.length > max) fail(`"${field}" must be at most ${max} characters`);
  return value;
}

function requiredNonEmpty(value: unknown, field: string, max: number): string {
  const text = str(value, field, max).trim();
  if (text.length === 0) fail(`"${field}" is required`);
  return text;
}

function nullableStr(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return str(value, field, max);
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(`"${field}" must be a boolean`);
  return value;
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(`"${field}" must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function nullableInt(value: unknown, field: string, min: number, max: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(`"${field}" must be an integer`);
  if (value < min || value > max) fail(`"${field}" must be between ${min} and ${max}`);
  return value;
}

/** Accepts an ISO-8601 instant (or null) and normalizes it; rejects anything unparseable. */
function nullableIsoDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  const text = str(value, field, 64);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.valueOf())) fail(`"${field}" must be an ISO-8601 date-time`);
  return parsed.toISOString();
}

/**
 * Copies `key` from `source` onto `target` only when the caller actually supplied it.
 * `undefined` means "leave this column alone" for every patch verb in this file; a caller that
 * wants to clear a nullable column sends an explicit `null`.
 */
function patch<T, K extends keyof T & string>(
  source: Record<string, unknown>,
  target: Partial<T>,
  key: K,
  parse: (value: unknown) => T[K],
): void {
  if (!(key in source) || source[key] === undefined) return;
  target[key] = parse(source[key]) as Partial<T>[K];
}

export const MARKETS: readonly Market[] = ['netherlands', 'worldwide'];
export const SAVED_JOB_STATUSES: readonly SavedJobStatus[] = ['considering', 'preparing', 'applied'];
export const APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  'preparing',
  'applied',
  'recruiter_screen',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
];
export const APPLICATION_FILTERS: readonly ApplicationFilter[] = ['all', 'active', 'archived'];
export const CV_KINDS: readonly CvKind[] = ['uploaded', 'manual'];
export const LETTER_TYPES: readonly LetterType[] = [
  'motivation_letter',
  'cover_letter',
  'recruiter_message',
  'short_application_message',
];
export const LETTER_TONES: readonly LetterTone[] = ['formal', 'natural', 'confident', 'concise'];
export const LETTER_LENGTHS: readonly LetterLength[] = ['short', 'standard', 'detailed'];
export const LETTER_STATUSES: readonly LetterStatus[] = ['draft', 'final', 'sent'];
export const START_PAGES: readonly StartPage[] = ['search', 'saved', 'applications', 'last_opened'];
export const THEMES: readonly ThemePreference[] = ['light', 'dark', 'system'];
export const DENSITIES: readonly DensityPreference[] = ['comfortable', 'compact'];
export const SIDEBAR_STARTS: readonly SidebarStartPreference[] = ['expanded', 'collapsed', 'remember_last'];
export const DEFAULT_PROVIDERS: readonly DefaultAiProvider[] = ['claude', 'codex'];
/** Values `lastOpenedPage` may hold: the renderer's nav ids, not the `startPage` enum. */
export const NAV_PAGES = ['search', 'saved', 'applications', 'cv', 'letters', 'runtime', 'settings'] as const;

/** Every `…:update` / `…:delete` channel takes its row id through here first. */
export function parseId(value: unknown, field = 'id'): string {
  return requiredNonEmpty(value, field, LIMITS.short);
}

/** `{ id, patch }` envelope shared by all four update verbs. */
export function parseIdAndPatch(value: unknown): { id: string; patch: Record<string, unknown> } {
  const input = asRecord(value, 'update payload');
  return { id: parseId(input.id), patch: asRecord(input.patch, '"patch"') };
}

/** `{ id }` envelope shared by the delete / set-default / duplicate verbs. */
export function parseIdEnvelope(value: unknown): string {
  return parseId(asRecord(value, 'payload').id);
}

// ---------------------------------------------------------------------------- saved jobs

export function parseSavedJobInput(value: unknown): SavedJobInput {
  const input = asRecord(value, 'saved job');
  return {
    role: requiredNonEmpty(input.role, 'role', LIMITS.short),
    company: requiredNonEmpty(input.company, 'company', LIMITS.short),
    market: oneOf(input.market, 'market', MARKETS),
    location: input.location === undefined ? '' : str(input.location, 'location', LIMITS.short),
    vacancyKey: nullableStr(input.vacancyKey, 'vacancyKey', LIMITS.short),
    salary: nullableStr(input.salary, 'salary', LIMITS.short),
    arrangement: nullableStr(input.arrangement, 'arrangement', LIMITS.short),
    verification: nullableStr(input.verification, 'verification', LIMITS.short),
    matchPercent: nullableInt(input.matchPercent, 'matchPercent', 0, 100),
    sourceUrl: nullableStr(input.sourceUrl, 'sourceUrl', LIMITS.short),
    notes: input.notes === undefined ? '' : str(input.notes, 'notes', LIMITS.medium),
    status: input.status === undefined ? 'considering' : oneOf(input.status, 'status', SAVED_JOB_STATUSES),
  };
}

export function parseSavedJobPatch(value: unknown): SavedJobPatch {
  const input = asRecord(value, '"patch"');
  const out: SavedJobPatch = {};
  patch(input, out, 'role', (v) => requiredNonEmpty(v, 'role', LIMITS.short));
  patch(input, out, 'company', (v) => requiredNonEmpty(v, 'company', LIMITS.short));
  patch(input, out, 'market', (v) => oneOf(v, 'market', MARKETS));
  patch(input, out, 'location', (v) => str(v, 'location', LIMITS.short));
  patch(input, out, 'vacancyKey', (v) => nullableStr(v, 'vacancyKey', LIMITS.short));
  patch(input, out, 'salary', (v) => nullableStr(v, 'salary', LIMITS.short));
  patch(input, out, 'arrangement', (v) => nullableStr(v, 'arrangement', LIMITS.short));
  patch(input, out, 'verification', (v) => nullableStr(v, 'verification', LIMITS.short));
  patch(input, out, 'matchPercent', (v) => nullableInt(v, 'matchPercent', 0, 100));
  patch(input, out, 'sourceUrl', (v) => nullableStr(v, 'sourceUrl', LIMITS.short));
  patch(input, out, 'notes', (v) => str(v, 'notes', LIMITS.medium));
  patch(input, out, 'status', (v) => oneOf(v, 'status', SAVED_JOB_STATUSES));
  return out;
}

// -------------------------------------------------------------------------- applications

export function parseApplicationFilter(value: unknown): ApplicationFilter {
  if (value === undefined || value === null) return 'all';
  const input = asRecord(value, 'list payload');
  if (input.filter === undefined) return 'all';
  return oneOf(input.filter, 'filter', APPLICATION_FILTERS);
}

export function parseApplicationInput(value: unknown): ApplicationInput {
  const input = asRecord(value, 'application');
  return {
    role: requiredNonEmpty(input.role, 'role', LIMITS.short),
    company: requiredNonEmpty(input.company, 'company', LIMITS.short),
    market: oneOf(input.market, 'market', MARKETS),
    location: input.location === undefined ? '' : str(input.location, 'location', LIMITS.short),
    savedJobId: nullableStr(input.savedJobId, 'savedJobId', LIMITS.short),
    verification: nullableStr(input.verification, 'verification', LIMITS.short),
    status: input.status === undefined ? 'preparing' : oneOf(input.status, 'status', APPLICATION_STATUSES),
    appliedAt: nullableIsoDate(input.appliedAt, 'appliedAt'),
    nextStep: input.nextStep === undefined ? '' : str(input.nextStep, 'nextStep', LIMITS.medium),
    contact: input.contact === undefined ? '' : str(input.contact, 'contact', LIMITS.short),
    cvId: nullableStr(input.cvId, 'cvId', LIMITS.short),
    letterId: nullableStr(input.letterId, 'letterId', LIMITS.short),
    notes: input.notes === undefined ? '' : str(input.notes, 'notes', LIMITS.medium),
    archived: input.archived === undefined ? false : bool(input.archived, 'archived'),
  };
}

export function parseApplicationPatch(value: unknown): ApplicationPatch {
  const input = asRecord(value, '"patch"');
  const out: ApplicationPatch = {};
  patch(input, out, 'role', (v) => requiredNonEmpty(v, 'role', LIMITS.short));
  patch(input, out, 'company', (v) => requiredNonEmpty(v, 'company', LIMITS.short));
  patch(input, out, 'market', (v) => oneOf(v, 'market', MARKETS));
  patch(input, out, 'location', (v) => str(v, 'location', LIMITS.short));
  patch(input, out, 'savedJobId', (v) => nullableStr(v, 'savedJobId', LIMITS.short));
  patch(input, out, 'verification', (v) => nullableStr(v, 'verification', LIMITS.short));
  patch(input, out, 'status', (v) => oneOf(v, 'status', APPLICATION_STATUSES));
  patch(input, out, 'appliedAt', (v) => nullableIsoDate(v, 'appliedAt'));
  patch(input, out, 'nextStep', (v) => str(v, 'nextStep', LIMITS.medium));
  patch(input, out, 'contact', (v) => str(v, 'contact', LIMITS.short));
  patch(input, out, 'cvId', (v) => nullableStr(v, 'cvId', LIMITS.short));
  patch(input, out, 'letterId', (v) => nullableStr(v, 'letterId', LIMITS.short));
  patch(input, out, 'notes', (v) => str(v, 'notes', LIMITS.medium));
  patch(input, out, 'archived', (v) => bool(v, 'archived'));
  return out;
}

// -------------------------------------------------------------------------- cv documents

function parseProfile(value: unknown): Partial<CvProfile> {
  const input = asRecord(value, '"profile"');
  const out: Partial<CvProfile> = {};
  patch(input, out, 'title', (v) => str(v, 'profile.title', LIMITS.short));
  patch(input, out, 'years', (v) => str(v, 'profile.years', LIMITS.short));
  patch(input, out, 'location', (v) => str(v, 'profile.location', LIMITS.short));
  patch(input, out, 'languages', (v) => str(v, 'profile.languages', LIMITS.short));
  patch(input, out, 'summary', (v) => str(v, 'profile.summary', LIMITS.medium));
  patch(input, out, 'auth', (v) => str(v, 'profile.auth', LIMITS.short));
  patch(input, out, 'skills', (v) => {
    if (!Array.isArray(v)) fail('"profile.skills" must be an array of strings');
    if (v.length > LIMITS.skills) fail(`"profile.skills" must have at most ${LIMITS.skills} entries`);
    return v.map((entry, index) => str(entry, `profile.skills[${index}]`, LIMITS.short));
  });
  return out;
}

export function parseCvDocumentInput(value: unknown): CvDocumentInput {
  const input = asRecord(value, 'CV document');
  return {
    name: requiredNonEmpty(input.name, 'name', LIMITS.short),
    kind: oneOf(input.kind, 'kind', CV_KINDS),
    targetRole: input.targetRole === undefined ? '' : str(input.targetRole, 'targetRole', LIMITS.short),
    text: input.text === undefined ? '' : str(input.text, 'text', LIMITS.cvText),
    profile: input.profile === undefined ? {} : parseProfile(input.profile),
    isDefault: input.isDefault === undefined ? false : bool(input.isDefault, 'isDefault'),
  };
}

export function parseCvDocumentPatch(value: unknown): CvDocumentPatch {
  const input = asRecord(value, '"patch"');
  const out: CvDocumentPatch = {};
  patch(input, out, 'name', (v) => requiredNonEmpty(v, 'name', LIMITS.short));
  patch(input, out, 'targetRole', (v) => str(v, 'targetRole', LIMITS.short));
  patch(input, out, 'text', (v) => str(v, 'text', LIMITS.cvText));
  patch(input, out, 'profile', (v) => parseProfile(v));
  // `isDefault` is deliberately NOT patchable: promoting a CV has to go through
  // `workspace:cv-documents:set-default`, which demotes the previous default in the same
  // transaction. Allowing it here would let the library end up with two defaults, or none.
  return out;
}

// ------------------------------------------------------------------------------- letters

export function parseLetterInput(value: unknown): LetterInput {
  const input = asRecord(value, 'letter');
  return {
    title: requiredNonEmpty(input.title, 'title', LIMITS.short),
    company: input.company === undefined ? '' : str(input.company, 'company', LIMITS.short),
    role: input.role === undefined ? '' : str(input.role, 'role', LIMITS.short),
    type: input.type === undefined ? 'motivation_letter' : oneOf(input.type, 'type', LETTER_TYPES),
    tone: input.tone === undefined ? 'natural' : oneOf(input.tone, 'tone', LETTER_TONES),
    length: input.length === undefined ? 'standard' : oneOf(input.length, 'length', LETTER_LENGTHS),
    status: input.status === undefined ? 'draft' : oneOf(input.status, 'status', LETTER_STATUSES),
    vacancyKey: nullableStr(input.vacancyKey, 'vacancyKey', LIMITS.short),
    cvId: nullableStr(input.cvId, 'cvId', LIMITS.short),
    body: input.body === undefined ? '' : str(input.body, 'body', LIMITS.letterBody),
  };
}

export function parseLetterPatch(value: unknown): LetterPatch {
  const input = asRecord(value, '"patch"');
  const out: LetterPatch = {};
  patch(input, out, 'title', (v) => requiredNonEmpty(v, 'title', LIMITS.short));
  patch(input, out, 'company', (v) => str(v, 'company', LIMITS.short));
  patch(input, out, 'role', (v) => str(v, 'role', LIMITS.short));
  patch(input, out, 'type', (v) => oneOf(v, 'type', LETTER_TYPES));
  patch(input, out, 'tone', (v) => oneOf(v, 'tone', LETTER_TONES));
  patch(input, out, 'length', (v) => oneOf(v, 'length', LETTER_LENGTHS));
  patch(input, out, 'status', (v) => oneOf(v, 'status', LETTER_STATUSES));
  patch(input, out, 'vacancyKey', (v) => nullableStr(v, 'vacancyKey', LIMITS.short));
  patch(input, out, 'cvId', (v) => nullableStr(v, 'cvId', LIMITS.short));
  patch(input, out, 'body', (v) => str(v, 'body', LIMITS.letterBody));
  return out;
}

// ------------------------------------------------------------------------------ settings

export function parseSettingsPatch(value: unknown): AppSettingsPatch {
  const input = asRecord(value, '"patch"');
  const out: AppSettingsPatch = {};
  patch(input, out, 'launchAtLogin', (v) => bool(v, 'launchAtLogin'));
  patch(input, out, 'startPage', (v) => oneOf(v, 'startPage', START_PAGES));
  patch(input, out, 'theme', (v) => oneOf(v, 'theme', THEMES));
  patch(input, out, 'density', (v) => oneOf(v, 'density', DENSITIES));
  patch(input, out, 'sidebarStart', (v) => oneOf(v, 'sidebarStart', SIDEBAR_STARTS));
  patch(input, out, 'sidebarCollapsed', (v) => bool(v, 'sidebarCollapsed'));
  patch(input, out, 'lastOpenedPage', (v) => oneOf(v, 'lastOpenedPage', NAV_PAGES));
  patch(input, out, 'defaultMarket', (v) => oneOf(v, 'defaultMarket', MARKETS));
  patch(input, out, 'defaultLocation', (v) => str(v, 'defaultLocation', LIMITS.short));
  patch(input, out, 'sponsorOnlyDefault', (v) => bool(v, 'sponsorOnlyDefault'));
  patch(input, out, 'indVerificationEnabled', (v) => bool(v, 'indVerificationEnabled'));
  patch(input, out, 'defaultCvId', (v) => nullableStr(v, 'defaultCvId', LIMITS.short));
  patch(input, out, 'defaultLetterType', (v) => oneOf(v, 'defaultLetterType', LETTER_TYPES));
  patch(input, out, 'defaultLetterTone', (v) => oneOf(v, 'defaultLetterTone', LETTER_TONES));
  patch(input, out, 'defaultLetterLength', (v) => oneOf(v, 'defaultLetterLength', LETTER_LENGTHS));
  patch(input, out, 'defaultApplicationStatus', (v) =>
    oneOf(v, 'defaultApplicationStatus', APPLICATION_STATUSES),
  );
  patch(input, out, 'confirmApplicationDelete', (v) => bool(v, 'confirmApplicationDelete'));
  patch(input, out, 'autoArchiveRejected', (v) => bool(v, 'autoArchiveRejected'));
  patch(input, out, 'defaultProvider', (v) => oneOf(v, 'defaultProvider', DEFAULT_PROVIDERS));
  return out;
}
