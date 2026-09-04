import { formatDate, type SearchResult } from './results.js';

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
}

/**
 * "Employer verification & sources". The pipeline has no employer-verification step for almost
 * every row, and this panel says so plainly. The one exception is a Netherlands-located row where
 * `worldwideVerification` found a best-effort Wikidata sponsor match (see `results.ts`) -- that
 * row's own `result.verification.label`/`.note` already say so honestly (and far more tentatively
 * than a curated match would), so they are shown as-is instead of the fixed "not available" copy.
 * Where the same run happened to verify this exact URL against an official employer/ATS source,
 * that separate (vacancy-level, not employer-level) evidence is shown for what it is, regardless of
 * the sponsor-match outcome.
 */
export function VerificationSection({ result }: VerificationSectionProps) {
  const official = result.official;

  return (
    <section className="mt-6">
      <SectionHeading>Employer verification &amp; sources</SectionHeading>

      <div className="rounded-box mt-3 border border-base-300 bg-base-200 p-4">
        <div className="text-sm font-semibold">
          {result.verification.level === 'possible_sponsor_match'
            ? 'A best-effort sponsor match was found -- see the summary card above.'
            : 'Employer verification is not available for this vacancy.'}
        </div>
        {/* Neither branch repeats `result.verification.note` here: the summary card above
            (VacancyDetail.tsx's "Employer verification" Card) already shows the label and note
            unconditionally, for every level, so doing it again here would duplicate it verbatim. */}
        <p className="mt-1.5 text-sm leading-relaxed text-base-content/70">
          You can still compare this vacancy against your CV, save it, generate a letter and track
          an application. Discovery source: {result.provider}. Discovery decision:{' '}
          {result.raw.decision.replace(/_/g, ' ')}.
        </p>
      </div>

      <div className="rounded-box mt-3 border border-base-300 p-4">
        <div className="text-sm font-semibold">Official vacancy check</div>
        {official ? (
          <>
            <p className="mt-1.5 text-sm text-base-content/70">
              This exact URL was also fetched from an official employer/ATS source in this run:
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
