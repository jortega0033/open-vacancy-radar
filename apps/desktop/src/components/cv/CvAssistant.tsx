import { useCallback, useEffect, useMemo, useState } from 'react';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { useEffectiveProvider } from '../../use-effective-provider.js';
import { describeCvSourceGaps } from '../../../electron/workspace/cv-source-schema.js';
import type { CvDocumentRecord } from '../../window.js';
import { ComposedCvReview } from './ComposedCvReview.js';
import { CoverLetter } from './CoverLetter.js';
import { CvUpload } from './CvUpload.js';
import { GapAnalysis } from './GapAnalysis.js';
import { JdReview } from './JdReview.js';
import { RequirementMapping } from './RequirementMapping.js';
import { SaveCvToLibrary } from './SaveCvToLibrary.js';
import { ResumeToolkit } from './ResumeToolkit.js';
import { TailorCv } from './TailorCv.js';
import { TailoringProposalsPanel } from './TailoringProposalsPanel.js';
import type { CvDocument, VacancyLead } from './types.js';
import { caseKeyFor } from './vacancy-key.js';

/**
 * The one thing the app shell renders: `<CvAssistant vacancy={selectedVacancy} />`.
 *
 * It owns exactly one piece of shared state (the loaded CV) so every AI feature below it reads
 * the same document without the user uploading it three times. Everything else (session lifecycle,
 * streaming, errors) belongs to the individual feature components, which each run their own
 * session: gap analysis reports, the cover letter drafts new prose, and the tailored CV re-orders
 * the document itself.
 */
export interface CvAssistantProps {
  /** The vacancy-specific features work against this; null until Search selects one. */
  vacancy: VacancyLead | null;
  /** Optional: skip the model picker and pin a model. */
  model?: string;
  /** Optional return action when the assistant was opened from a vacancy detail. */
  onBackToVacancy?: () => void;
}

function cvDocumentFromLibrary(doc: CvDocumentRecord): CvDocument {
  return { fileName: doc.name, text: doc.text };
}

