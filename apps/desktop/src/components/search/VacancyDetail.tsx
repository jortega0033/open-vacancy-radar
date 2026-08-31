import type { ReactNode } from 'react';
import { Check, Warning } from '@phosphor-icons/react';
import type { JobRadarReport } from '@open-vacancy-radar/vacancy-engine';
import { SectionHeading, VerificationSection } from './VerificationSection.js';
import { formatDate, isWebUrl, orNotStated, type SearchResult } from './results.js';

export type SaveState = 'idle' | 'saving' | 'saved';

/** `flex h-full flex-col`: the three cards sit in one grid row of uneven content (only "CV match"
 * carries a trailing button), so without a shared height each card's border box would size to its
 * own content and visibly mismatch its neighbors. */
function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col rounded-box border border-base-300 p-3.5">
      <div className="text-xs font-semibold tracking-wide text-base-content/60 uppercase">{label}</div>
      {children}
    </div>
  );
}

function overviewPairs(result: SearchResult): { k: string; v: string }[] {
  const shared = [
    { k: 'Company', v: result.company },
    { k: 'Location', v: orNotStated(result.location) },
    { k: 'Source', v: result.provider },
  ];

  if (result.market === 'netherlands') {
    const vacancy = result.raw;
    return [
      ...shared,
      { k: 'Arrangement', v: result.arrangement ?? 'Not stated' },
      { k: 'Employment type', v: 'Not recorded by this pipeline' },
      { k: 'Salary', v: 'Not published in the Netherlands report' },
      { k: 'Posted', v: formatDate(vacancy.postedAt) },
      { k: 'First seen', v: formatDate(vacancy.firstSeenAt) },
      { k: 'Last seen', v: formatDate(vacancy.lastSeenAt) },
      // Absent, not a fake number, when the candidate profile wasn't configured for this scan.
      { k: 'Primary fit', v: vacancy.primaryFit ?? 'Not scored: search profile not configured' },
      {
        k: 'Profile score',
        v: vacancy.score === undefined ? 'Not scored' : `${vacancy.score} / 100`,
      },
      {
        k: 'Fit breakdown',
        v: vacancy.score === undefined
          ? 'Not scored: search profile not configured'
          : `technical ${vacancy.technicalFit} · role ${vacancy.roleFit} · seniority ${vacancy.seniorityFit} · language ${vacancy.languageFit} · location ${vacancy.locationFit}`,
      },
    ];
  }

  const vacancy = result.raw;
  return [
    ...shared,
    { k: 'Arrangement', v: 'Not recorded by this pipeline' },
    { k: 'Employment type', v: orNotStated(vacancy.employmentType) },
    { k: 'Advertised salary', v: result.salary ?? 'Not disclosed' },
    {
      k: 'Annualised minimum (USD)',
      v: vacancy.annualizedMinimumUsd == null ? 'Not derivable' : vacancy.annualizedMinimumUsd.toLocaleString(),
    },
    { k: 'Posted', v: 'Not recorded by this pipeline' },
    { k: 'Discovery decision', v: vacancy.decision.replace(/_/g, ' ') },
  ];
}

export interface VacancyDetailProps {
  result: SearchResult;
  /** Netherlands report provenance, or null when the worldwide market is selected. */
  sponsorSource: JobRadarReport['officialSponsorSource'] | null;
  runId: string | null;
  /** Name of the CV marked default in the workspace library, or null when there is none. */
  defaultCvName: string | null;
  saveState: SaveState;
  saveError?: string;
  onSave: () => void;
  assistantOpen: boolean;
  onToggleAssistant: () => void;
  /** The CV assistant, rendered by the page so this component stays presentational. */
  assistant: ReactNode;
}

/**
 * The right-hand detail pane. Every claim it makes is traceable to a field one of the two report
 * shapes actually carries; where a field does not exist for the selected market it says
 * "Not recorded by this pipeline" rather than leaving a blank the reader will fill in themselves.
 *
 * Notably there is no "CV match %". Neither report compares a vacancy to a CV: the Netherlands
 * report's `score` is deterministic relevance against the engine's *configured candidate profile*,
 * and the worldwide report has no score at all. The only real CV comparison in this app is the
 * on-demand AI gap analysis, so that is what the CV card offers.
 */
