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
 * Everything here is pure (no database, no Electron), which is why it is a separate module from
 * the handlers: it is exhaustively unit-testable on its own (see test/workspace-validate.test.ts).
 */

import { CV_PROFILE_LIMITS, CV_PROFILE_SHORT_FIELDS } from './cv-profile-schema.js';
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
  /** an extracted CV: a long PDF is realistically well under this */
  cvText: 2_000_000,
  /** a generated letter */
  letterBody: 200_000,
  /**
   * A kept gap analysis. Same order of magnitude as a letter and for the same reason: it is one
   * CLI answer, not a document the user assembles, so anything approaching this bound is a bug or
   * a hostile caller rather than a long analysis.
   */
  gapAnalysis: 200_000,
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
/**
 * Values `lastOpenedPage` may hold: the renderer's nav ids, not the `startPage` enum.
 *
 * `'agent-workspace'` is ADI-07's eighth destination. It is not added to `START_PAGES`: that enum
 * is what a user may pick as their *opening* screen in Settings, and a page whose whole purpose is
 * to show sessions that are running right now is a poor thing to land on cold.
 */
export const NAV_PAGES = [
  'search',
  'saved',
  'applications',
  'cv',
  'letters',
  'agent-workspace',
  'runtime',
  'settings',
] as const;

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
    location: input.location === undefined ? '' : str(input.location, 'location', LIMITS.short),
    vacancyKey: nullableStr(input.vacancyKey, 'vacancyKey', LIMITS.short),
    salary: nullableStr(input.salary, 'salary', LIMITS.short),
    arrangement: nullableStr(input.arrangement, 'arrangement', LIMITS.short),
    verification: nullableStr(input.verification, 'verification', LIMITS.short),
    matchPercent: nullableInt(input.matchPercent, 'matchPercent', 0, 100),
    sourceUrl: nullableStr(input.sourceUrl, 'sourceUrl', LIMITS.short),
    notes: input.notes === undefined ? '' : str(input.notes, 'notes', LIMITS.medium),
    status: input.status === undefined ? 'considering' : oneOf(input.status, 'status', SAVED_JOB_STATUSES),
    // Nullable, and null is the default: a newly saved job has no analysis. `gapAnalysisAt` is
    // deliberately absent from this allow-list, so a renderer cannot date a stored analysis.
    gapAnalysis: nullableStr(input.gapAnalysis, 'gapAnalysis', LIMITS.gapAnalysis),
  };
}

