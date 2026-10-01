// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CANDIDATE_PROFILE_LIMITS, parseCandidateProfilePatch } from '../electron/vacancy-profile-validate.js';

describe('vacancy profile input validation', () => {
  it('drops properties the caller was never granted, rather than passing them through to disk', () => {
    const parsed = parseCandidateProfilePatch({
      candidateName: 'Jane Doe',
      profileVersion: 'attacker-chosen-version',
      __proto__: { polluted: true },
      somethingElseEntirely: 'x',
    });

    expect(parsed).toEqual({ candidateName: 'Jane Doe' });
    expect(parsed).not.toHaveProperty('profileVersion');
  });

  it('accepts an empty patch', () => {
    expect(parseCandidateProfilePatch({})).toEqual({});
  });

  it('rejects a patch that is not an object', () => {
    expect(() => parseCandidateProfilePatch('not-an-object')).toThrow('must be an object');
    expect(() => parseCandidateProfilePatch(null)).toThrow('must be an object');
    expect(() => parseCandidateProfilePatch(['a'])).toThrow('must be an object');
  });

  it('bounds every string field', () => {
    const tooLong = 'x'.repeat(CANDIDATE_PROFILE_LIMITS.shortField + 1);
    expect(() => parseCandidateProfilePatch({ candidateName: tooLong })).toThrow('at most');
    expect(() => parseCandidateProfilePatch({ currentRole: tooLong })).toThrow('at most');
    expect(() => parseCandidateProfilePatch({ location: tooLong })).toThrow('at most');
  });

  it('parses string-array fields and bounds their length and entry size', () => {
    expect(parseCandidateProfilePatch({ targetRoles: ['Frontend', 'Backend'] })).toEqual({
      targetRoles: ['Frontend', 'Backend'],
    });
    expect(() => parseCandidateProfilePatch({ targetRoles: 'not-an-array' })).toThrow('must be an array');
    expect(() => parseCandidateProfilePatch({ targetRoles: [1, 2] })).toThrow('must be a string');

    const tooMany = Array.from({ length: CANDIDATE_PROFILE_LIMITS.listEntries + 1 }, (_v, i) => `role-${i}`);
    expect(() => parseCandidateProfilePatch({ targetRoles: tooMany })).toThrow('at most');
  });

  it('accepts all five list fields independently', () => {
    const parsed = parseCandidateProfilePatch({
      strongestSkills: ['TypeScript'],
      additionalSkills: ['Rust'],
      targetRoles: ['Frontend Engineer'],
      consideredRoles: ['Fullstack Engineer'],
      excludedRoleFamilies: ['Sales'],
    });
    expect(parsed).toEqual({
      strongestSkills: ['TypeScript'],
      additionalSkills: ['Rust'],
      targetRoles: ['Frontend Engineer'],
      consideredRoles: ['Fullstack Engineer'],
      excludedRoleFamilies: ['Sales'],
    });
  });

  it('validates experienceYears as a bounded non-negative integer', () => {
    expect(parseCandidateProfilePatch({ experienceYears: 5 })).toEqual({ experienceYears: 5 });
    expect(() => parseCandidateProfilePatch({ experienceYears: -1 })).toThrow('between 0 and');
    expect(() => parseCandidateProfilePatch({ experienceYears: 1.5 })).toThrow('must be an integer');
    expect(() => parseCandidateProfilePatch({ experienceYears: 'five' })).toThrow('must be an integer');
    expect(() => parseCandidateProfilePatch({ experienceYears: CANDIDATE_PROFILE_LIMITS.experienceYearsMax + 1 })).toThrow(
      'between 0 and',
    );
  });

  it('validates the nested constraints object field by field, allow-listed', () => {
    const parsed = parseCandidateProfilePatch({
      constraints: {
        professionalLanguage: 'Dutch',
        dutchRequired: true,
        primaryCountry: '',
        allowRemoteEuSupportingNetherlands: false,
        minimumMonthlyBaseEur: 4000,
        attackerField: 'x',
      },
    });
    expect(parsed).toEqual({
      constraints: {
        professionalLanguage: 'Dutch',
        dutchRequired: true,
        primaryCountry: '',
        allowRemoteEuSupportingNetherlands: false,
        minimumMonthlyBaseEur: 4000,
      },
    });
  });

  it('allows a partial constraints patch, leaving unsupplied fields absent', () => {
    expect(parseCandidateProfilePatch({ constraints: { dutchRequired: true } })).toEqual({
      constraints: { dutchRequired: true },
    });
  });

  it('rejects a negative or out-of-range minimumMonthlyBaseEur', () => {
    expect(() => parseCandidateProfilePatch({ constraints: { minimumMonthlyBaseEur: -1 } })).toThrow(
      'between 0 and',
    );
    expect(() =>
      parseCandidateProfilePatch({
        constraints: { minimumMonthlyBaseEur: CANDIDATE_PROFILE_LIMITS.minimumMonthlyBaseEurMax + 1 },
      }),
    ).toThrow('between 0 and');
  });

  it('rejects a non-boolean toggle', () => {
    expect(() => parseCandidateProfilePatch({ constraints: { dutchRequired: 'yes' } })).toThrow('must be a boolean');
  });
});
