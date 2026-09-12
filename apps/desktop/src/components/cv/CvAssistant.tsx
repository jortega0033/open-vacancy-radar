import { useEffect, useState } from 'react';
import type { ProviderId, ProviderStatus } from '@agent-dock/shared';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import type { CvDocumentRecord } from '../../window.js';
import { CoverLetter } from './CoverLetter.js';
import { CvUpload } from './CvUpload.js';
import { GapAnalysis } from './GapAnalysis.js';
import { SaveCvToLibrary } from './SaveCvToLibrary.js';
import { ResumeToolkit } from './ResumeToolkit.js';
import { TailorCv } from './TailorCv.js';
import type { CvDocument, VacancyLead } from './types.js';

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

export function CvAssistant({ vacancy, model: pinnedModel, onBackToVacancy }: CvAssistantProps) {
  const [cv, setCv] = useState<CvDocument | null>(null);
  const [libraryCvs, setLibraryCvs] = useState<CvDocumentRecord[]>([]);
  const [selectedLibraryCvId, setSelectedLibraryCvId] = useState('');
  const [libraryError, setLibraryError] = useState<string>();
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState<ProviderId>('claude');
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>();

  // The default provider is a settings preference (set from the AI Runtime page); a failure here
  // just leaves the Claude Code default in place rather than blocking the feature.
  useEffect(() => {
    let cancelled = false;
    void window.workspace
      .getSettings()
      .then((settings) => {
        if (!cancelled) setProvider(settings.defaultProvider);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Best effort: the model picker is a convenience, so a failed provider listing just hides it
  // rather than blocking the feature (the CLI's own default model is always a valid choice).
  useEffect(() => {
    let cancelled = false;
    window.agentDock
      .listProviders()
      .then((providers) => {
        if (!cancelled) setProviderStatus(providers.find((p) => p.id === provider));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [provider]);

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
            {vacancy.company}, {vacancy.location}
          </div>
        </div>
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
