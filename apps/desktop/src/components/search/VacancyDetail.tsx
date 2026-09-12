import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { FileDashed } from '@phosphor-icons/react';
import { discoveryProviderLabel } from '../../discovery-provider-labels.js';
import { SectionHeading, VerificationSection } from './VerificationSection.js';
import { formatDate, isStalePosting, isWebUrl, orNotStated, type SearchResult } from './results.js';

export type SaveState = 'idle' | 'saving' | 'saved';
export type PrepareState = 'idle' | 'preparing';

/** `flex h-full flex-col`: the three cards sit in one grid row of uneven content (only "CV match"
 * carries a trailing button), so without a shared height each card's border box would size to its
 * own content and visibly mismatch its neighbors. */
function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col rounded-box border border-base-300 p-3.5">
      <div className="text-xs font-semibold tracking-wide text-base-content/60 uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

function overviewPairs(result: SearchResult): { k: string; v: string }[] {
  const vacancy = result.raw;
  return [
    { k: 'Company', v: result.company },
    { k: 'Location', v: orNotStated(result.location) },
    { k: 'Source', v: discoveryProviderLabel(result.provider) },
    {
      k: 'Salary source',
      v:
        vacancy.salaryProvider === null || vacancy.salaryProvider === undefined
          ? 'Not recorded'
          : `${discoveryProviderLabel(vacancy.salaryProvider)}${vacancy.salarySourceKey ? ` (${vacancy.salarySourceKey})` : ''}`,
    },
    { k: 'Employment type', v: orNotStated(vacancy.employmentType) },
    { k: 'Advertised salary', v: result.salary ?? 'Not disclosed' },
    {
      k: 'Annualised minimum (USD)',
      v:
        vacancy.annualizedMinimumUsd == null
          ? 'Not derivable'
          : vacancy.annualizedMinimumUsd.toLocaleString(),
    },
    {
      k: 'Comparable annual minimum',
      v:
        vacancy.normalizedAnnualMinimum == null || vacancy.normalizedCurrency == null
          ? 'Not comparable'
          : `${vacancy.normalizedCurrency} ${vacancy.normalizedAnnualMinimum.toLocaleString()}`,
    },
    { k: 'Normalization', v: vacancy.normalizationMethod?.replace(/_/g, ' ') ?? 'Not recorded' },
    {
      k: 'Posted',
      v: vacancy.postedAt
        ? formatDate(vacancy.postedAt) +
          (isStalePosting(vacancy.postedAt) ? ' (over a month old)' : '')
        : 'Not stated by this source',
    },
    { k: 'Discovery decision', v: vacancy.decision.replace(/_/g, ' ') },
  ];
}

export interface VacancyDetailProps {
  result: SearchResult;
  /** Name of the CV marked default in the workspace library, or null when there is none. */
  defaultCvName: string | null;
  /** Display name of the CLI the gap analysis actually runs through, e.g. "Claude Code" or "Codex"
   * (see `PROVIDER_LABEL`): reflects the user's configured default provider, not a fixed one. */
  providerLabel: string;
  saveState: SaveState;
  prepareState: PrepareState;
  /** False for streamed rows that are not in the main process's final trusted report yet. */
  prepareAvailable?: boolean;
  saveError?: string;
  prepareError?: string;
  onSave: () => void;
  onPrepare: () => void;
  /** Builds a `SelectedVacancy` from this vacancy and hands it off to the Letters page. */
  onGenerateLetter: () => void;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
  scrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
  /** The CV assistant, rendered by the page so this component stays presentational. */
  assistant: ReactNode;
}

/**
 * The right-hand detail pane. Every claim it makes is traceable to a field the report actually
 * carries; a field the pipeline never records says "Not derivable"/"Not stated" rather than leaving
 * a blank the reader will fill in themselves.
 *
 * Notably there is no "CV match %". The engine's score is deterministic relevance against the
 * *configured candidate profile*, never against a CV. The only real CV comparison in this app is the
 * on-demand AI gap analysis, so that is what the CV card offers.
 */
