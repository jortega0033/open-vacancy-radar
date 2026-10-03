import { X } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useEffectiveProvider } from '../../use-effective-provider.js';
import type { CvDocumentRecord, CvProfile, CvSourceDocument } from '../../window.js';
import { describeCvSourceContentGaps, reconcileExperienceIds } from '../../../electron/workspace/cv-source-schema.js';
import { buildCvParsePrompt, buildSourceCvPrompt } from '../cv/prompts.js';
import { parseSourceCvResponse } from '../cv/source-cv-response.js';
import { useAgentRun } from '../cv/useAgentRun.js';
import { useEscapeToClose } from '../shell/useEscapeToClose.js';
import { parseCvAiResponse } from './cv-ai-parse.js';
import { skillsToText, textToSkills } from './cv-profile.js';
import { coversCvProfileCore, deriveCvProfileFromSource } from './cv-profile-from-source.js';
import { CvSourceReview, type CvSourceReviewHandle } from './CvSourceReview.js';

/**
 * Everything the drawer can change (deliberately not `CvDocumentInput`/`CvDocumentPatch`
 * directly): `kind` never appears here (a manual profile is always created with `kind: 'manual'`,
 * and an existing document's kind can never change), and the page decides at the call site
 * whether this becomes a `createCvDocument` or an `updateCvDocument` call.
 */
export interface CvDrawerSubmitPayload {
  name: string;
  targetRole: string;
  profile: CvProfile;
  /**
   * #274's reviewed structured source CV, present only once one has been read out of this CV's
   * text. Saving the drawer is the review: the main process stamps `reviewedAt` on arrival, which
   * is what lets an export trust that a person actually confirmed these records.
   */
  source?: CvSourceDocument | null;
}

export interface CvDrawerProps {
  mode: 'add' | 'edit';
  /** Present in edit mode: pre-fills the form from the existing record, uploaded or manual. */
  record?: CvDocumentRecord;
  onCancel: () => void;
  /** Rejecting shows the thrown error's message inline; resolving closes the drawer. */
  onSubmit: (payload: CvDrawerSubmitPayload) => Promise<void>;
}

interface FormState {
  name: string;
  targetRole: string;
  title: string;
  years: string;
  location: string;
  languages: string;
  skillsText: string;
  summary: string;
  auth: string;
}

function toFormState(record: CvDocumentRecord | undefined): FormState {
  return {
    name: record?.name ?? '',
    targetRole: record?.targetRole ?? '',
    title: record?.profile.title ?? '',
    years: record?.profile.years ?? '',
    location: record?.profile.location ?? '',
    languages: record?.profile.languages ?? '',
    skillsText: skillsToText(record?.profile.skills ?? []),
    summary: record?.profile.summary ?? '',
    auth: record?.profile.auth ?? '',
  };
}

/**
 * Merges whichever `CvProfile` fields an extraction actually produced onto the form, leaving every
 * other field exactly as the user left it. Shared by the AI-parse path and the deterministic
 * source-CV derivation below precisely because they must land in the form the same way: both are
 * proposals for review, and neither may blank out a field it had nothing to say about.
 */
function applyProfileFields(prev: FormState, parsed: Partial<CvProfile>): FormState {
  return {
    ...prev,
    title: parsed.title ?? prev.title,
    years: parsed.years ?? prev.years,
    location: parsed.location ?? prev.location,
    languages: parsed.languages ?? prev.languages,
    skillsText: parsed.skills ? skillsToText(parsed.skills) : prev.skillsText,
    summary: parsed.summary ?? prev.summary,
    auth: parsed.auth ?? prev.auth,
  };
}

/** How each derivable field is named to the user in the "filled from your source CV" status, in the
 * form's own label wording rather than the schema's field names. */
const DERIVED_FIELD_LABELS: Partial<Record<keyof CvProfile, string>> = {
  title: 'title',
  years: 'years of experience',
  location: 'location',
  summary: 'summary',
};

/**
 * Add/edit drawer for a CV library entry (`export-src.html` "New manual profile" / "Edit parsed
 * profile", lines ~359-445). One form serves both "add a manual profile" and "edit any CV's
 * profile metadata": an uploaded CV has exactly the same `profile` shape as a manual one, just
 * typically blank until someone fills it in here, so a second form would just be this one twice.
 *
 * Docked to the right edge via daisyUI's `modal-end`, matching `ApplicationDrawer`'s convention
 * (self-contained submitting/error state, async `onSubmit`) rather than `SavedJobDrawer`'s plain
 * fixed panel: one of the two existing drawer conventions, not a third.
 */
