import { describe, expect, it } from 'vitest';
import {
  ValidatedStageResultCache,
  stageCacheKey,
  validatedStageResult,
  type StageCacheKeyParts,
} from '../src/index.js';

const KEY: StageCacheKeyParts = {
  stage: 'cv_tailoring',
  providerId: 'claude',
  model: 'sonnet',
  sourceVersion: 'source-v7',
  profileVersion: 'profile-v3',
  jobDescriptionVersion: 'jd-abc123',
  workflowVersion: 'workflow-v2',
  promptVersion: 'prompt-v11',
};

const VERSION_FIELDS = [
  'sourceVersion',
  'profileVersion',
  'jobDescriptionVersion',
  'workflowVersion',
  'promptVersion',
] as const;

/**
 * Issue #284's caching rule: cache only validated results, keyed against source/profile/JD/workflow
 * versions, so a stale entry can never silently serve outdated content.
 */
describe('ValidatedStageResultCache: only validated results, and only for the exact inputs', () => {
  it('stores and returns a validated result together with the check that validated it', () => {
    const cache = new ValidatedStageResultCache<string>();
    cache.put(KEY, validatedStageResult('a tailored CV', 'reconcileTailoredResumeWithSource'));
    expect(cache.get(KEY)).toEqual({
      validated: true,
      value: 'a tailored CV',
      validatedBy: 'reconcileTailoredResumeWithSource',
    });
  });

  it('refuses to mint a validated result that cannot name the check that passed', () => {
    expect(() => validatedStageResult('x', '   ')).toThrow(TypeError);
  });

  it('misses when any one input version moves', () => {
    for (const field of VERSION_FIELDS) {
      const cache = new ValidatedStageResultCache<string>();
      cache.put(KEY, validatedStageResult('old answer', 'schema'));
      expect(cache.get({ ...KEY, [field]: 'moved' })).toBeUndefined();
    }
  });

  it('misses when the pairing that produced it changes', () => {
    const cache = new ValidatedStageResultCache<string>();
    cache.put(KEY, validatedStageResult('old answer', 'schema'));
    expect(cache.get({ ...KEY, providerId: 'codex' })).toBeUndefined();
    expect(cache.get({ ...KEY, model: 'opus' })).toBeUndefined();
    // A provider-default run is its own key, not a wildcard match against a named model.
    const { model: _named, ...defaultModel } = KEY;
    expect(cache.get(defaultModel)).toBeUndefined();
  });

  it('misses across stages even when every other component is identical', () => {
    const cache = new ValidatedStageResultCache<string>();
    cache.put(KEY, validatedStageResult('old answer', 'schema'));
    expect(cache.get({ ...KEY, stage: 'cover_letter' })).toBeUndefined();
  });

  it('cannot be collided by a component that contains the key delimiter', () => {
    // A delimiter-joined key would make these two input sets the same string. JSON quoting makes
    // every component self-delimiting, which is what keeps a collision from becoming a stale read.
    const a = stageCacheKey({ ...KEY, sourceVersion: 'a"b', profileVersion: 'c' });
    const b = stageCacheKey({ ...KEY, sourceVersion: 'a', profileVersion: 'b"c' });
    expect(a).not.toBe(b);
  });

  it('produces the same key for the same inputs, whatever order the object was built in', () => {
    const rebuilt: StageCacheKeyParts = {
      promptVersion: KEY.promptVersion,
      workflowVersion: KEY.workflowVersion,
      jobDescriptionVersion: KEY.jobDescriptionVersion,
      profileVersion: KEY.profileVersion,
      sourceVersion: KEY.sourceVersion,
      model: KEY.model,
      providerId: KEY.providerId,
      stage: KEY.stage,
    };
    expect(stageCacheKey(rebuilt)).toBe(stageCacheKey(KEY));
  });

  it('is bounded and evicts oldest-first, so an entry cannot linger indefinitely', () => {
    const cache = new ValidatedStageResultCache<number>(2);
    cache.put({ ...KEY, jobDescriptionVersion: 'jd-1' }, validatedStageResult(1, 'schema'));
    cache.put({ ...KEY, jobDescriptionVersion: 'jd-2' }, validatedStageResult(2, 'schema'));
    cache.put({ ...KEY, jobDescriptionVersion: 'jd-3' }, validatedStageResult(3, 'schema'));
    expect(cache.size).toBe(2);
    expect(cache.get({ ...KEY, jobDescriptionVersion: 'jd-1' })).toBeUndefined();
    expect(cache.get({ ...KEY, jobDescriptionVersion: 'jd-3' })?.value).toBe(3);
  });

  it('moves a refreshed entry to the back of the eviction order rather than keeping its old slot', () => {
    const cache = new ValidatedStageResultCache<number>(2);
    cache.put({ ...KEY, jobDescriptionVersion: 'jd-1' }, validatedStageResult(1, 'schema'));
    cache.put({ ...KEY, jobDescriptionVersion: 'jd-2' }, validatedStageResult(2, 'schema'));
    cache.put({ ...KEY, jobDescriptionVersion: 'jd-1' }, validatedStageResult(11, 'schema'));
    cache.put({ ...KEY, jobDescriptionVersion: 'jd-3' }, validatedStageResult(3, 'schema'));
    expect(cache.get({ ...KEY, jobDescriptionVersion: 'jd-1' })?.value).toBe(11);
    expect(cache.get({ ...KEY, jobDescriptionVersion: 'jd-2' })).toBeUndefined();
  });

  it('refuses a nonsensical capacity', () => {
    expect(() => new ValidatedStageResultCache(0)).toThrow(RangeError);
  });
});
