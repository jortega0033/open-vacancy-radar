import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { FileDashed, Info } from '@phosphor-icons/react';
import { discoveryProviderLabel } from '../../discovery-provider-labels.js';
import { SectionHeading, VerificationSection } from './VerificationSection.js';
import { ErrorBanner, Eyebrow } from '../shell/index.js';
import {
  fitHighlights,
  formatDate,
  isStalePosting,
  isWebUrl,
  orNotStated,
  profileFitSpoken,
  type SearchResult,
  type Verification,
  workArrangementOf,
} from './results.js';

/** The one control that opens and closes the CV assistant. Label strings live here only. */
export const ASSISTANT_TOGGLE_LABELS = { open: 'Compare with my CV', close: 'Hide CV assistant' } as const;

export type SaveState = 'idle' | 'saving' | 'saved';
export type PrepareState = 'idle' | 'preparing';

/** `flex h-full flex-col`: the three cards sit in one grid row of uneven content (only "CV match"
 * carries a trailing button), so without a shared height each card's border box would size to its
 * own content and visibly mismatch its neighbors. */
function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col rounded-box border border-base-300 p-3.5">
      <Eyebrow as="h3">{label}</Eyebrow>
      {children}
    </div>
  );
}

/**
 * Employer verification is absent for almost every vacancy, so it gets one line with an info toggle
 * instead of a card. A possible sponsor match is a real outcome and keeps a prominent card. Either
 * way the note appears once in the pane (issue #465). An absent match says nothing about whether the
 * employer sponsors or is verified by another source.
 */
