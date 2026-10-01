/**
 * The closed set of generation stages this product routes a model for, and what each one actually
 * requires of the provider that runs it (issue #284).
 *
 * A "stage" here is one bounded unit of AI work with its own success test, not a feature name and
 * not a UI screen. That distinction is what makes routing decidable: `cv_field_extraction` either
 * produced a parseable object of known fields or it did not, and `application_field_map` either
 * produced assignments over two closed sets or it did not. A stage whose output cannot be checked
 * without a human reading it does not get a cheaper model on a hunch -- it gets the same honest
 * `unknown` labels as everything else here, and the benchmark decides later.
 *
 * ## Why the requirements are capability keys and not provider ids
 *
 * `requiredCapabilities` names keys on `ProviderCapabilities` (packages/shared/src/provider.ts).
 * That indirection is the architecture rule from DEVELOPMENT.md, not decoration: the router lives
 * outside `packages/agent-runtime` and therefore may not know that Claude is the only adapter that
 * honors the `'no-network'` hardening profile. It knows only that this stage requires an adapter
 * declaring `hardenedNoNetwork`, and `packages/agent-runtime/src/providers/<id>/capabilities.ts` is
 * where that declaration is made next to the code implementing it.
 *
 * ## What this file deliberately does not encode
 *
 * No price table, no per-model quality ranking, and no "small model" allowlist. Model identity
 * changes under this repo's feet (a live catalog is fetched per provider -- ADI-22a), and any
 * ranking committed here would be an unmeasured claim of exactly the kind acceptance check 5 of
 * #284 forbids. Tier is an operator-declared label carried on a candidate, and the only ranking
 * this package will ever emit comes out of `benchmark.ts` with its sample size attached.
 */
import type { ProviderCapabilities } from '@agent-dock/shared';

export type GenerationStage =
  | 'cv_field_extraction'
  | 'source_cv_capture'
  | 'gap_analysis'
  | 'cv_tailoring'
  | 'cover_letter'
  | 'application_field_map';

export const GENERATION_STAGES: readonly GenerationStage[] = Object.freeze([
  'cv_field_extraction',
  'source_cv_capture',
  'gap_analysis',
  'cv_tailoring',
  'cover_letter',
  'application_field_map',
]);

/**
 * What kind of work a stage is, which is the only thing tier preference is allowed to key off.
 *
 * - `bounded_extraction` -- read a supplied document, emit a fixed set of fields. The answer is
 *   machine-checkable against a schema, nothing is invented by design, and a wrong answer costs a
 *   glance at a prefilled form rather than a bad document. This is the workload a small model is
 *   preferred for.
 * - `grounded_document` -- produce prose the candidate will send, every fact of which must already
 *   exist in their own CV. Preferred to a capable model, because the failure mode is a fluent
 *   invention that reads correct.
 * - `closed_set_assignment` -- assign members of one closed set to members of another (the
 *   application executor's field map, #196 §2.3). It authors no strings at all, but its prompt
 *   always embeds attacker-influenced text, so its requirement is a hardening contract rather than
 *   a tier.
 */
export type StageWorkload = 'bounded_extraction' | 'grounded_document' | 'closed_set_assignment';

/**
 * An operator-declared size/capability label for one catalog entry. `unknown` is the default and
 * the honest answer for most live catalog entries: a provider's `model/list` RPC reports an id, a
 * display name and whether it is the default (`ProviderModelV2`), and nothing about size.
 *
 * `unknown` always sorts last, never first. Preferring an unlabelled model over a labelled one --
 * in either direction -- would be choosing on the absence of evidence, which is the same mistake as
 * claiming a ranking without measuring one.
 */
export type ModelTier = 'small' | 'capable' | 'unknown';

/** How a candidate's `tier` came to be what it is. Carried into every routing record so a reader
 * never has to guess whether a label was measured or typed into a settings file by hand. */
export type TierEvidence = 'operator_declared' | 'measured_benchmark';

