import { useEffect, useState } from 'react';
import type { ProviderStatus } from '@agent-dock/shared';
import { CoverLetter } from './CoverLetter.js';
import { CvUpload } from './CvUpload.js';
import { GapAnalysis } from './GapAnalysis.js';
import type { CvDocument, VacancyLead } from './types.js';

/**
 * The one thing the app shell renders: `<CvAssistant vacancy={selectedVacancy} />`.
 *
 * It owns exactly one piece of shared state — the loaded CV — so the two AI features below it read
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
  const [claudeStatus, setClaudeStatus] = useState<ProviderStatus>();

  // Best effort: the model picker is a convenience, so a failed provider listing just hides it
  // rather than blocking the feature (the CLI's own default model is always a valid choice).
  useEffect(() => {
    let cancelled = false;
    window.agentDock
      .listProviders()
      .then((providers) => {
        if (!cancelled) setClaudeStatus(providers.find((p) => p.id === 'claude'));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveModel = pinnedModel ?? (model || undefined);
  const availableModels = claudeStatus?.availableModels ?? [];
  const claudeUnavailable = claudeStatus && !claudeStatus.installed;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">CV assistant</h2>
        <p className="mt-1 text-sm text-base-content/60">
          Runs on your own authenticated Claude Code CLI — this app never holds an API key.
        </p>
      </div>

      {claudeUnavailable && (
        <div className="alert alert-error text-sm" role="alert">
          Claude Code is not installed or not detected, so these features cannot run. Install and
          authenticate the CLI, then reopen this screen.
        </div>
      )}

      <CvUpload cv={cv} onCvChange={setCv} />

      {vacancy && (
        <div className="rounded-box border border-base-300 p-4 text-sm">
          <div className="font-semibold">{vacancy.title}</div>
          <div className="text-base-content/60">
            {vacancy.company} — {vacancy.location}
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

      <GapAnalysis cv={cv} vacancy={vacancy} {...(effectiveModel ? { model: effectiveModel } : {})} />
      <CoverLetter cv={cv} vacancy={vacancy} {...(effectiveModel ? { model: effectiveModel } : {})} />
    </div>
  );
}