export function VacancyDetail({
  result,
  sponsorSource,
  runId,
  defaultCvName,
  saveState,
  saveError,
  onSave,
  assistantOpen,
  onToggleAssistant,
  assistant,
}: VacancyDetailProps) {
  const subtitle = [orNotStated(result.location), result.arrangement, result.salary]
    .filter((part): part is string => !!part)
    .join(' · ');

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="max-w-3xl px-6 py-5 pb-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold">{result.title}</h2>
            <div className="mt-0.5 text-sm font-medium text-base-content/80">{result.company}</div>
            <div className="mt-1 text-xs text-base-content/60">{subtitle}</div>
          </div>

          <div className="flex flex-none flex-wrap gap-2">
            <button
              className="btn btn-outline btn-sm"
              type="button"
              onClick={onSave}
              disabled={saveState !== 'idle'}
            >
              {saveState === 'saving' && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
              {saveState === 'saved' ? 'Saved' : 'Save job'}
            </button>
            <button className="btn btn-primary btn-sm" type="button" onClick={onToggleAssistant}>
              {assistantOpen ? 'Hide AI assistant' : 'Use for AI'}
            </button>
            {isWebUrl(result.url) ? (
              <a className="btn btn-outline btn-sm" href={result.url} target="_blank" rel="noopener noreferrer">
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

        <div className="mt-4 grid grid-cols-1 gap-2.5 md:grid-cols-3">
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
              <span className="text-sm font-semibold">{result.verification.label}</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-base-content/60">{result.verification.note}</p>
          </Card>

          <Card label="CV match">
            <div className="mt-1.5 text-sm font-semibold">Manual review</div>
            <p className="mt-1 text-xs leading-relaxed text-base-content/60">
              No score here compares this vacancy to your CV. Run the gap analysis to compare it
              against {defaultCvName ? `your default CV (${defaultCvName})` : 'a CV you load'} using
              your own Claude Code CLI.
            </p>
            <button className="btn btn-outline btn-xs mt-auto self-start" type="button" onClick={onToggleAssistant}>
              Analyse against my CV
            </button>
          </Card>

          {result.market === 'netherlands' ? (
            <Card label="Dutch language requirement">
              <div className="mt-1.5 text-sm font-semibold">
                {result.raw.dutchRequired === undefined
                  ? 'Not evaluated: search profile not configured'
                  : result.raw.dutchRequired
                    ? 'Dutch required'
                    : result.raw.dutchPreferred
                      ? 'Dutch preferred'
                      : 'No Dutch requirement detected'}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-base-content/60">
                Detected from the posting text. This app does not assess work-permit eligibility and
                gives no immigration advice.
              </p>
            </Card>
          ) : (
            <Card label="Vacancy source">
              <div className="mt-1.5 text-sm font-semibold">{result.provider}</div>
              <p className="mt-1 text-xs leading-relaxed text-base-content/60">
                Discovery feed. This pipeline records no posting date, so freshness must be checked
                on the vacancy itself.
              </p>
            </Card>
          )}
        </div>

        <section className="mt-6">
          <SectionHeading>Overview</SectionHeading>
          <dl className="mt-1 grid grid-cols-1 gap-x-8 md:grid-cols-2">
            {overviewPairs(result).map((pair) => (
              <div key={pair.k} className="flex justify-between gap-3 border-b border-base-300 py-2 text-sm">
                <dt className="flex-none text-base-content/60">{pair.k}</dt>
                <dd className="text-right font-medium">{pair.v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mt-6">
          <SectionHeading
            aside={
              result.market === 'netherlands'
                ? 'Deterministic engine scoring, against the configured candidate profile'
                : 'No deterministic scoring in this pipeline'
            }
          >
            Why this matches you
          </SectionHeading>

          {result.market === 'netherlands' ? (
            <div className="mt-3 grid grid-cols-1 gap-5 md:grid-cols-2">
              <div>
                <div className="mb-2 text-xs font-semibold text-success">Strong matches</div>
                {result.strongPoints.length === 0 ? (
                  <p className="text-sm text-base-content/60">None identified.</p>
                ) : (
                  result.strongPoints.map((item) => (
                    <div key={item} className="flex gap-2 py-0.5 text-sm">
                      <Check className="flex-none text-success" size={16} aria-hidden="true" />
                      {item}
                    </div>
                  ))
                )}
              </div>
              <div>
                <div className="mb-2 text-xs font-semibold text-warning">Potential gaps</div>
                {result.gaps.length === 0 ? (
                  <p className="text-sm text-base-content/60">None identified.</p>
                ) : (
                  result.gaps.map((item) => (
                    <div key={item} className="flex gap-2 py-0.5 text-sm">
                      <Warning className="flex-none text-warning" size={16} aria-hidden="true" />
                      {item}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-base-content/70">
              The worldwide pipeline does not score a vacancy against a candidate profile. Use the
              AI gap analysis for a real comparison against your CV.
            </p>
          )}

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

        <section className="mt-6">
          <SectionHeading>Job description</SectionHeading>
          <p className="mt-3 text-sm leading-relaxed text-base-content/70">
            Neither scan pipeline stores the posting text, so there is no description to show here.
            Open the vacancy at its source to read it in full.
          </p>
        </section>

        <VerificationSection result={result} sponsorSource={sponsorSource} runId={runId} />

        {assistantOpen && (
          <section className="mt-6 border-t border-base-300 pt-5">{assistant}</section>
        )}
      </div>
    </div>
  );
}
