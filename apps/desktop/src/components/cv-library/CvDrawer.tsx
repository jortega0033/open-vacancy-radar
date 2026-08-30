import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CvDocumentRecord, CvProfile } from '../../window.js';
import { buildCvParsePrompt } from '../cv/prompts.js';
import { useAgentRun } from '../cv/useAgentRun.js';
import { parseCvAiResponse } from './cv-ai-parse.js';
import { skillsToText, textToSkills } from './cv-profile.js';

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
  const [form, setForm] = useState<FormState>(() => toFormState(record));
  const [validationError, setValidationError] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [parseError, setParseError] = useState<string>();

  const isEdit = mode === 'edit';
  const canParseWithAi = isEdit && record?.kind === 'uploaded' && record.text.trim().length > 0;

  // `chunkSeparator: ''`: the parsed response must be byte-exact JSON, not prose, so chunks are
  // concatenated raw rather than joined with the "\n\n" every other AI feature here wants.
  const parseRun = useAgentRun({ chunkSeparator: '' });
  const parseAppliedRef = useRef(false);
  const parseSucceeded = parseRun.status === 'completed' && !parseError;

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
      setForm((prev) => ({
        ...prev,
        title: parsed.title ?? prev.title,
        years: parsed.years ?? prev.years,
        location: parsed.location ?? prev.location,
        languages: parsed.languages ?? prev.languages,
        skillsText: parsed.skills ? skillsToText(parsed.skills) : prev.skillsText,
        summary: parsed.summary ?? prev.summary,
        auth: parsed.auth ?? prev.auth,
      }));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'could not read the AI response');
    }
  }, [parseRun.status, parseRun.text]);

  // Cancels an in-flight parse if the drawer closes (Save, Cancel, backdrop, or the ✕ button) while
  // it's still running, otherwise the daemon session keeps running unobserved until it times out.
  // A ref, not `parseRun` in the dependency array: `parseRun` is a fresh object every render, and
  // this must run its cleanup only on actual unmount, reading whatever the latest run was.
  const parseRunRef = useRef(parseRun);
  parseRunRef.current = parseRun;
  useEffect(() => {
    return () => {
      if (parseRunRef.current.isBusy) void parseRunRef.current.cancel();
    };
  }, []);

  function handleParseWithAi() {
    if (!record || !canParseWithAi) return;
    parseAppliedRef.current = false;
    setParseError(undefined);
    void parseRun.start(buildCvParsePrompt(record.name, record.text));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setValidationError('Name is required.');
      return;
    }
    setValidationError(undefined);

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
            ✕
          </button>
        </div>

        <form className="flex flex-1 flex-col overflow-y-auto" onSubmit={handleSubmit}>
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
                    {parseRun.isBusy && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
                    Parse with AI
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
                    Reads the extracted text and fills in the fields below for you to review.
                  </span>
                </div>
                {parseSucceeded && (
                  <p className="mt-2 text-xs text-success" role="status">
                    Filled in from your CV: review before saving.
                  </p>
                )}
                {(parseError ?? (parseRun.status === 'failed' ? parseRun.error : undefined)) && (
                  <p className="mt-2 text-xs text-error" role="alert">
                    {parseError ?? parseRun.error}
                  </p>
                )}
              </div>
            )}

            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                Name *
              </span>
              <input
                className="input w-full"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                disabled={submitting}
                placeholder="e.g. Frontend CV: Netherlands"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                Target role
              </span>
              <input
                className="input w-full"
                value={form.targetRole}
                onChange={(e) => set('targetRole', e.target.value)}
                disabled={submitting}
                placeholder="e.g. Senior Frontend Engineer"
              />
            </label>

            <div className="grid grid-cols-2 gap-2.5">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
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
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
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
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
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
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
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
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
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
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
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
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
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

          <div className="flex justify-end gap-2 border-t border-base-300 px-5 py-3.5">
            <button type="button" className="btn btn-outline" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
              {isEdit ? 'Save changes' : 'Add CV'}
            </button>
          </div>
        </form>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onCancel} disabled={submitting} />
    </div>
  );
}
