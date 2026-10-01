import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_CANDIDATE_PROFILE,
  isCandidateProfileConfigured,
  loadCandidateProfile,
} from '../../src/candidate/profile.js';

/**
 * Regression for open-vacancy-radar#384: a missing profile file used to throw a raw Node `ENOENT`
 * (full local path and all) straight out of `loadCandidateProfile`, which reached the renderer
 * unsanitized through the one IPC handler that had no try/catch around this call
 * (`vacancy:get-search-profile`). Every other caller already treated a load failure as "nothing
 * configured yet" -- this pins that as the function's own direct behavior for the one error that
 * genuinely means that, rather than leaving it to each caller's own catch block.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-candidate-profile-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadCandidateProfile', () => {
  it('returns the empty profile, not a thrown ENOENT, when no file has ever been saved', async () => {
    const missingPath = join(dir, 'config', 'candidate-profile-v1.json');
    await expect(loadCandidateProfile(missingPath)).resolves.toEqual(EMPTY_CANDIDATE_PROFILE);
  });

  it('the empty profile reads as unconfigured, the same state a present-but-empty file already produces', () => {
    expect(isCandidateProfileConfigured(EMPTY_CANDIDATE_PROFILE)).toBe(false);
  });

  it('still throws on a genuinely broken file, not just a missing one', async () => {
    const badPath = join(dir, 'candidate-profile-v1.json');
    writeFileSync(badPath, '{ not valid json', 'utf8');
    await expect(loadCandidateProfile(badPath)).rejects.toThrow();
  });

  it('still throws when the file exists but fails the schema', async () => {
    const badPath = join(dir, 'candidate-profile-v1.json');
    writeFileSync(badPath, JSON.stringify({ profileVersion: 'v1' }), 'utf8');
    await expect(loadCandidateProfile(badPath)).rejects.toThrow();
  });

  it('loads a real, present profile normally, untouched by the ENOENT handling', async () => {
    const realPath = join(dir, 'candidate-profile-v1.json');
    const real = {
      ...EMPTY_CANDIDATE_PROFILE,
      profileVersion: 'v1',
      candidateName: 'Ada Lovelace',
      targetRoles: ['Frontend Engineer'],
    };
    writeFileSync(realPath, JSON.stringify(real), 'utf8');
    await expect(loadCandidateProfile(realPath)).resolves.toEqual(real);
  });
});
