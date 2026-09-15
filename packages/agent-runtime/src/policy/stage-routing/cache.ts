/**
 * Stage-result caching (issue #284): only validated results are stored, and every key carries the
 * version of every input the result was derived from.
 *
 * Two failure modes this is built to make unreachable rather than unlikely:
 *
 * 1. **Caching an answer that never passed its own check.** `put` accepts a `ValidatedStageResult`,
 *    a type whose only constructor is `validatedStageResult`. A rejected result is a different type
 *    and does not compile at the call site, so "we cached it and validated later" is not an
 *    available mistake -- not a discouraged one.
 * 2. **Serving a stale answer after an input moved.** The key is the full version tuple: the source
 *    CV, the candidate profile, the job description, the workflow, and the prompt text itself, plus
 *    the pairing that produced it. Any one of them changing is a miss. There is no partial key and
 *    no "close enough" lookup, so a cache entry cannot outlive the inputs it describes.
 *
 * The prompt version is in the key for a reason that is easy to miss: this app's prompts encode
 * hard rules (`GROUNDING_RULES`, the no-invention clauses added by #274). Tightening one of those
 * and then serving a cached answer produced under the looser wording would silently undo the fix.
 */
import type { GenerationStage } from './stages.js';

export interface StageCacheKeyParts {
  readonly stage: GenerationStage;
  readonly providerId: string;
  /** Absent means the provider's own default model, and is a distinct key from any named model. */
  readonly model?: string;
  /** Version/digest of the reviewed structured source CV this answer was derived from (#274). */
  readonly sourceVersion: string;
  /** Version/digest of the candidate profile (skills, pins, project cap). */
  readonly profileVersion: string;
  /** Version/digest of the job description text. For a stage with no vacancy, a stable literal. */
  readonly jobDescriptionVersion: string;
  /** Version of the workflow/contract that consumes this result, so a downstream shape change misses. */
  readonly workflowVersion: string;
  /** Version/digest of the prompt template that produced it. */
  readonly promptVersion: string;
}

/**
 * A result that has passed its stage's own validation. The `readonly` brand field is not decoration:
 * it is what stops a caller from assembling this shape inline from an unvalidated value, since the
 * only way to get one that type-checks is `validatedStageResult`, whose argument list names the
 * check that passed.
 */
export interface ValidatedStageResult<T> {
  readonly validated: true;
  readonly value: T;
  /** The check that passed, named. Carried so a cache dump can say why an entry was trusted. */
  readonly validatedBy: string;
}

export function validatedStageResult<T>(value: T, validatedBy: string): ValidatedStageResult<T> {
  if (validatedBy.trim().length === 0) {
    throw new TypeError('a validated stage result must name the check that validated it');
  }
  return { validated: true, value, validatedBy };
}

/**
 * The key string. `JSON.stringify` over a fixed-order array rather than a delimiter join, because a
 * join is ambiguous the moment any component can contain the delimiter: `a|b` + `c` and `a` +
 * `b|c` are the same string, and two different input sets colliding on one key is exactly the stale
 * read this whole module exists to prevent. JSON quoting makes every component self-delimiting.
 *
 * The order is fixed here, in one place, so two call sites cannot produce different keys for the
 * same inputs.
 */
export function stageCacheKey(parts: StageCacheKeyParts): string {
  return JSON.stringify([
    parts.stage,
    parts.providerId,
    parts.model ?? null,
    parts.sourceVersion,
    parts.profileVersion,
    parts.jobDescriptionVersion,
    parts.workflowVersion,
    parts.promptVersion,
  ]);
}

export const DEFAULT_STAGE_CACHE_CAPACITY = 200;

/**
 * A bounded in-memory cache of validated stage results.
 *
 * Insertion-ordered eviction (the oldest entry goes when the cap is reached) rather than
 * least-recently-used: LRU would keep a frequently re-read entry alive indefinitely, and an entry
 * that never ages out is one whose inputs have more chances to drift underneath it. The version key
 * already makes a stale *read* impossible; bounded age keeps a stale *entry* from lingering.
 */
export class ValidatedStageResultCache<T> {
  private readonly entries = new Map<string, ValidatedStageResult<T>>();

  constructor(private readonly capacity: number = DEFAULT_STAGE_CACHE_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('ValidatedStageResultCache capacity must be a positive integer');
    }
  }

  get(parts: StageCacheKeyParts): ValidatedStageResult<T> | undefined {
    return this.entries.get(stageCacheKey(parts));
  }

  put(parts: StageCacheKeyParts, result: ValidatedStageResult<T>): void {
    const key = stageCacheKey(parts);
    // Deleted first so a re-put moves the entry to the end of the insertion order; without this a
    // refreshed entry would keep its original eviction position and age out while still current.
    this.entries.delete(key);
    this.entries.set(key, result);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
