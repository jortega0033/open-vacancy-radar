import { useState } from 'react';
import type { JobRadarReport } from '@open-vacancy-radar/vacancy-engine';
import { formatDate, marketLabel, type SearchResult } from './results.js';

function KeyValue({ items }: { items: { k: string; v: string }[] }) {
  return (
    <dl className="mt-1 grid grid-cols-1 gap-x-8 md:grid-cols-2">
      {items.map((item) => (
        <div key={item.k} className="flex justify-between gap-3 border-b border-base-300 py-2 text-sm">
          <dt className="flex-none text-base-content/60">{item.k}</dt>
          <dd className="text-right font-medium">{item.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SectionHeading({ children, aside }: { children: string; aside?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-base-300 pb-2">
      <h3 className="text-xs font-semibold tracking-wide text-base-content/70 uppercase">{children}</h3>
      {aside && <span className="text-xs text-base-content/50">{aside}</span>}
    </div>
  );
}

export interface VerificationSectionProps {
  result: SearchResult;
  /** The Netherlands report's official register provenance; absent for the worldwide market. */
  sponsorSource: JobRadarReport['officialSponsorSource'] | null;
  /** The Netherlands report's run id, quoted in the details panel as the evidence's provenance. */
  runId: string | null;
}

/**
 * "Employer verification & sources", branched on the market's *real* capability.
 *
 * Netherlands: the pipeline resolves an employer to an IND recognised-sponsor legal entity, so
 * there is a genuine result to show — including which entity, at what mapping confidence, and
 * whether this vacancy was re-verified in the run that produced the report.
 *
 * Worldwide: the pipeline has no employer-verification step whatsoever. The panel says that
 * plainly instead of borrowing the Netherlands vocabulary; there is no "possible match" or "not
 * found" to report, because nothing was looked up. Where the same run happened to verify this
 * exact URL against an official employer/ATS source, that separate (vacancy-level, not
 * employer-level) evidence is shown for what it is.
 */
export function VerificationSection({ result, sponsorSource, runId }: VerificationSectionProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (result.market === 'netherlands') {
    const vacancy = result.raw;
    const pairs = [
      { k: 'IND sponsor legal entity', v: vacancy.sponsorLegalNames.join(', ') || 'Not resolved' },
      { k: 'Mapping confidence', v: vacancy.mappingConfidence },
      { k: 'Re-verified in this run', v: vacancy.verifiedInRun ? 'Yes' : 'No' },
      {
        k: 'Source outcome',
        v: vacancy.sourceOutcomeStatus ? vacancy.sourceOutcomeStatus.replace(/_/g, ' ') : 'Not recorded',
      },
    ];

    const detailPairs = [
      { k: 'Register', v: sponsorSource?.url ?? 'Not recorded in this report' },
      { k: 'Register last updated', v: formatDate(sponsorSource?.lastUpdated ?? null) },
      { k: 'Register retrieved', v: formatDate(sponsorSource?.retrievedAt ?? null) },
      { k: 'Scan run', v: runId ?? 'Unknown' },
      { k: 'First seen', v: formatDate(vacancy.firstSeenAt) },
      { k: 'Last seen', v: formatDate(vacancy.lastSeenAt) },
      { k: 'Language evidence', v: vacancy.languageEvidence.join('; ') || 'None captured' },
    ];

    return (
      <section className="mt-6">
        <SectionHeading>Employer verification &amp; sources</SectionHeading>
        <KeyValue items={pairs} />

        <button
          className="btn btn-outline btn-xs mt-3"
          type="button"
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
        >
          {detailsOpen ? 'Hide verification details' : 'Show verification details'}
        </button>

        {detailsOpen && (
          <div className="rounded-box mt-3 border border-base-300 bg-base-200 p-4">
            <h4 className="mb-2.5 text-xs font-semibold tracking-wide text-base-content/60 uppercase">
              Verification details
            </h4>
            <dl className="text-sm">
              {detailPairs.map((pair) => (
                <div key={pair.k} className="flex flex-wrap gap-x-3 gap-y-0.5 py-0.5">
                  <dt className="w-40 flex-none text-base-content/60">{pair.k}</dt>
                  <dd className="min-w-0 flex-1 break-words">{pair.v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2.5 text-xs leading-relaxed text-base-content/60">
              A vacancy&apos;s trading name can differ from the registered legal entity, so anything
              below a high-confidence mapping needs manual review before you rely on sponsorship.
              Recognition applies to the employer, never to a specific vacancy or to the terms it
              offers.
            </p>
          </div>
        )}
      </section>
    );
  }

  const official = result.official;

  return (
    <section className="mt-6">
      <SectionHeading>Employer verification &amp; sources</SectionHeading>

      <div className="rounded-box mt-3 border border-base-300 bg-base-200 p-4">
        <div className="text-sm font-semibold">
          Employer verification is not available for {marketLabel(result.market)}.
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-base-content/70">
          {result.verification.note} You can still compare this vacancy against your CV, save it,
          generate a letter and track an application. Discovery source: {result.provider}. Discovery
          decision: {result.raw.decision.replace(/_/g, ' ')}.
        </p>
      </div>

      <div className="rounded-box mt-3 border border-base-300 p-4">
        <div className="text-sm font-semibold">Official vacancy check</div>
        {official ? (
          <>
            <p className="mt-1.5 text-sm text-base-content/70">
              This exact URL was also fetched from an official employer/ATS source in this run —
              a check on the <em>vacancy</em>, not on the employer.
            </p>
            <KeyValue
              items={[
                { k: 'Official source state', v: official.state },
                { k: 'Decision', v: official.decision.replace(/_/g, ' ') },
                { k: 'Provider', v: official.provider },
                { k: 'Reviewed', v: formatDate(official.reviewedAt) },
              ]}
            />
            {official.evidence.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-sm text-base-content/70">
                {official.evidence.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="mt-1.5 text-sm text-base-content/70">
            This lead was not fetched from an official employer or ATS source in this run, so it is
            a discovery lead only. Open the vacancy and confirm it on the employer&apos;s own site
            before acting on it.
          </p>
        )}
      </div>
    </section>
  );
}