export function VacancyDetail({
  result,
  defaultCvName,
  providerLabel,
  saveState,
  prepareState,
  prepareAvailable = true,
  saveError,
  prepareError,
  onSave,
  onPrepare,
  onGenerateLetter,
  assistantOpen,
  onToggleAssistant,
  scrollTop = 0,
  onScrollTopChange,
  assistant,
}: VacancyDetailProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollRef.current && scrollRef.current.scrollTop !== scrollTop)
      scrollRef.current.scrollTop = scrollTop;
  }, [scrollTop]);
  const subtitle = [orNotStated(result.location), result.salary]
    .filter((part): part is string => !!part)
    .join(' · ');

  return (
    <div
      ref={scrollRef}
      aria-label="Vacancy details"
      className="ovr-vacancy-details min-w-0 flex-1 overflow-y-auto"
      onScroll={(event) => onScrollTopChange?.(event.currentTarget.scrollTop)}
    >
      <div className="max-w-3xl px-6 py-5 pb-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="break-words text-xl font-semibold">{result.title}</h2>
            <div className="mt-0.5 break-words text-sm font-medium text-base-content/80">
              {result.company}
            </div>
            <div className="mt-1 text-xs text-base-content/60">{subtitle}</div>
          </div>

          <div className="flex max-w-full flex-none flex-wrap gap-2">
            <button
              className="btn btn-primary btn-sm whitespace-normal"
              type="button"
              onClick={onPrepare}
              disabled={prepareState === 'preparing' || !prepareAvailable}
              title={prepareAvailable ? undefined : 'Available when this scan finishes'}
            >
              {prepareState === 'preparing' && (
                <span className="loading loading-spinner loading-xs" aria-hidden="true" />
              )}
              {prepareState === 'preparing'
                ? 'Preparing…'
                : prepareAvailable
                  ? 'Prepare application'
                  : 'Finishing scan…'}
            </button>
            <button
              className="btn btn-outline btn-sm whitespace-normal"
              type="button"
              onClick={onSave}
              disabled={saveState !== 'idle'}
            >
              {saveState === 'saving' && (
                <span
                  className="loading loading-spinner loading-xs text-base-content"
                  aria-hidden="true"
                />
              )}
              {saveState === 'saved' ? 'Saved' : 'Save job'}
            </button>
            <button
              className="btn btn-outline btn-sm whitespace-normal"
              type="button"
              onClick={onGenerateLetter}
            >
              Generate Letter
            </button>
            <button
              className="btn btn-outline btn-sm whitespace-normal"
              type="button"
              onClick={onToggleAssistant}
            >
              {assistantOpen ? 'Hide AI assistant' : 'Use for AI'}
            </button>
            {isWebUrl(result.url) ? (
              <a
                className="btn btn-outline btn-sm whitespace-normal"
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open job
              </a>
            ) : (
              <span className="badge badge-outline badge-sm">Link withheld: unsafe URL</span>
            )}
          </div>
        </div>

        {saveError && (
          <div className="alert alert-error alert-soft mt-3 text-sm" role="alert">
            {saveError}
          </div>
        )}
        {prepareError && (
          <div className="alert alert-error alert-soft mt-3 text-sm" role="alert">
            {prepareError}
          </div>
        )}

        <div className="ovr-vacancy-summary-grid mt-4 grid grid-cols-1 gap-2.5">
          <Card label="Employer verification">
            <div className="mt-1.5 flex items-center gap-2">
              {result.verification.tone !== null && (
                <span
                  className={`size-2 rounded-full ${
                    result.verification.tone === 'success' ? 'bg-success' : 'bg-warning'
                  }`}
                  aria-hidden="true"
                />
              )}
              <span className="break-words text-sm font-semibold">{result.verification.label}</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-base-content/60">
              {result.verification.note}
            </p>
          </Card>

          <Card label="CV match">
            <div className="mt-1.5 text-sm font-semibold">Manual review</div>
            <p className="mt-1 text-xs leading-relaxed text-base-content/60">
              No score here compares this vacancy to your CV. Run the gap analysis to compare it
              against {defaultCvName ? `your default CV (${defaultCvName})` : 'a CV you load'} using
              your own {providerLabel} CLI.
            </p>
            <button
              className="btn btn-outline btn-xs mt-auto self-start"
              type="button"
              onClick={onToggleAssistant}
            >
              Analyse against my CV
            </button>
          </Card>

          <Card label="Vacancy source">
            <div className="mt-1.5 break-words text-sm font-semibold">
              {discoveryProviderLabel(result.provider)}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-base-content/60">
              Discovery feed. Most sources here do not report a posting date, so check freshness on
              the vacancy itself when the date above is unknown.
            </p>
          </Card>
        </div>

        <section className="mt-6">
          <SectionHeading>Job description</SectionHeading>
          {result.description ? (
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-base-content/70">
              {result.description}
            </p>
          ) : (
            <div className="mt-3 flex flex-col items-center gap-2 rounded-box border border-dashed border-base-300 py-8 text-center">
              <FileDashed size={28} className="text-base-content/30" aria-hidden="true" />
              <p className="text-sm text-base-content/60">
                {discoveryProviderLabel(result.provider)} did not include description text for this
                vacancy.
              </p>
              {isWebUrl(result.url) && (
                <a
                  className="link link-primary text-sm"
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Read the full posting at the source
                </a>
              )}
            </div>
          )}
        </section>

        <section className="mt-6">
          <SectionHeading>Overview</SectionHeading>
          <dl className="ovr-vacancy-overview mt-1 grid grid-cols-1 gap-x-8">
            {overviewPairs(result).map((pair) => (
              <div
                key={pair.k}
                className="flex justify-between gap-3 border-b border-base-300 py-2 text-sm"
              >
                <dt className="flex-none text-base-content/60">{pair.k}</dt>
                <dd className="min-w-0 break-words text-right font-medium">{pair.v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mt-6">
          <SectionHeading aside="No strong-match / gap breakdown in this pipeline">
            Why this matches you
          </SectionHeading>

          <p className="mt-3 text-sm text-base-content/70">
            The worldwide pipeline scores a single overall match percentage against your search
            profile (shown in the results list), but does not break it down into individual strong
            matches or gaps. Use the AI gap analysis for a real, detailed comparison against your
            CV.
          </p>

          {result.reasons.length > 0 && (
            <div className="mt-4">
              <div className="mb-1.5 text-xs font-semibold text-base-content/60">
                Why this row is in the report
              </div>
              <ul className="list-disc pl-5 text-sm text-base-content/70">
                {result.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <VerificationSection result={result} />

        {assistantOpen && (
          <section className="mt-6 border-t border-base-300 pt-5">{assistant}</section>
        )}
      </div>
    </div>
  );
}