export interface StageContract {
  readonly stage: GenerationStage;
  readonly workload: StageWorkload;
  /**
   * Keys on `ProviderCapabilities` a candidate must declare `true` to be eligible for this stage.
   * Empty is a real and common answer: a stage with no adapter-level requirement is gated by its
   * own schema check and by the benchmark, not by an invented capability.
   */
  readonly requiredCapabilities: readonly (keyof ProviderCapabilities & string)[];
  /**
   * Hard ceiling on model attempts for one unit of work, enforced by `escalation.ts`. Two, for
   * every stage: one retry is enough to absorb a malformed answer or a dropped transport, and a
   * third attempt on the same input is where "bounded retry" quietly turns into paid guessing.
   */
  readonly maxAttempts: number;
  /**
   * Whether an unresolved fact in this stage has somewhere deterministic to be looked up -- the
   * reviewed structured source CV (#274) for the CV stages, the attempt's own value table and form
   * snapshot for the field map. When false, a missing fact goes straight to a user handoff.
   */
  readonly retrievalAvailable: boolean;
}

/**
 * `application_field_map` is the one stage in this table with a real adapter-level requirement, and
 * it is not a stylistic one. `StartSessionOptions.hardened` is documented as a *request*: an
 * adapter with nothing to restrict is free to ignore it, and `buildCodexArgs` does, permanently. So
 * a provider that does not declare `hardenedNoNetwork` would run this stage -- whose prompt always
 * embeds a scraped job description -- with `WebFetch`/`WebSearch` still in its tool allowlist.
 * Being cheaper does not buy past that, which is what `router.ts` enforces and what
 * `stage-routing.router.test.ts` pins.
 *
 * Note what this requirement is *not*: it is not what stops a non-hardening provider from running a
 * field-map session. `POST /sessions/application-field-map` (apps/daemon) keeps its own literal
 * provider check for that, deliberately, so the guarantee survives an adapter that declares this
 * capability wrongly. This table governs selection; that route governs admission.
 */
export const STAGE_CONTRACTS: Readonly<Record<GenerationStage, StageContract>> = Object.freeze({
  cv_field_extraction: Object.freeze({
    stage: 'cv_field_extraction',
    workload: 'bounded_extraction',
    requiredCapabilities: Object.freeze([]),
    maxAttempts: 2,
    retrievalAvailable: true,
  }),
  source_cv_capture: Object.freeze({
    stage: 'source_cv_capture',
    workload: 'bounded_extraction',
    requiredCapabilities: Object.freeze([]),
    maxAttempts: 2,
    retrievalAvailable: true,
  }),
  gap_analysis: Object.freeze({
    stage: 'gap_analysis',
    workload: 'grounded_document',
    requiredCapabilities: Object.freeze([]),
    maxAttempts: 2,
    retrievalAvailable: true,
  }),
  cv_tailoring: Object.freeze({
    stage: 'cv_tailoring',
    workload: 'grounded_document',
    requiredCapabilities: Object.freeze([]),
    maxAttempts: 2,
    retrievalAvailable: true,
  }),
  cover_letter: Object.freeze({
    stage: 'cover_letter',
    workload: 'grounded_document',
    requiredCapabilities: Object.freeze([]),
    maxAttempts: 2,
    // A cover letter's missing fact is a claim about the candidate that their own CV does not
    // support. There is no store to look that up in: only the candidate can supply it.
    retrievalAvailable: false,
  }),
  application_field_map: Object.freeze({
    stage: 'application_field_map',
    workload: 'closed_set_assignment',
    requiredCapabilities: Object.freeze(['hardenedNoNetwork']),
    maxAttempts: 2,
    retrievalAvailable: true,
  }),
} satisfies Record<GenerationStage, StageContract>);

export function stageContract(stage: GenerationStage): StageContract {
  return STAGE_CONTRACTS[stage];
}

/**
 * Tier order per workload: the first entry is what the stage asks for, later entries are what it
 * will accept while recording a fallback reason, and `unknown` is last everywhere.
 *
 * `grounded_document` accepting `small` at all is a deliberate, recorded degradation rather than a
 * refusal: a user with exactly one installed CLI should still be able to draft a letter, and the
 * routing record says plainly which model wrote it. What it is not allowed to be is *silent* --
 * `router.ts` attaches `no_preferred_tier_available` to that decision.
 */
export const STAGE_TIER_PREFERENCE: Readonly<Record<StageWorkload, readonly ModelTier[]>> = Object.freeze({
  bounded_extraction: Object.freeze(['small', 'capable', 'unknown'] as const),
  grounded_document: Object.freeze(['capable', 'small', 'unknown'] as const),
  // Tier is not what makes a field map correct -- the closed-set schema is (`field-map.ts`). The
  // ordering here only breaks ties among candidates that already cleared the hardening requirement.
  closed_set_assignment: Object.freeze(['capable', 'small', 'unknown'] as const),
});
