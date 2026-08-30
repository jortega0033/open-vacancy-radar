// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  parseApplicationFilter,
  parseApplicationInput,
  parseApplicationPatch,
  parseCvDocumentInput,
  parseCvDocumentPatch,
  parseId,
  parseIdAndPatch,
  parseIdEnvelope,
  parseLetterInput,
  parseLetterPatch,
  parseSavedJobInput,
  parseSavedJobPatch,
  parseSettingsPatch,
} from '../electron/workspace/validate.js';

const VALID_SAVED_JOB = { role: 'Frontend Engineer', company: 'Redwood Software', market: 'netherlands' };

describe('workspace input validation — allow-listing', () => {
  it('drops properties the caller was never granted, rather than passing them through to Drizzle', () => {
    const parsed = parseSavedJobInput({
      ...VALID_SAVED_JOB,
      id: 'attacker-chosen-primary-key',
      savedAt: 0,
      __proto__: { polluted: true },
      somethingElseEntirely: 'x',
    });

    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('savedAt');
    expect(parsed).not.toHaveProperty('somethingElseEntirely');
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'role',
        'company',
        'market',
        'location',
        'vacancyKey',
        'salary',
        'arrangement',
        'verification',
        'matchPercent',
        'sourceUrl',
        'notes',
        'status',
      ].sort(),
    );
  });

  it('refuses to let a patch set isDefault on a CV — promotion must go through set-default', () => {
    // Two rows claiming `isDefault` (or none claiming it) is a corrupt library. The only writer
    // of that column is `setDefaultCvDocument`, which demotes and promotes in one transaction.
    const parsed = parseCvDocumentPatch({ name: 'Renamed', isDefault: true });
    expect(parsed).toEqual({ name: 'Renamed' });
    expect(parsed).not.toHaveProperty('isDefault');
  });

  it('treats an absent key and an explicit null differently in a patch', () => {
    // Absent = leave the column alone. Explicit null = clear it. Collapsing the two would make it
    // impossible to detach a saved job from its source URL without also clearing every other
    // nullable field.
    expect(parseSavedJobPatch({})).toEqual({});
    expect(parseSavedJobPatch({ sourceUrl: null })).toEqual({ sourceUrl: null });
    expect(parseSavedJobPatch({ sourceUrl: undefined })).toEqual({});
  });
});

describe('workspace input validation — required fields and enums', () => {
  it('rejects a missing or blank required field', () => {
    expect(() => parseSavedJobInput({ ...VALID_SAVED_JOB, role: '' })).toThrow(/"role" is required/);
    expect(() => parseSavedJobInput({ ...VALID_SAVED_JOB, role: '   ' })).toThrow(/"role" is required/);
    expect(() => parseSavedJobInput({ company: 'X', market: 'worldwide' })).toThrow(/"role" must be a string/);
  });

  it('trims required text so a whitespace-padded value cannot masquerade as content', () => {
    expect(parseSavedJobInput({ ...VALID_SAVED_JOB, role: '  Frontend Engineer  ' }).role).toBe('Frontend Engineer');
  });

  it('accepts only the two markets the app can actually search', () => {
    expect(parseSavedJobInput({ ...VALID_SAVED_JOB, market: 'worldwide' }).market).toBe('worldwide');
    for (const invented of ['germany', 'uk', 'us', 'belgium', 'other', 'Netherlands']) {
      expect(() => parseSavedJobInput({ ...VALID_SAVED_JOB, market: invented })).toThrow(/"market" must be one of/);
    }
  });

  it('rejects an unknown status instead of writing it to a CHECK-constrained column', () => {
    expect(() => parseApplicationInput({ ...VALID_SAVED_JOB, status: 'ghosted' })).toThrow(/"status" must be one of/);
    expect(() => parseLetterInput({ title: 'x', tone: 'sarcastic' })).toThrow(/"tone" must be one of/);
  });

  it('rejects a non-object payload before it can be indexed into', () => {
    for (const bad of [null, undefined, 'a string', 42, ['an', 'array']]) {
      expect(() => parseSavedJobInput(bad)).toThrow(/must be an object/);
    }
  });
});