function VerificationRow({ verification }: { verification: Verification }) {
  const [open, setOpen] = useState(false);

  if (verification.level === 'possible_sponsor_match') {
    return (
      <div className="mt-4">
        <Card label="Employer verification">
          <div className="mt-1.5 flex items-center gap-2">
            {verification.tone !== null && (
              <span
                className={`size-2 rounded-full ${verification.tone === 'success' ? 'bg-success' : 'bg-warning'}`}
                aria-hidden="true"
              />
            )}
            <span className="break-words text-sm font-semibold">{verification.label}</span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-base-content/60">{verification.note}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mt-3 text-xs text-base-content/70">
      <div className="flex items-center gap-1">
        <span>Employer verification: none for this vacancy</span>
        <button
          type="button"
          className="btn btn-ghost btn-xs btn-circle"
          aria-label="About employer verification"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <Info size={14} aria-hidden="true" />
        </button>
      </div>
      {open && <p className="mt-1 leading-relaxed text-base-content/60">{verification.note}</p>}
    </div>
  );
}

/**
 * Compact fit block for the top of the detail pane (issue #452): the score with its scale, the
 * three fit dimensions, and at most three matching signals and two gaps. Everything comes from the
 * scorer's own `profileMatch`; fewer signals than three means fewer are shown. The full breakdown
 * stays in "Why this matches you" below.
 */
function FitSummary({ result }: { result: SearchResult }) {
  const score = result.profileScore;
  const { signals, gaps } = fitHighlights(result.profileMatch);

  return (
    <section aria-label="Profile fit summary" className="col-span-full rounded-box border border-base-300 p-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 className="ovr-eyebrow">Profile fit</h3>
        {score === null ? (
          <span className="text-sm font-semibold">Not scored yet</span>
        ) : (
          <>
            <span className="font-mono text-lg font-semibold">
              <span aria-hidden="true">{score}/100</span>
              <span className="sr-only">{profileFitSpoken(score)}</span>
            </span>
            {result.profileMatch && (
              <>
                <span className="badge badge-soft badge-sm">Technical fit {result.profileMatch.technicalFit}</span>
                <span className="badge badge-soft badge-sm">Role fit {result.profileMatch.roleFit}</span>
                <span className="badge badge-soft badge-sm">Seniority fit {result.profileMatch.seniorityFit}</span>
              </>
            )}
          </>
        )}
      </div>
      <p className="mt-1 text-xs text-base-content/60">
        {score === null
          ? 'Not scored yet.'
          : 'Based on what you are looking for.'}
      </p>
      {(signals.length > 0 || gaps.length > 0) && (
        <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 text-sm text-base-content/70 sm:grid-cols-2">
          {signals.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold text-base-content/60">Top matching signals</div>
              <ul className="list-disc pl-5">
                {signals.map((signal, index) => (
                  <li key={`${index}-${signal}`}>{signal}</li>
                ))}
              </ul>
            </div>
          )}
          {gaps.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold text-base-content/60">Top gaps</div>
              <ul className="list-disc pl-5">
                {gaps.map((gap, index) => (
                  <li key={`${index}-${gap}`}>{gap}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const ARRANGEMENT_LABELS = { onsite: 'On-site', hybrid: 'Hybrid', remote: 'Remote' } as const;

/** One overview line for a detected work arrangement, worded as a hint with its evidence. */
function arrangementPairs(result: SearchResult): { k: string; v: string }[] {
  const detection = workArrangementOf(result);
  if (detection.arrangement === 'unknown') return [];
  return [
    {
      k: 'Work setup',
      v: `${ARRANGEMENT_LABELS[detection.arrangement]}, going by the posting${
        detection.evidence ? `: "${detection.evidence}"` : ''
      }`,
    },
  ];
}

function overviewPairs(result: SearchResult): { k: string; v: string }[] {
  const vacancy = result.raw;
  return [
    { k: 'Company', v: result.company },
    { k: 'Location', v: orNotStated(result.location) },
    { k: 'Source', v: discoveryProviderLabel(result.provider) },
    { k: 'Employment type', v: orNotStated(vacancy.employmentType) },
    ...arrangementPairs(result),
    { k: 'Advertised salary', v: result.salary ?? 'Not disclosed' },
    {
      k: 'Posted',
      v: vacancy.postedAt
        ? formatDate(vacancy.postedAt) +
          (isStalePosting(vacancy.postedAt) ? ' (over a month old)' : '')
        : 'Not stated by this source',
    },
  ];
}

export interface VacancyDetailProps {
  result: SearchResult;
  /** Name of the CV marked default in the workspace library, or null when there is none. */
  defaultCvName: string | null;
  saveState: SaveState;
  prepareState: PrepareState;
  /** False for streamed rows that are not in the main process's final trusted report yet. */
  prepareAvailable?: boolean;
  saveError?: string;
  prepareError?: string;
  onSave: () => void;
  onPrepare: () => void;
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
  saveState,
  prepareState,
  prepareAvailable = true,
  saveError,
  prepareError,
  onSave,
  onPrepare,
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
  const assistantRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const openedFrom = useRef<{ key: string; scrollTop: number } | null>(null);
  const previouslyOpen = useRef(assistantOpen);
  // Issue #453: opening the assistant brings its heading into view and focuses it; closing it goes
  // back to the scroll position the pane had before and focuses the opener again. Only reacts to a
  // change of `assistantOpen`, so restoring a pane that already had it open does not steal focus.
  useEffect(() => {
    if (previouslyOpen.current === assistantOpen) return;
    previouslyOpen.current = assistantOpen;
    if (assistantOpen) {
      const heading = assistantRef.current?.querySelector('h2');
      if (!heading) return;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      // Scroll only the details scroller: scrollIntoView would also scroll the app shell (#550).
      const scroller = scrollRef.current;
      if (scroller) {
        const offset =
          heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        scroller.scrollTop += offset;
      }
      return;
    }
    const before = openedFrom.current;
    openedFrom.current = null;
    // A different vacancy was selected: that pane's own scroll restore applies, not this one's.
    if (!before || before.key !== result.key) return;
    if (scrollRef.current) scrollRef.current.scrollTop = before.scrollTop;
    onScrollTopChange?.(before.scrollTop);
    openerRef.current?.focus({ preventScroll: true });
  }, [assistantOpen, result.key, onScrollTopChange]);
  function handleToggleAssistant(): void {
    if (!assistantOpen && scrollRef.current) {
      openedFrom.current = { key: result.key, scrollTop: scrollRef.current.scrollTop };
    }
    onToggleAssistant();
  }
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
            <h2 data-vacancy-heading="" tabIndex={-1} className="break-words text-xl font-semibold outline-none">
              {result.title}
            </h2>
            <div className="mt-0.5 break-words text-sm font-medium text-base-content/80">
              {result.company}
            </div>
            <div className="mt-1 text-xs text-base-content/60">{subtitle}</div>
            {result.provisional && (
              <span className="badge badge-warning badge-soft badge-sm mt-1.5" role="status">
                Live result · not yet scored or verified
              </span>
            )}
          </div>

          <div className="flex max-w-full flex-none flex-wrap gap-2">
            <div className="flex flex-col gap-1">
              <button
                className="btn btn-primary btn-sm whitespace-normal"
                type="button"
                onClick={onPrepare}
                disabled={prepareState === 'preparing' || !prepareAvailable}
              >
                {prepareState === 'preparing' && (
                  <span className="loading loading-spinner loading-xs" aria-hidden="true" />
                )}
                {prepareState === 'preparing'
                  ? 'Starting…'
                  : prepareAvailable
                    ? 'Get ready to apply'
                    : 'Finishing scan…'}
              </button>
              <div className="text-xs text-base-content/60">Builds a draft for you to review. Nothing is sent.</div>
            </div>
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
              ref={openerRef}
              aria-expanded={assistantOpen}
              onClick={handleToggleAssistant}
            >
              {assistantOpen ? ASSISTANT_TOGGLE_LABELS.close : ASSISTANT_TOGGLE_LABELS.open}
            </button>
            {isWebUrl(result.url) ? (
              <a
                className="btn btn-outline btn-sm whitespace-normal"
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open posting
              </a>
            ) : (
              <span className="badge badge-outline badge-sm">Link not available</span>
            )}
          </div>
        </div>

        {saveError && (
          <ErrorBanner className="mt-3">
            {saveError}
          </ErrorBanner>
        )}
        {prepareError && (
          <ErrorBanner className="mt-3">
            {prepareError}
          </ErrorBanner>
        )}

        <VerificationRow verification={result.verification} />

        <div className="ovr-vacancy-summary-grid mt-3 grid grid-cols-1 gap-2.5">
          <FitSummary result={result} />

          <Card label="CV match">
            <div className="mt-1.5 text-sm font-semibold">Not compared to your CV yet</div>
            <p className="mt-1 text-xs leading-relaxed text-base-content/60">
              {ASSISTANT_TOGGLE_LABELS.open} to see how you match. Uses your default CV{defaultCvName ? ` (${defaultCvName})` : ''}.
            </p>
          </Card>

        </div>

        <section className="mt-6" aria-label="Profile score breakdown">
          <SectionHeading
            aside={
              result.profileScore !== null && result.profileMatch
                ? 'Based on what you are looking for only'
                : undefined
            }
          >
            Why this matches you
          </SectionHeading>

          {result.profileScore === null ? (
            <p className="mt-3 text-sm text-base-content/70">
              Not scored yet. Use Compare with my CV for a detailed check.
            </p>
          ) : result.profileMatch ? (
            <div className="mt-3 space-y-4">
              <p className="text-sm text-base-content/70">
                <span className="font-semibold text-base-content">
                  Profile fit: {result.profileScore} out of 100.
                </span>{' '}
                Based on what you are looking for.
              </p>

              {result.profileMatch.matchingSkills.length > 0 && (
                <div>
                  <div className="mb-1.5 text-xs font-semibold text-base-content/60">
                    Matching profile signals
                  </div>
                  <ul className="list-disc pl-5 text-sm text-base-content/70">
                    {result.profileMatch.matchingSkills.map((skill, index) => (
                      <li key={`${index}-${skill}`}>{skill}</li>
                    ))}
                  </ul>
                </div>
              )}

              {result.profileMatch.gaps.length > 0 && (
                <div>
                  <div className="mb-1.5 text-xs font-semibold text-base-content/60">
                    Score gaps and caps
                  </div>
                  <ul className="list-disc pl-5 text-sm text-base-content/70">
                    {result.profileMatch.gaps.map((gap, index) => (
                      <li key={`${index}-${gap}`}>{gap}</li>
                    ))}
                  </ul>
                </div>
              )}

            </div>
          ) : (
            <p className="mt-3 text-sm text-base-content/70" role="status">
              Details not available. Search again to see them.
            </p>
          )}

        </section>

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

        <VerificationSection result={result} />

        {assistantOpen && (
          <section ref={assistantRef} className="mt-6 border-t border-base-300 pt-5">
            {assistant}
          </section>
        )}
      </div>
    </div>
  );
}