export function parseSavedJobPatch(value: unknown): SavedJobPatch {
  const input = asRecord(value, '"patch"');
  const out: SavedJobPatch = {};
  patch(input, out, 'role', (v) => requiredNonEmpty(v, 'role', LIMITS.short));
  patch(input, out, 'company', (v) => requiredNonEmpty(v, 'company', LIMITS.short));
  patch(input, out, 'location', (v) => str(v, 'location', LIMITS.short));
  patch(input, out, 'vacancyKey', (v) => nullableStr(v, 'vacancyKey', LIMITS.short));
  patch(input, out, 'salary', (v) => nullableStr(v, 'salary', LIMITS.short));
  patch(input, out, 'arrangement', (v) => nullableStr(v, 'arrangement', LIMITS.short));
  patch(input, out, 'verification', (v) => nullableStr(v, 'verification', LIMITS.short));
  patch(input, out, 'matchPercent', (v) => nullableInt(v, 'matchPercent', 0, 100));
  patch(input, out, 'sourceUrl', (v) => nullableStr(v, 'sourceUrl', LIMITS.short));
  patch(input, out, 'notes', (v) => str(v, 'notes', LIMITS.medium));
  patch(input, out, 'status', (v) => oneOf(v, 'status', SAVED_JOB_STATUSES));
  patch(input, out, 'gapAnalysis', (v) => nullableStr(v, 'gapAnalysis', LIMITS.gapAnalysis));
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
  for (const key of CV_PROFILE_SHORT_FIELDS) {
    patch(input, out, key, (v) => str(v, `profile.${key}`, CV_PROFILE_LIMITS.shortField));
  }
  patch(input, out, 'summary', (v) => str(v, 'profile.summary', CV_PROFILE_LIMITS.summary));
  patch(input, out, 'skills', (v) => {
    if (!Array.isArray(v)) fail('"profile.skills" must be an array of strings');
    if (v.length > CV_PROFILE_LIMITS.skills) {
      fail(`"profile.skills" must have at most ${CV_PROFILE_LIMITS.skills} entries`);
    }
    return v.map((entry, index) => str(entry, `profile.skills[${index}]`, CV_PROFILE_LIMITS.shortField));
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
  patch(input, out, 'minimizeToTrayOnClose', (v) => bool(v, 'minimizeToTrayOnClose'));
  patch(input, out, 'autoScanEnabled', (v) => bool(v, 'autoScanEnabled'));
  patch(input, out, 'defaultLocation', (v) => str(v, 'defaultLocation', LIMITS.short));
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
  // ADI-07's three AI Workspace preferences. See `AGENT_WORKSPACE_PREF_LIMITS` for why these live
  // in SQLite alongside every other setting rather than in localStorage.
  patch(input, out, 'agentSelectedSessionId', (v) => nullableStr(v, 'agentSelectedSessionId', LIMITS.short));
  patch(input, out, 'agentArchivedSessionIds', (v) => parseArchivedSessionIds(v));
  patch(input, out, 'agentUnreadCounts', (v) => parseUnreadCounts(v));
  return out;
}

// ------------------------------------------------------------ AI Workspace (ADI-07)

/**
 * Bounds for the three AI Workspace preference fields.
 *
 * These are renderer-local view state (which session is selected, which are archived, how many
 * unread entries each has) and they live in `app_settings` -- the same SQLite row as every other
 * preference in this app -- rather than in `localStorage`. That is a deliberate consistency
 * decision, not an accident: a user who exports, resets, or backs up their workspace database
 * expects it to carry their app state, and a second, invisible store in Chromium's profile
 * directory would silently not be part of any of that.
 *
 * The caps exist because these are the only settings whose *size* is driven by how much the user
 * does rather than by a fixed enum. A session list is bounded by the daemon's own eviction quota,
 * so 200 entries is far more than can accumulate; the cap is a bound on a hostile renderer, not a
 * product limit anyone will meet.
 */
export const AGENT_WORKSPACE_PREF_LIMITS = {
  archivedSessions: 200,
  unreadSessions: 200,
  /** A session id is a UUID (36 chars); `LIMITS.short` is already generous, this is the real shape. */
  sessionId: 128,
  /** No badge means anything above this, and an unbounded integer is a rendering hazard. */
  maxUnread: 9_999,
} as const;

/**
 * A bounded list of session ids.
 *
 * Stored as a JSON column, matching `cv_documents.profile`'s existing precedent for "a small
 * structured value in this database", rather than introducing a join table for a list that is
 * never queried, joined, or ordered by SQL.
 */
export function parseArchivedSessionIds(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) fail('"agentArchivedSessionIds" must be an array of session ids');
  if (value.length > AGENT_WORKSPACE_PREF_LIMITS.archivedSessions) {
    fail(`"agentArchivedSessionIds" must have at most ${AGENT_WORKSPACE_PREF_LIMITS.archivedSessions} entries`);
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    // Deduplicated here rather than trusted: archiving is idempotent in the reducer, and a stored
    // list with the same id twice would make it stop being idempotent across a reload.
    seen.add(str(entry, `agentArchivedSessionIds[${index}]`, AGENT_WORKSPACE_PREF_LIMITS.sessionId));
  }
  return [...seen];
}

/** A bounded `sessionId -> unread count` map. Same JSON-column reasoning as the list above. */
export function parseUnreadCounts(value: unknown): Record<string, number> {
  if (value === null || value === undefined) return {};
  const input = asRecord(value, '"agentUnreadCounts"');
  const keys = Object.keys(input);
  if (keys.length > AGENT_WORKSPACE_PREF_LIMITS.unreadSessions) {
    fail(`"agentUnreadCounts" must have at most ${AGENT_WORKSPACE_PREF_LIMITS.unreadSessions} entries`);
  }
  const out: Record<string, number> = {};
  for (const key of keys) {
    const id = str(key, 'agentUnreadCounts key', AGENT_WORKSPACE_PREF_LIMITS.sessionId);
    const count = input[key];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      fail(`"agentUnreadCounts.${id}" must be a non-negative integer`);
    }
    out[id] = Math.min(count, AGENT_WORKSPACE_PREF_LIMITS.maxUnread);
  }
  return out;
}