describe('workspace input validation — bounds', () => {
  it('bounds every free-text field, so one create call cannot write the disk full', () => {
    expect(() => parseSavedJobInput({ ...VALID_SAVED_JOB, role: 'a'.repeat(LIMITS.short + 1) })).toThrow(
      /at most 512 characters/,
    );
    expect(() => parseSavedJobInput({ ...VALID_SAVED_JOB, notes: 'a'.repeat(LIMITS.medium + 1) })).toThrow(
      /at most 20000 characters/,
    );
    expect(() => parseCvDocumentInput({ name: 'CV', kind: 'uploaded', text: 'a'.repeat(LIMITS.cvText + 1) })).toThrow(
      /at most 2000000 characters/,
    );
    expect(() => parseLetterInput({ title: 'L', body: 'a'.repeat(LIMITS.letterBody + 1) })).toThrow(
      /at most 200000 characters/,
    );
  });

  it('bounds the skills array both in length and per entry', () => {
    expect(() =>
      parseCvDocumentInput({ name: 'CV', kind: 'manual', profile: { skills: new Array(LIMITS.skills + 1).fill('x') } }),
    ).toThrow(/at most 200 entries/);
    expect(() => parseCvDocumentInput({ name: 'CV', kind: 'manual', profile: { skills: [{ not: 'a string' }] } })).toThrow(
      /profile\.skills\[0\]" must be a string/,
    );
  });

  it('constrains matchPercent to a real percentage', () => {
    expect(parseSavedJobInput({ ...VALID_SAVED_JOB, matchPercent: 0 }).matchPercent).toBe(0);
    expect(parseSavedJobInput({ ...VALID_SAVED_JOB, matchPercent: 100 }).matchPercent).toBe(100);
    expect(() => parseSavedJobInput({ ...VALID_SAVED_JOB, matchPercent: 101 })).toThrow(/between 0 and 100/);
    expect(() => parseSavedJobInput({ ...VALID_SAVED_JOB, matchPercent: 12.5 })).toThrow(/must be an integer/);
  });

  it('never echoes the rejected value back in the error message', () => {
    // These messages are surfaced through IPC and may reach a log; the value could be CV text or
    // personal notes, so it must never be the thing that identifies the problem.
    const secret = 'my-private-cover-letter-draft';
    try {
      parseSavedJobInput({ ...VALID_SAVED_JOB, notes: secret.repeat(2000) });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('workspace input validation — dates and envelopes', () => {
  it('normalizes appliedAt to an ISO instant and rejects an unparseable one', () => {
    expect(parseApplicationInput({ ...VALID_SAVED_JOB, appliedAt: '2026-08-29' }).appliedAt).toBe(
      new Date('2026-08-29').toISOString(),
    );
    expect(parseApplicationInput({ ...VALID_SAVED_JOB, appliedAt: null }).appliedAt).toBeNull();
    expect(() => parseApplicationInput({ ...VALID_SAVED_JOB, appliedAt: 'whenever' })).toThrow(/ISO-8601/);
  });

  it('distinguishes "clear the applied date" from "leave it alone" in a patch', () => {
    expect(parseApplicationPatch({ appliedAt: null })).toEqual({ appliedAt: null });
    expect(parseApplicationPatch({ status: 'interview' })).toEqual({ status: 'interview' });
    expect(parseApplicationPatch({ status: 'interview' })).not.toHaveProperty('appliedAt');
  });

  it('defaults the applications filter to "all" and rejects an unknown one', () => {
    expect(parseApplicationFilter(undefined)).toBe('all');
    expect(parseApplicationFilter({})).toBe('all');
    expect(parseApplicationFilter({ filter: 'archived' })).toBe('archived');
    expect(() => parseApplicationFilter({ filter: 'deleted' })).toThrow(/"filter" must be one of/);
  });

  it('requires a non-empty id on every id-bearing envelope', () => {
    expect(parseIdEnvelope({ id: 'abc' })).toBe('abc');
    expect(() => parseIdEnvelope({ id: '' })).toThrow(/"id" is required/);
    expect(() => parseIdEnvelope({})).toThrow(/"id" must be a string/);
    expect(() => parseId(123)).toThrow(/"id" must be a string/);
  });

  it('requires the update envelope to carry both an id and an object patch', () => {
    expect(parseIdAndPatch({ id: 'a', patch: { notes: 'x' } })).toEqual({ id: 'a', patch: { notes: 'x' } });
    expect(() => parseIdAndPatch({ id: 'a' })).toThrow(/"patch" must be an object/);
    expect(() => parseIdAndPatch({ id: 'a', patch: 'notes=x' })).toThrow(/"patch" must be an object/);
  });
});

describe('workspace settings patch', () => {
  it('accepts a partial patch and leaves everything else alone', () => {
    expect(parseSettingsPatch({ theme: 'dark' })).toEqual({ theme: 'dark' });
    expect(parseSettingsPatch({ sidebarCollapsed: true, density: 'compact' })).toEqual({
      sidebarCollapsed: true,
      density: 'compact',
    });
  });

  it('accepts only real nav pages for lastOpenedPage', () => {
    expect(parseSettingsPatch({ lastOpenedPage: 'letters' })).toEqual({ lastOpenedPage: 'letters' });
    // 'last_opened' is a startPage instruction, not a destination — storing it here would make
    // "restore the last page" resolve to itself.
    expect(() => parseSettingsPatch({ lastOpenedPage: 'last_opened' })).toThrow(/must be one of/);
    expect(() => parseSettingsPatch({ lastOpenedPage: 'admin' })).toThrow(/must be one of/);
  });

  it('rejects a non-boolean where the schema stores a boolean', () => {
    expect(() => parseSettingsPatch({ launchAtLogin: 'yes' })).toThrow(/"launchAtLogin" must be a boolean/);
    expect(() => parseSettingsPatch({ sidebarCollapsed: 1 })).toThrow(/"sidebarCollapsed" must be a boolean/);
  });

  it('ignores keys that are not settings at all', () => {
    expect(parseSettingsPatch({ id: 2, theme: 'light', databasePath: '/etc/passwd' })).toEqual({ theme: 'light' });
  });
});

describe('workspace letter/CV patches', () => {
  it('keeps a letter patch to the fields the editor owns', () => {
    expect(parseLetterPatch({ body: 'Dear hiring manager', status: 'final', updatedAt: 0, id: 'x' })).toEqual({
      body: 'Dear hiring manager',
      status: 'final',
    });
  });

  it('accepts a partial CV profile patch without demanding every profile field', () => {
    expect(parseCvDocumentPatch({ profile: { title: 'Senior Frontend Engineer' } })).toEqual({
      profile: { title: 'Senior Frontend Engineer' },
    });
  });

  it('requires an explicit CV kind — there is no sensible default between uploaded and manual', () => {
    expect(() => parseCvDocumentInput({ name: 'CV' })).toThrow(/"kind" must be one of/);
    expect(parseCvDocumentInput({ name: 'CV', kind: 'uploaded' }).kind).toBe('uploaded');
  });
});
