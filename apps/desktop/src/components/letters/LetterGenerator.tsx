import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import type {
  CvDocumentRecord,
  LetterInput,
  LetterLength,
  LetterRecord,
  LetterStatus,
  LetterTone,
  LetterType,
  SavedJobRecord,
} from '../../window.js';
import { AiOutput } from '../cv/AiOutput.js';
import type { CvDocument } from '../cv/types.js';
import { describeError, useAgentRun } from '../cv/useAgentRun.js';
import { buildLetterPrompt, MAX_INSTRUCTION_CHARS } from './prompt.js';
import {
  labelFor,
  LETTER_LENGTH_OPTIONS,
  LETTER_STATUS_OPTIONS,
  LETTER_TONE_OPTIONS,
  LETTER_TYPE_OPTIONS,
  type SelectedVacancy,
} from './types.js';

/** Sentinel values for the job picker; a saved job is `saved:<id>`. */
const JOB_LIVE = 'live';
const JOB_MANUAL = 'manual';
const JOB_SAVED_PREFIX = 'saved:';

export interface LetterGeneratorProps {
  /** An existing row to edit. Saving updates it in place rather than creating a second copy. */
  letter?: LetterRecord | null;
  /**
   * A vacancy selected elsewhere in the app (the Search page holds one in `App.tsx` today). Passed
   * in rather than read from a store so this page works standalone: with nothing supplied, the job
   * is typed in by hand or picked from Saved Jobs.
   */
  vacancy?: SelectedVacancy | null;
  /** Optional provider model id; omitted means the CLI's own default. */
  model?: string;
  /** Called with the persisted row after every successful save. */
  onSaved?: (letter: LetterRecord) => void;
  /** Rendered as a "Back to library" affordance when supplied. */
  onClose?: () => void;
}

/**
 * Generate → edit → save, in one screen.
 *
 * The generation step is a real agent run: `useAgentRun` (shared with the CV assistant) starts an
 * AgentDock session on the user's own Claude Code CLI and streams `assistant.message` chunks back.
 * That means it is genuinely asynchronous and can genuinely fail, so this component keeps three
 * separate ideas apart that a fake instant generator would let collapse into one:
 *
 * - **the stream** (`run.text`) — read-only, appended to as it arrives, shown through the same
 *   `AiOutput` surface as the rest of the app;
 * - **the working document** (`body`) — a plain editable text area, seeded from the stream once the
 *   run completes and owned by the user from that moment on;
 * - **the saved row** (`letterId` / `savedBody`) — what is actually in the database.
 *
 * Because those are separate, a failed *re*generation cannot destroy a letter that was already
 * loaded or already saved: the error appears above the editor and the text stays exactly as it was.
 */
