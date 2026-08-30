import { useEffect, useState } from 'react';
import type { ProviderId, ProviderStatus } from '@agent-dock/shared';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { CoverLetter } from './CoverLetter.js';
import { CvUpload } from './CvUpload.js';
import { GapAnalysis } from './GapAnalysis.js';
import { SaveCvToLibrary } from './SaveCvToLibrary.js';
import type { CvDocument, VacancyLead } from './types.js';

/**
 * The one thing the app shell renders: `<CvAssistant vacancy={selectedVacancy} />`.
 *
 * It owns exactly one piece of shared state (the loaded CV) so the two AI features below it read
 * the same document without the user uploading it twice. Everything else (session lifecycle,
 * streaming, errors) belongs to the individual feature components.
 */
export interface CvAssistantProps {
  /** The vacancy both features work against; null until the Vacancy Leads screen selects one. */
  vacancy: VacancyLead | null;
  /** Optional: skip the model picker and pin a model. */
  model?: string;
}

export function CvAssistant({ vacancy, model: pinnedModel }: CvAssistantProps) {
  const [cv, setCv] = useState<CvDocument | null>(null);
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

  const effectiveModel = pinnedModel ?? (model || undefined);
  const availableModels = providerStatus?.availableModels ?? [];
  const providerUnavailable = providerStatus && !providerStatus.installed;
  const providerLabel = PROVIDER_LABEL[provider];

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

      <CvUpload cv={cv} onCvChange={setCv} />

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
          <select className="select w-full" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Provider default</option>
            {availableModels.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      )}

      <GapAnalysis
        cv={cv}
        vacancy={vacancy}
        provider={provider}
        {...(effectiveModel ? { model: effectiveModel } : {})}
      />
      <CoverLetter
        cv={cv}
        vacancy={vacancy}
        provider={provider}
        {...(effectiveModel ? { model: effectiveModel } : {})}
      />
    </div>
  );
}
