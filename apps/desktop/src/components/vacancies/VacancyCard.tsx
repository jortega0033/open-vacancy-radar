import type { DiscoveryVacancyAudit } from '@open-vacancy-radar/vacancy-engine';
import { decisionBadgeClass, decisionLabel } from './decision-badge.js';

function formatSalary(vacancy: DiscoveryVacancyAudit): string | null {
  if (vacancy.advertisedMinimum == null) return null;
  const currency = vacancy.currency ?? '';
  const period = vacancy.salaryPeriod ? `/${vacancy.salaryPeriod}` : '';
  return `${currency} ${vacancy.advertisedMinimum.toLocaleString()}${period}`.trim();
}

export function VacancyCard({
  vacancy,
  onSelect,
  selected,
}: {
  vacancy: DiscoveryVacancyAudit;
  /** Optional: when provided, renders a "Use for AI" affordance that hands this vacancy up to
   * whoever wants it (e.g. the CV assistant's gap-analysis/cover-letter features). */
  onSelect?: (vacancy: DiscoveryVacancyAudit) => void;
  selected?: boolean;
}) {
  const salary = formatSalary(vacancy);

  return (
    <div className={`card card-border rounded-box border-base-300 bg-base-100${selected ? ' ring-2 ring-base-content' : ''}`}>
      <div className="card-body gap-1 p-4 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="card-title text-base font-bold">{vacancy.title}</div>
          <span className={decisionBadgeClass(vacancy.decision)}>{decisionLabel(vacancy.decision)}</span>
        </div>
        <div className="text-base-content/80">{vacancy.company}</div>
        <div className="text-base-content/60">{vacancy.location}</div>
        {salary && <div className="font-mono text-xs">{salary}</div>}
        <div className="card-actions mt-2">
          <a
            className="btn btn-outline btn-sm"
            href={vacancy.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open vacancy
          </a>
          {onSelect && (
            <button className="btn btn-sm" type="button" onClick={() => onSelect(vacancy)} disabled={selected}>
              {selected ? 'Selected for AI' : 'Use for AI'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