export function LetterGenerator({
  letter = null,
  vacancy = null,
  model,
  onSaved,
  onClose,
}: LetterGeneratorProps) {
  const run = useAgentRun();

  const [cvs, setCvs] = useState<CvDocumentRecord[]>([]);
  const [cvError, setCvError] = useState<string>();
  const [savedJobs, setSavedJobs] = useState<SavedJobRecord[]>([]);

  const [cvId, setCvId] = useState<string>(letter?.cvId ?? '');
  const [jobSource, setJobSource] = useState<string>(vacancy && !letter ? JOB_LIVE : JOB_MANUAL);

  const [manualRole, setManualRole] = useState(letter?.role ?? '');
  const [manualCompany, setManualCompany] = useState(letter?.company ?? '');
  const [manualLocation, setManualLocation] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualDescription, setManualDescription] = useState('');

  const [type, setType] = useState<LetterType>(letter?.type ?? 'motivation_letter');
  const [tone, setTone] = useState<LetterTone>(letter?.tone ?? 'natural');
  const [length, setLength] = useState<LetterLength>(letter?.length ?? 'standard');
  const [status, setStatus] = useState<LetterStatus>(letter?.status ?? 'draft');
  const [instructions, setInstructions] = useState('');
  const [provider, setProvider] = useState<ProviderId>('claude');

  const [title, setTitle] = useState(letter?.title ?? '');
  // A title the user typed is theirs; only an untouched one keeps tracking the type and company.
  const titleTouched = useRef(letter !== null);

  const [body, setBody] = useState(letter?.body ?? '');
  const [letterId, setLetterId] = useState<string | null>(letter?.id ?? null);
  const [savedBody, setSavedBody] = useState(letter?.body ?? '');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [saveError, setSaveError] = useState<string>();
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  // Which run's output has already been moved into the editor. A counter rather than a text
  // comparison, so a second run that happens to produce the identical text still replaces edits the
  // user made in between — "Regenerate" must always mean "replace with the new draft".
  const runSeq = useRef(0);
  const appliedSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const docs = await window.workspace.listCvDocuments();
        if (!cancelled) setCvs(docs);
      } catch (err) {
        if (!cancelled) setCvError(describeError(err, 'could not load your CV library'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Saved jobs are a convenience source for the job picker, so a failure here silently leaves the
  // picker with the manual option rather than blocking generation.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const jobs = await window.workspace.listSavedJobs();
        if (!cancelled) setSavedJobs(jobs);
      } catch {
        // manual entry still works
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Document defaults come from the persisted settings row for a new letter only; an existing one
  // carries its own type/tone/length and must not be silently re-styled by opening it.
  useEffect(() => {
    if (letter) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await window.workspace.getSettings();
        if (cancelled) return;
        setType(settings.defaultLetterType);
        setTone(settings.defaultLetterTone);
        setLength(settings.defaultLetterLength);
        const defaultCvId = settings.defaultCvId;
        if (defaultCvId) setCvId((current) => current || defaultCvId);
      } catch {
        // the useState defaults are already sensible
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [letter]);

  // Which CLI a generation runs through is a runtime preference, not a per-document style choice
  // like tone/type/length, so it is read for every letter — new or existing — not gated on `!letter`.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await window.workspace.getSettings();
        if (!cancelled) setProvider(settings.defaultProvider);
      } catch {
        // the useState default ('claude') is already sensible
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Once the library lands, settle on a CV: whatever was already chosen if it still exists, else
  // the library's default, else the first one.
  useEffect(() => {
    if (cvs.length === 0) return;
    setCvId((current) => {
      if (current && cvs.some((doc) => doc.id === current)) return current;
      const fallback = cvs.find((doc) => doc.isDefault) ?? cvs[0];
      return fallback ? fallback.id : current;
    });
  }, [cvs]);

  const selectedSavedJob = useMemo(() => {
    if (!jobSource.startsWith(JOB_SAVED_PREFIX)) return null;
    const id = jobSource.slice(JOB_SAVED_PREFIX.length);
    return savedJobs.find((job) => job.id === id) ?? null;
  }, [jobSource, savedJobs]);

  const lead: SelectedVacancy | null = useMemo(() => {
    if (jobSource === JOB_LIVE && vacancy) return vacancy;
    if (selectedSavedJob) {
      return {
        title: selectedSavedJob.role,
        company: selectedSavedJob.company,
        location: selectedSavedJob.location,
        url: selectedSavedJob.sourceUrl ?? '',
        description: selectedSavedJob.notes.trim() || null,
        key: selectedSavedJob.vacancyKey,
      };
    }
    const role = manualRole.trim();
    const company = manualCompany.trim();
    // Both are required: a document with no role has nothing to argue for, and one with no employer
    // cannot be addressed without inventing a name.
    if (!role || !company) return null;
    return {
      title: role,
      company,
      location: manualLocation.trim(),
      url: manualUrl.trim(),
      description: manualDescription.trim() || null,
    };
  }, [
    jobSource,
    vacancy,
    selectedSavedJob,
    manualRole,
    manualCompany,
    manualLocation,
    manualUrl,
    manualDescription,
  ]);

  const vacancyKey = useMemo(() => {
    if (jobSource === JOB_LIVE && vacancy) return vacancy.key ?? null;
    if (selectedSavedJob) return selectedSavedJob.vacancyKey;
    // Manual entry on a reopened letter: keep the link it already had, but only while it still names
    // the same job. Retyping the company means this text is for a different vacancy now.
    if (letter && manualCompany.trim() === letter.company && manualRole.trim() === letter.role) {
      return letter.vacancyKey;
    }
    return null;
  }, [jobSource, vacancy, selectedSavedJob, letter, manualCompany, manualRole]);

  const cvRecord = useMemo(() => cvs.find((doc) => doc.id === cvId) ?? null, [cvs, cvId]);
  const cvDocument: CvDocument | null = cvRecord ? { fileName: cvRecord.name, text: cvRecord.text } : null;

  const typeLabel = labelFor(LETTER_TYPE_OPTIONS, type);
  const derivedTitle = useMemo(() => {
    const company = lead?.company?.trim() ?? '';
    return company ? `${typeLabel} — ${company}` : typeLabel;
  }, [typeLabel, lead?.company]);

  useEffect(() => {
    if (!titleTouched.current) setTitle(derivedTitle);
  }, [derivedTitle]);

  // Hand the finished stream to the editor. Only on `completed`: a failed or cancelled run leaves
  // whatever the user already had in place.
  useEffect(() => {
    if (run.status !== 'completed') return;
    if (appliedSeq.current === runSeq.current) return;
    const text = run.text.trim();
    if (!text) return;
    appliedSeq.current = runSeq.current;
    setBody(text);
  }, [run.status, run.text]);

  const hasBody = body.trim().length > 0;
  const isDirty = body !== savedBody;
  const canGenerate = !!cvDocument && !!lead && !run.isBusy;

  const startRun = useCallback(() => {
    if (!cvDocument || !lead) return;
    setConfirmRegenerate(false);
    setSaveState('idle');
    setSaveError(undefined);
    runSeq.current += 1;
    void run.start(buildLetterPrompt(cvDocument, lead, { type, tone, length, instructions }), {
      ...(model ? { model } : {}),
      provider,
    });
  }, [cvDocument, lead, type, tone, length, instructions, model, provider, run]);

  const handleGenerate = useCallback(() => {
    // Replacing text the user has edited but not saved is the one destructive thing this screen
    // does, so it asks first — and only then.
    if (hasBody && isDirty && !confirmRegenerate) {
      setConfirmRegenerate(true);
      return;
    }
    startRun();
  }, [hasBody, isDirty, confirmRegenerate, startRun]);

  const handleSave = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSaveState('saving');
    setSaveError(undefined);

    const input: LetterInput = {
      title: title.trim() || derivedTitle,
      company: lead?.company ?? letter?.company ?? '',
      role: lead?.title ?? letter?.role ?? '',
      type,
      tone,
      length,
      status,
      vacancyKey,
      cvId: cvId || null,
      body: trimmed,
    };

    try {
      const record = letterId
        ? await window.workspace.updateLetter(letterId, input)
        : await window.workspace.createLetter(input);
      // Holding the new id here (rather than remounting from a parent) is what makes the second
      // save an update: edit → save → edit → save leaves exactly one row.
      setLetterId(record.id);
      setSavedBody(record.body);
      setBody(record.body);
      setSaveState('saved');
      onSaved?.(record);
    } catch (err) {
      setSaveState('idle');
      setSaveError(describeError(err, 'could not save this letter'));
    }
  }, [
    body,
    title,
    derivedTitle,
    lead,
    letter,
    type,
    tone,
    length,
    status,
    vacancyKey,
    cvId,
    letterId,
    onSaved,
  ]);

  const showStreamPanel = run.isBusy || run.status === 'failed' || run.status === 'cancelled';

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <aside className="w-full shrink-0 lg:w-72">
        <div className="flex flex-col gap-5">
          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-base-content/50 uppercase">Job</h3>
            <label className="block">
              <span className="sr-only">Job</span>
              <select
                className="select w-full"
                aria-label="Job"
                value={jobSource}
                onChange={(event) => setJobSource(event.target.value)}
                disabled={run.isBusy}
              >
                {vacancy && <option value={JOB_LIVE}>{`${vacancy.title} — ${vacancy.company}`}</option>}
                <option value={JOB_MANUAL}>Enter the job manually</option>
                {savedJobs.map((job) => (
                  <option key={job.id} value={`${JOB_SAVED_PREFIX}${job.id}`}>
                    {`${job.role} — ${job.company}`}
                  </option>
                ))}
              </select>
            </label>

            {jobSource === JOB_LIVE && vacancy && (
              <div className="rounded-box mt-2 border border-base-300 p-3 text-sm">
                <div className="font-semibold">{vacancy.title}</div>
                <div className="text-base-content/60">
                  {vacancy.company}
                  {vacancy.location ? ` — ${vacancy.location}` : ''}
                </div>
              </div>
            )}

            {selectedSavedJob && (
              <div className="rounded-box mt-2 border border-base-300 p-3 text-sm">
                <div className="font-semibold">{selectedSavedJob.role}</div>
                <div className="text-base-content/60">
                  {selectedSavedJob.company}
                  {selectedSavedJob.location ? ` — ${selectedSavedJob.location}` : ''}
                </div>
              </div>
            )}

            {jobSource === JOB_MANUAL && (
              <div className="mt-2 flex flex-col gap-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">Role</span>
                  <input
                    className="input w-full"
                    type="text"
                    value={manualRole}
                    onChange={(event) => setManualRole(event.target.value)}
                    placeholder="Senior Frontend Engineer"
                    disabled={run.isBusy}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">Company</span>
                  <input
                    className="input w-full"
                    type="text"
                    value={manualCompany}
                    onChange={(event) => setManualCompany(event.target.value)}
                    placeholder="Redwood Software"
                    disabled={run.isBusy}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">Location</span>
                  <input
                    className="input w-full"
                    type="text"
                    value={manualLocation}
                    onChange={(event) => setManualLocation(event.target.value)}
                    placeholder="Amsterdam, Netherlands"
                    disabled={run.isBusy}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">Posting URL</span>
                  <input
                    className="input w-full"
                    type="text"
                    value={manualUrl}
                    onChange={(event) => setManualUrl(event.target.value)}
                    placeholder="https://…"
                    disabled={run.isBusy}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">Posting text</span>
                  <textarea
                    className="textarea w-full"
                    rows={5}
                    value={manualDescription}
                    onChange={(event) => setManualDescription(event.target.value)}
                    placeholder="Paste the description and requirements here."
                    disabled={run.isBusy}
                  />
                  <span className="mt-1 block text-xs text-base-content/50">
                    Optional, but the draft is only as specific as the posting text you give it.
                  </span>
                </label>
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-base-content/50 uppercase">CV</h3>
            {cvError && (
              <div className="alert alert-error alert-soft mb-2 text-sm" role="alert">
                {cvError}
              </div>
            )}
            {cvs.length === 0 && !cvError ? (
              <p className="text-sm text-base-content/60">
                No CVs saved yet. Upload one on the Search page and choose “Save to CV library”, then
                come back here.
              </p>
            ) : (
              <label className="block">
                <span className="sr-only">CV</span>
                <select
                  className="select w-full"
                  aria-label="CV"
                  value={cvId}
                  onChange={(event) => setCvId(event.target.value)}
                  disabled={run.isBusy}
                >
                  {cvs.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.isDefault ? `${doc.name} (default)` : doc.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-base-content/50 uppercase">
              Document
            </h3>
            <div className="flex flex-col gap-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Type</span>
                <select
                  className="select w-full"
                  value={type}
                  onChange={(event) => setType(event.target.value as LetterType)}
                  disabled={run.isBusy}
                >
                  {LETTER_TYPE_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Tone</span>
                <select
                  className="select w-full"
                  value={tone}
                  onChange={(event) => setTone(event.target.value as LetterTone)}
                  disabled={run.isBusy}
                >
                  {LETTER_TONE_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Length</span>
                <select
                  className="select w-full"
                  value={length}
                  onChange={(event) => setLength(event.target.value as LetterLength)}
                  disabled={run.isBusy}
                >
                  {LETTER_LENGTH_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-base-content/50 uppercase">
              Personal instructions
            </h3>
            <label className="block">
              <span className="sr-only">Personal instructions</span>
              <textarea
                className="textarea w-full"
                aria-label="Personal instructions"
                rows={3}
                maxLength={MAX_INSTRUCTION_CHARS}
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="e.g. mention the referral from Marta"
                disabled={run.isBusy}
              />
            </label>
            <p className="mt-1 text-xs text-base-content/50">
              Optional. Instructions never override the rule that nothing may be claimed the CV does
              not support.
            </p>
          </section>

          <div className="flex flex-col gap-2">
            <button className="btn btn-primary w-full" type="button" onClick={handleGenerate} disabled={!canGenerate}>
              {run.isBusy ? 'Generating…' : hasBody ? 'Regenerate' : 'Generate'}
            </button>
            {run.isBusy && (
              <button className="btn btn-outline w-full" type="button" onClick={() => void run.cancel()}>
                Cancel
              </button>
            )}
            {confirmRegenerate && !run.isBusy && (
              <div className="alert alert-soft flex-col items-start gap-2 text-sm" role="alert">
                <span>This replaces the current text, and it has unsaved edits.</span>
                <div className="flex gap-2">
                  <button className="btn btn-sm btn-primary" type="button" onClick={startRun}>
                    Regenerate anyway
                  </button>
                  <button className="btn btn-sm btn-ghost" type="button" onClick={() => setConfirmRegenerate(false)}>
                    Keep my draft
                  </button>
                </div>
              </div>
            )}
            {!cvDocument && cvs.length > 0 && (
              <p className="text-xs text-base-content/50">Choose a CV to enable generation.</p>
            )}
            {!lead && (
              <p className="text-xs text-base-content/50">
                Choose a job, or enter a role and a company, to enable generation.
              </p>
            )}
            <p className="text-xs text-base-content/50">
              Generated on your own Claude Code CLI through AgentDock. Nothing is sent to a
              letter-writing service.
            </p>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Letter title</span>
            <input
              className="input w-full font-semibold"
              type="text"
              aria-label="Letter title"
              value={title}
              onChange={(event) => {
                titleTouched.current = true;
                setTitle(event.target.value);
              }}
              placeholder="Letter title"
            />
          </label>
          <label>
            <span className="sr-only">Status</span>
            <select
              className="select"
              aria-label="Status"
              value={status}
              onChange={(event) => setStatus(event.target.value as LetterStatus)}
            >
              {LETTER_STATUS_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => void handleSave()}
            disabled={!hasBody || saveState === 'saving' || run.isBusy}
          >
            {saveState === 'saving' && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
            {letterId ? 'Save changes' : 'Save letter'}
          </button>
          {onClose && (
            <button className="btn btn-ghost" type="button" onClick={onClose}>
              Back to library
            </button>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          {saveState === 'saved' && !isDirty && (
            <span className="text-success" role="status">
              Saved to your letters.
            </span>
          )}
          {letterId && isDirty && <span className="text-base-content/60">Unsaved changes.</span>}
        </div>

        {saveError && (
          <div className="alert alert-error mt-3 text-sm" role="alert">
            {saveError}
          </div>
        )}

        {showStreamPanel && (
          <AiOutput
            status={run.status}
            text={run.text}
            {...(run.error ? { error: run.error } : {})}
            label="letter being generated"
            idleHint="No document yet."
            busyLabel={`Writing a ${typeLabel.toLowerCase()} for this vacancy…`}
          />
        )}

        {hasBody ? (
          <div className="mt-4">
            <textarea
              className="textarea rounded-box max-h-none w-full leading-relaxed"
              aria-label="Letter body"
              rows={22}
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                setSaveState('idle');
              }}
            />
            <p className="mt-2 text-xs text-base-content/50">
              A first draft written from your CV and the posting text above. Read it before you send
              it — you are responsible for the final text.
            </p>
          </div>
        ) : (
          !showStreamPanel && (
            <div className="rounded-box mt-4 border border-base-300 p-8 text-center">
              <div className="text-sm font-semibold">No document yet</div>
              <p className="mt-1.5 text-sm text-base-content/60">
                Choose a job, a CV and the document settings, then generate. The draft is written
                from your saved CV and the vacancy text, and stays editable.
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