export function CvAssistant({ vacancy: selectedVacancy, model: pinnedModel, onBackToVacancy }: CvAssistantProps) {
  const [cv, setCv] = useState<CvDocument | null>(null);
  const [libraryCvs, setLibraryCvs] = useState<CvDocumentRecord[]>([]);
  const [selectedLibraryCvId, setSelectedLibraryCvId] = useState('');
  const [libraryError, setLibraryError] = useState<string>();
  const [model, setModel] = useState('');
  const { provider, providerStatus } = useEffectiveProvider();

  // #419: text the candidate pasted over this vacancy's job description. Held here so every panel
  // below reads the same text, and tied to one case key so moving to another vacancy drops it.
  const [pasted, setPasted] = useState<{ key: string; text: string; requisition: string } | null>(null);
  // Bumped when the saved JD changes, so panels that cached the case reload it (their requirement
  // reviews are cleared server-side when the text changes).
  const [jdVersion, setJdVersion] = useState(0);
  const vacancy = useMemo<VacancyLead | null>(() => {
    if (!selectedVacancy) return null;
    if (pasted && pasted.key === caseKeyFor(selectedVacancy)) {
      return {
        ...selectedVacancy,
        description: pasted.text,
        requirements: null,
        jdOrigin: selectedVacancy.jdOrigin === 'manual' ? 'manual' : 'pasted',
        ...(pasted.requisition ? { jdRequisition: pasted.requisition } : {}),
      };
    }
    return selectedVacancy;
  }, [selectedVacancy, pasted]);
  const handleReplaceJd = useCallback(
    (text: string, requisition: string) => {
      if (selectedVacancy) setPasted({ key: caseKeyFor(selectedVacancy), text, requisition });
    },
    [selectedVacancy],
  );
  const handleJdSaved = useCallback(() => setJdVersion((version) => version + 1), []);

  useEffect(() => {
    let cancelled = false;
    void window.workspace
      .listCvDocuments()
      .then((documents) => {
        if (cancelled) return;
        setLibraryCvs(documents);
        const usable = documents.filter((doc) => doc.text.trim().length > 0);
        const selected = usable.find((doc) => doc.isDefault) ?? usable[0];
        if (selected) {
          setSelectedLibraryCvId(selected.id);
          setCv(cvDocumentFromLibrary(selected));
        }
      })
      .catch((err) => {
        if (!cancelled)
          setLibraryError(err instanceof Error ? err.message : 'could not load your CV library');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveModel = pinnedModel ?? (model || undefined);
  const availableModels = providerStatus?.availableModels ?? [];
  const providerUnavailable = providerStatus && !providerStatus.installed;
  const providerLabel = PROVIDER_LABEL[provider];
  const usableLibraryCvs = libraryCvs.filter((doc) => doc.text.trim().length > 0);
  const unusableLibraryCvs = libraryCvs.length - usableLibraryCvs.length;
  const selectedLibraryCv = usableLibraryCvs.find((doc) => doc.id === selectedLibraryCvId);
  const selectedSourceCv = selectedLibraryCv?.source ?? null;
  const selectedProfile = selectedLibraryCv?.profile ?? null;
  // #419: an approved tailored CV is built from the reviewed structured source. The advisory tools
  // below do not need it, so this explains the gap instead of hiding anything.
  const sourceNotice = !selectedLibraryCv
    ? null
    : !selectedSourceCv
      ? 'This CV has no reviewed structured source yet. The advisory tools below still work. To approve a tailored CV, open this CV in the CV Library, read its source and review it first.'
      : describeCvSourceGaps(selectedSourceCv).length > 0
        ? `This CV's structured source is not ready for approval: ${describeCvSourceGaps(selectedSourceCv).join(', ')}. Review it in the CV Library first.`
        : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">CV assistant</h2>
        <p className="mt-1 text-sm text-base-content/60">
          Runs on your own authenticated {providerLabel} CLI. This app never holds an API key.
        </p>
      </div>

      {providerUnavailable && (
        <div className="alert alert-error text-sm" role="alert">
          {providerLabel} is not installed or not detected, so these features cannot run. Install
          and authenticate the CLI, or choose a different default in AI Runtime, then reopen this
          screen.
        </div>
      )}

      {vacancy && onBackToVacancy && (
        <button type="button" className="btn btn-ghost btn-sm self-start" onClick={onBackToVacancy}>
          Back to {vacancy.title}
        </button>
      )}

      <div className="card card-border rounded-box border-base-300 bg-base-100">
        <div className="card-body gap-3 p-5">
          <div className="card-title text-base font-bold">CV Library</div>
          {libraryError ? (
            <div className="alert alert-error text-sm" role="alert">
              {libraryError}
            </div>
          ) : usableLibraryCvs.length > 0 ? (
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Use saved CV</span>
              <select
                className="select w-full"
                value={selectedLibraryCvId}
                onChange={(event) => {
                  const selected = usableLibraryCvs.find(
                    (doc) => doc.id === event.currentTarget.value,
                  );
                  setSelectedLibraryCvId(event.currentTarget.value);
                  if (selected) setCv(cvDocumentFromLibrary(selected));
                }}
              >
                {usableLibraryCvs.map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    {doc.name}
                    {doc.isDefault ? ' (Default)' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-sm text-base-content/60">
              No saved CV with extracted text is available yet.
            </p>
          )}
          {unusableLibraryCvs > 0 && (
            <p className="text-xs text-base-content/50">
              {unusableLibraryCvs} saved CV {unusableLibraryCvs === 1 ? 'is' : 'are'} unavailable
              because no text was extracted.
            </p>
          )}
        </div>
      </div>

      <CvUpload
        cv={cv}
        onCvChange={(next) => {
          setCv(next);
          if (next) setSelectedLibraryCvId('');
        }}
        providerLabel={providerLabel}
      />

      {/* The upload above stays usable for a single unsaved gap analysis; this is the opt-in
          "keep this one" path into the CV library. Keyed by file name + length so replacing the
          CV resets the button rather than leaving it reading "Saved to library". */}
      {cv && <SaveCvToLibrary key={`${cv.fileName}:${cv.text.length}`} cv={cv} />}

      {vacancy && (
        <div className="rounded-box border border-base-300 p-4 text-sm">
          <div className="font-semibold">{vacancy.title}</div>
          <div className="text-base-content/60">
            {[vacancy.company, vacancy.location].filter((part) => part.trim().length > 0).join(', ')}
          </div>
        </div>
      )}

      {vacancy && sourceNotice && (
        <div className="alert alert-warning text-sm" role="status">
          {sourceNotice}
        </div>
      )}

      {vacancy && (
        <JdReview
          cvId={selectedLibraryCv?.id ?? null}
          vacancy={vacancy}
          sourceCv={selectedSourceCv}
          onReplaceText={handleReplaceJd}
          onSaved={handleJdSaved}
        />
      )}

      {!pinnedModel && availableModels.length > 0 && (
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Model</span>
          <select
            className="select w-full"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">Provider default</option>
            {availableModels.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      )}

      <section className="flex flex-col gap-3" aria-labelledby="cv-only-tools-heading">
        <div>
          <h3 id="cv-only-tools-heading" className="text-base font-semibold">
            CV-only tools
          </h3>
          <p className="mt-1 text-sm text-base-content/60">
            Review and improve the selected CV without a vacancy.
          </p>
        </div>
        <ResumeToolkit
          cv={cv}
          provider={provider}
          {...(effectiveModel ? { model: effectiveModel } : {})}
        />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="vacancy-tools-heading">
        <div>
          <h3 id="vacancy-tools-heading" className="text-base font-semibold">
            Vacancy tools
          </h3>
          <p className="mt-1 text-sm text-base-content/60">
            Compare or draft for the selected vacancy.
          </p>
        </div>
        <GapAnalysis
          cv={cv}
          vacancy={vacancy}
          sourceCv={selectedSourceCv}
          profile={selectedProfile}
          provider={provider}
          {...(effectiveModel ? { model: effectiveModel } : {})}
        />
        <RequirementMapping
          key={`requirements-${jdVersion}`}
          cvId={selectedLibraryCv?.id ?? null}
          cv={cv}
          vacancy={vacancy}
          sourceCv={selectedSourceCv}
          provider={provider}
          {...(effectiveModel ? { model: effectiveModel } : {})}
        />
        <TailoringProposalsPanel
          key={`proposals-${jdVersion}`}
          cvId={selectedLibraryCv?.id ?? null}
          vacancy={vacancy}
          sourceCv={selectedSourceCv}
        />
        <ComposedCvReview
          key={`composed-${jdVersion}`}
          cvId={selectedLibraryCv?.id ?? null}
          vacancy={vacancy}
          sourceCv={selectedSourceCv}
          profile={selectedProfile}
        />
        <TailorCv
          cv={cv}
          vacancy={vacancy}
          sourceCv={selectedSourceCv}
          profile={selectedProfile}
          provider={provider}
          {...(effectiveModel ? { model: effectiveModel } : {})}
        />
        <CoverLetter
          cv={cv}
          vacancy={vacancy}
          sourceCv={selectedSourceCv}
          profile={selectedProfile}
          provider={provider}
          {...(effectiveModel ? { model: effectiveModel } : {})}
        />
      </section>
    </div>
  );
}
