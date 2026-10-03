import { formatDate, type SearchResult } from './results.js';

function KeyValue({ items }: { items: { k: string; v: string }[] }) {
  return (
    <dl className="ovr-vacancy-verification mt-1 grid grid-cols-1 gap-x-8">
      {items.map((item) => (
        <div
          key={item.k}
          className="flex justify-between gap-3 border-b border-base-300 py-2 text-sm"
        >
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
      <h3 className="ovr-eyebrow">
        {children}
      </h3>
      {aside && <span className="text-xs text-base-content/60">{aside}</span>}
    </div>
  );
}

export interface VerificationSectionProps {
  result: SearchResult;
}

/**
 * "Sources": the official vacancy check for this exact URL. The employer-verification explanation
 * is not repeated here -- the detail pane states it once, in its one-line row or sponsor-match card
 * (see `VacancyDetail.tsx`'s `VerificationRow`, issue #465). Where the same run happened to verify
 * this URL against an official employer/ATS source, that separate (vacancy-level, not
 * employer-level) evidence is shown for what it is.
 */
export function VerificationSection({ result }: VerificationSectionProps) {
  const official = result.official;

  return (
    <section className="mt-6">
      <SectionHeading>Sources</SectionHeading>

      {official ? (
        <details className="rounded-box mt-3 border border-base-300 p-4">
          <summary className="cursor-pointer text-sm font-semibold">How this was checked</summary>
          <div className="mt-3 text-sm text-base-content/70">
            This URL was checked against the employer&apos;s own site.
          </div>
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
        </details>
      ) : (
        <div className="rounded-box mt-3 border border-base-300 p-4">
          <p className="text-sm text-base-content/70">
            Not confirmed on the employer&apos;s own site. Check the posting before you apply.
          </p>
        </div>
      )}
    </section>
  );
}