/*
 * ---------------------------------------------------------------------------------------------
 * `agent-workspace:*` IPC payloads (ADI-07).
 *
 * Same three rules as the rest of this file: allow-list, never spread; bound every string; and say
 * what is wrong without echoing what was sent. One rule is added, specific to these channels:
 * **nothing here accepts a location**. There is no `path`, `cwd`, `workspaceId`, or `incarnation`
 * parser below, so a renderer that attaches one has it dropped here, on top of the preload bridge
 * already refusing to put it on the wire.
 * ---------------------------------------------------------------------------------------------
 */

/** Canonical UUID form, the shape every v2 session id has (`agentSessionV2ViewSchema.id`). */
const SESSION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * `opaqueCursorV2Schema`'s charset and cap, restated.
 *
 * Restated rather than imported because this module is deliberately dependency-free (see its own
 * header: it is pure so it can be unit-tested without Electron or a database). The daemon validates
 * the cursor again on arrival, so this is the boundary check, not the authority.
 */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/** `pageLimitV2Schema`'s bounds, restated for the same reason. */
export const PAGE_LIMIT_BOUNDS = { min: 1, max: 100, default: 50 } as const;

export function parseSessionId(value: unknown, field = 'sessionId'): string {
  const id = str(value, field, 128);
  if (!SESSION_ID_PATTERN.test(id)) fail(`"${field}" must be a session id`);
  return id;
}

export interface AgentWorkspacePageRequest {
  cursor?: string;
  limit: number;
}

function parsePage(input: Record<string, unknown>): AgentWorkspacePageRequest {
  let limit: number = PAGE_LIMIT_BOUNDS.default;
  if (input.limit !== undefined && input.limit !== null) {
    if (typeof input.limit !== 'number' || !Number.isInteger(input.limit)) fail('"limit" must be an integer');
    if (input.limit < PAGE_LIMIT_BOUNDS.min || input.limit > PAGE_LIMIT_BOUNDS.max) {
      fail(`"limit" must be between ${PAGE_LIMIT_BOUNDS.min} and ${PAGE_LIMIT_BOUNDS.max}`);
    }
    limit = input.limit;
  }
  if (input.cursor === undefined || input.cursor === null) return { limit };
  const cursor = str(input.cursor, 'cursor', 256);
  if (!CURSOR_PATTERN.test(cursor)) fail('"cursor" must be an opaque pagination cursor');
  return { cursor, limit };
}

/** `agent-workspace:list`. Takes paging and nothing else: no provider filter, no path, no query. */
export function parseAgentWorkspaceListInput(value: unknown): AgentWorkspacePageRequest {
  if (value === undefined || value === null) return { limit: PAGE_LIMIT_BOUNDS.default };
  return parsePage(asRecord(value, 'list payload'));
}

/** `agent-workspace:get`. */
export function parseAgentWorkspaceGetInput(value: unknown): string {
  return parseSessionId(asRecord(value, 'payload').sessionId);
}

/** `agent-workspace:events`. */
export function parseAgentWorkspaceEventsInput(
  value: unknown,
): AgentWorkspacePageRequest & { sessionId: string } {
  const input = asRecord(value, 'events payload');
  return { sessionId: parseSessionId(input.sessionId), ...parsePage(input) };
}

/** `agent-workspace:attach`. `lastSeq` resumes the SSE stream; it is an index, never a cursor. */
export function parseAgentWorkspaceAttachInput(value: unknown): { sessionId: string; lastSeq?: number } {
  const input = asRecord(value, 'attach payload');
  const sessionId = parseSessionId(input.sessionId);
  if (input.lastSeq === undefined || input.lastSeq === null) return { sessionId };
  if (typeof input.lastSeq !== 'number' || !Number.isInteger(input.lastSeq) || input.lastSeq < 0) {
    fail('"lastSeq" must be a non-negative integer');
  }
  return { sessionId, lastSeq: input.lastSeq };
}

/** `agent-workspace:detach`. */
export function parseAgentWorkspaceDetachInput(value: unknown): string {
  return parseSessionId(asRecord(value, 'payload').sessionId);
}