export function CvDrawer({ mode, record, onCancel, onSubmit }: CvDrawerProps) {
  useEscapeToClose(onCancel);
  const [form, setForm] = useState<FormState>(() => toFormState(record));
  const [validationError, setValidationError] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [parseError, setParseError] = useState<string>();
  const [source, setSource] = useState<CvSourceDocument | null>(() => record?.source ?? null);
  const [sourceError, setSourceError] = useState<string>();
  /** Roles from a fresh extraction that could not be matched to a saved role (#419). */
  const [unmatchedRoles, setUnmatchedRoles] = useState<string[]>([]);
  /** The fields the last click filled in from the source CV instead of from an AI run, in the
   * user's wording. `null` means that has not happened for this drawer. */
  const [derivedFields, setDerivedFields] = useState<string[] | null>(null);
  /** How many tailoring cases use the CV being edited, so the save button can say what it affects (#449). */
  const [caseCount, setCaseCount] = useState(0);

  const isEdit = mode === 'edit';
  const canParseWithAi = isEdit && record?.kind === 'uploaded' && record.text.trim().length > 0;
  // Only the gaps saving cannot close: "not reviewed yet" is what this drawer's own Save button
  // fixes, so listing it here would report a blocker the next click removes.
  const sourceGaps = source ? describeCvSourceContentGaps(source) : [];

  // The same reasoning `sourceGaps` above applies to "reviewed": the record in `source` is the one
  // on screen, either loaded from an already-reviewed CV or sitting in the review panel with the
  // candidate looking at it, and saving the drawer is what stamps the review. Either way it is
  // data a person can see and correct, which is the property the derivation depends on. Recomputed
  // per render rather than memoized, matching `sourceGaps`: it is arithmetic over a handful of
  // records, not work worth caching.
  const derivedProfile = source ? deriveCvProfileFromSource(source) : {};
  const canDeriveFromSource = coversCvProfileCore(derivedProfile);

  // `chunkSeparator: ''`: the parsed response must be byte-exact JSON, not prose, so chunks are
  // concatenated raw rather than joined with the "\n\n" every other AI feature here wants.
  const sourceReviewRef = useRef<CvSourceReviewHandle>(null);

  const parseRun = useAgentRun({ chunkSeparator: '' });
  const parseAppliedRef = useRef(false);
  const parseSucceeded = parseRun.status === 'completed' && !parseError;

  // A second, separate run for #274's full source-CV extraction. Deliberately not folded into the
  // one above: they answer different questions (seven summary fields vs. the whole document as
  // records), they read different amounts of the CV, and a failure of one must not discard the
  // other's result while the user is part-way through a review.
  const sourceRun = useAgentRun({ chunkSeparator: '' });
  const sourceAppliedRef = useRef(false);

  // Mirrors how every other AI feature (Gap Analysis, Letters, ...) resolves which CLI to run
  // through (issue #400): the effective provider, not the raw persisted preference, so this still
  // runs on a machine where the preferred CLI isn't installed but exactly one alternative is.
  const { provider } = useEffectiveProvider();

  const recordId = record?.id;
  useEffect(() => {
    if (!recordId) return;
    let cancelled = false;
    // A listing failure leaves the notice out rather than blocking the edit.
    void window.workspace
      .listCvEvidenceOverlays(recordId)
      .then((cases) => {
        if (!cancelled) setCaseCount(cases.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [recordId]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // Applies the AI's fields to the form exactly once per run, the moment that run completes:
  // never automatically saved, so a wrong or thin answer costs the user a glance, not their data.
  useEffect(() => {
    if (parseRun.status !== 'completed' || parseAppliedRef.current) return;
    parseAppliedRef.current = true;
    try {
      const parsed = parseCvAiResponse(parseRun.text);
      setForm((prev) => applyProfileFields(prev, parsed));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'could not read the AI response');
    }
  }, [parseRun.status, parseRun.text]);

  // Same "apply exactly once, never auto-save" rule as the profile parse above: the extracted
  // records land in the review panel for the candidate to correct and confirm, and only reach the
  // database when they press Save.
  useEffect(() => {
    if (sourceRun.status !== 'completed' || sourceAppliedRef.current || !record) return;
    sourceAppliedRef.current = true;
    try {
      const extracted = parseSourceCvResponse(sourceRun.text, record.text);
      // A re-extraction keeps the ids of roles it can match unambiguously. The rest get new ids and
      // are listed below for the candidate to check, never renumbered onto a saved role.
      const { experience, needsReview } = reconcileExperienceIds(record.source?.experience ?? [], extracted.experience);
      setSource({ ...extracted, experience });
      setUnmatchedRoles(record.source ? needsReview : []);
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : 'could not read the AI response');
    }
  }, [sourceRun.status, sourceRun.text, record]);

  // Cancels an in-flight parse if the drawer closes (Save, Cancel, backdrop, or the close button) while
  // it's still running, otherwise the daemon session keeps running unobserved until it times out.
  // A ref, not `parseRun` in the dependency array: `parseRun` is a fresh object every render, and
  // this must run its cleanup only on actual unmount, reading whatever the latest run was.
  const parseRunRef = useRef(parseRun);
  parseRunRef.current = parseRun;
  const sourceRunRef = useRef(sourceRun);
  sourceRunRef.current = sourceRun;
  useEffect(() => {
    return () => {
      if (parseRunRef.current.isBusy) void parseRunRef.current.cancel();
      if (sourceRunRef.current.isBusy) void sourceRunRef.current.cancel();
    };
  }, []);

  /**
   * Fills the seven summary fields, from the structured source CV when there is one and from the
   * AI-parse prompt when there is not.
   *
   * The branch is the whole point: `buildSourceCvPrompt` has already read this CV end to end into
   * records the candidate can see, and asking a second model run to re-read the same text for the
   * title, the years and the location it can be computed from is a wait and a second chance to come
   * back unparseable, for facts already in hand. When the derivation cannot produce those core
   * fields -- dates this app cannot read, a CV with no employment history at all -- nothing is
   * applied and the original AI call runs exactly as it always has, so the fallback is the
   * behaviour users already know rather than a blank field.
   */
  function handleParseWithAi() {
    if (!record || !canParseWithAi) return;
    setParseError(undefined);

    if (canDeriveFromSource) {
      setForm((prev) => applyProfileFields(prev, derivedProfile));
      setDerivedFields(
        (Object.keys(derivedProfile) as (keyof CvProfile)[])
          .map((key) => DERIVED_FIELD_LABELS[key])
          .filter((label): label is string => label !== undefined),
      );
      return;
    }

    setDerivedFields(null);
    parseAppliedRef.current = false;
    void parseRun.start(buildCvParsePrompt(record.name, record.text), { provider });
  }

  function handleReadSourceCv() {
    if (!record || !canParseWithAi) return;
    sourceAppliedRef.current = false;
    setSourceError(undefined);
    setUnmatchedRoles([]);
    void sourceRun.start(buildSourceCvPrompt(record.name, record.text), { provider });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setValidationError('Name is required.');
      return;
    }
    setValidationError(undefined);

    // Check for unsaved validation errors in the source CV review
    if (source && sourceReviewRef.current) {
      const maxProjectsError = sourceReviewRef.current.getMaxProjectsError();
      if (maxProjectsError) {
        setError(`Fix the project count: ${maxProjectsError}`);
        return;
      }
    }

    const payload: CvDrawerSubmitPayload = {
      name,
      targetRole: form.targetRole.trim(),
      profile: {
        title: form.title.trim(),
        years: form.years.trim(),
        location: form.location.trim(),
        languages: form.languages.trim(),
        skills: textToSkills(form.skillsText),
        summary: form.summary.trim(),
        auth: form.auth.trim(),
      },
      ...(source ? { source } : {}),
    };

    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not save this CV');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="modal modal-open modal-end"
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? 'Edit CV' : 'Add manual CV profile'}
    >
      <div className="modal-box flex max-w-md flex-col rounded-none p-0">
        <div className="flex items-center justify-between border-b border-base-300 px-5 py-3.5">
          <h2 className="text-sm font-semibold">{isEdit ? 'Edit CV' : 'Add manual profile'}</h2>
          <button
            type="button"
            aria-label="Close"
            className="btn btn-ghost btn-sm btn-circle"
            onClick={onCancel}
            disabled={submitting}
          >
            <X size={16} weight="bold" aria-hidden="true" />
          </button>
        </div>

        <form className="flex flex-1 flex-col overflow-y-auto" noValidate onSubmit={handleSubmit}>
          <div className="flex-1 space-y-3 px-5 py-4">
            {canParseWithAi && (
              <div className="rounded-box border border-base-300 bg-base-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={handleParseWithAi}
                    disabled={submitting || parseRun.isBusy}
                  >
                    {parseRun.isBusy && <span className="loading loading-spinner loading-xs text-base-content" aria-hidden="true" />}
                    Fill in from my CV
                  </button>
                  {parseRun.isBusy && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void parseRun.cancel()}
                    >
                      Stop
                    </button>
                  )}
                  <span className="text-xs text-base-content/60">
                    Fills the fields below. You can edit them.
                  </span>
                </div>
                {(derivedFields || parseSucceeded) && (
                  <p className="mt-2 text-xs text-success" role="status">
                    Filled in from your CV. Check before saving.
                  </p>
                )}
                {(parseError ?? (parseRun.status === 'failed' ? parseRun.error : undefined)) && (
                  <p className="mt-2 text-xs text-error" role="alert">
                    {parseError ?? parseRun.error}
                  </p>
                )}
              </div>
            )}

            {canParseWithAi && (
              <div className="rounded-box border border-base-300 bg-base-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={handleReadSourceCv}
                    disabled={submitting || sourceRun.isBusy}
                  >
                    {sourceRun.isBusy && <span className="loading loading-spinner loading-xs text-base-content" aria-hidden="true" />}
                    {source ? 'Read my CV again' : 'Read my full CV'}
                  </button>
                  {sourceRun.isBusy && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void sourceRun.cancel()}>
                      Stop
                    </button>
                  )}
                  <span className="text-xs text-base-content/60">
                    Saves your jobs, dates and projects for tailoring and exports.
                  </span>
                </div>
                {(sourceError ?? (sourceRun.status === 'failed' ? sourceRun.error : undefined)) && (
                  <p className="mt-2 text-xs text-error" role="alert">
                    {sourceError ?? sourceRun.error}
                  </p>
                )}
              </div>
            )}

            {source && unmatchedRoles.length > 0 && (
              <div className="alert alert-warning text-sm" role="status">
                <div>
                  Some roles looked new, so earlier facts and wording stay with the old version until you review
                  them: {unmatchedRoles.join(', ')}.
                </div>
              </div>
            )}
            {source && <CvSourceReview ref={sourceReviewRef} source={source} disabled={submitting} onChange={setSource} />}
            {source && sourceGaps.length > 0 && (
              <p className="text-xs text-warning" role="status">
                Saved. This CV cannot be exported yet: {sourceGaps.join('; ')}.
              </p>
            )}

            <label className="block">
              <span className="mb-1.5 block ovr-eyebrow">
                Name *
              </span>
              <input
                className="input w-full"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                disabled={submitting}
                placeholder="e.g. Tech CV, Sales CV"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block ovr-eyebrow">
                Target role
              </span>
              <input
                className="input w-full"
                value={form.targetRole}
                onChange={(e) => set('targetRole', e.target.value)}
                disabled={submitting}
                placeholder="e.g. Nurse, Data analyst"
              />
            </label>

            <div className="grid grid-cols-2 gap-2.5">
              <label className="block">
                <span className="mb-1.5 block ovr-eyebrow">
                  Title
                </span>
                <input
                  className="input w-full"
                  value={form.title}
                  onChange={(e) => set('title', e.target.value)}
                  disabled={submitting}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block ovr-eyebrow">
                  Years of experience
                </span>
                <input
                  className="input w-full"
                  value={form.years}
                  onChange={(e) => set('years', e.target.value)}
                  disabled={submitting}
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <label className="block">
                <span className="mb-1.5 block ovr-eyebrow">
                  Location
                </span>
                <input
                  className="input w-full"
                  value={form.location}
                  onChange={(e) => set('location', e.target.value)}
                  disabled={submitting}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block ovr-eyebrow">
                  Languages
                </span>
                <input
                  className="input w-full"
                  value={form.languages}
                  onChange={(e) => set('languages', e.target.value)}
                  disabled={submitting}
                  placeholder="e.g. Dutch (B2), English (native)"
                />
              </label>
            </div>

            <label className="block">
              <span className="mb-1.5 block ovr-eyebrow">
                Skills
              </span>
              <input
                className="input w-full"
                value={form.skillsText}
                onChange={(e) => set('skillsText', e.target.value)}
                disabled={submitting}
                placeholder="Comma-separated, e.g. Angular, TypeScript, RxJS"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block ovr-eyebrow">
                Work authorization
              </span>
              <input
                className="input w-full"
                value={form.auth}
                onChange={(e) => set('auth', e.target.value)}
                disabled={submitting}
                placeholder="e.g. EU citizen, no sponsorship needed"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block ovr-eyebrow">
                Summary
              </span>
              <textarea
                className="textarea w-full"
                rows={4}
                value={form.summary}
                onChange={(e) => set('summary', e.target.value)}
                disabled={submitting}
              />
            </label>

            {validationError && (
              <p className="text-sm text-error" role="alert">
                {validationError}
              </p>
            )}
            {error && (
              <p className="text-sm text-error" role="alert">
                {error}
              </p>
            )}
          </div>

          {isEdit && caseCount > 0 && (
            <p className="border-t border-base-300 px-5 py-3 text-sm text-base-content/70" role="status">
              {caseCount === 1 ? '1 tailoring case uses this CV.' : `${caseCount} tailoring cases use this CV.`} Saving
              changes puts {caseCount === 1 ? 'it' : 'them'} on hold until you review what changed. Files you already
              exported stay on disk.
            </p>
          )}

          <div className="flex justify-end gap-2 border-t border-base-300 px-5 py-3.5">
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting && <span className="loading loading-spinner loading-xs text-primary-content" aria-hidden="true" />}
              {isEdit ? 'Save changes' : 'Add CV'}
            </button>
          </div>
        </form>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onCancel} disabled={submitting} />
    </div>
  );
}
