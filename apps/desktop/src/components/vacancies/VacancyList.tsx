import type { DiscoveryVacancyAudit } from '@open-vacancy-radar/vacancy-engine';
import noResultsIllustration from '../../../assets/illustrations/no-results.svg?no-inline';
import { EmptyState } from '../shell/index.js';
import { VacancyCard } from './VacancyCard.js';

export function VacancyList({
  vacancies,
  hasUnfilteredResults,
  onSelect,
  selectedKey,
}: {
  vacancies: DiscoveryVacancyAudit[];
  /** Whether the unfiltered report had any vacancies at all — distinguishes "no matches for your
   * search" from a report that was genuinely empty. */
  hasUnfilteredResults: boolean;
  onSelect?: (vacancy: DiscoveryVacancyAudit) => void;
  selectedKey?: string;
}) {
  if (vacancies.length === 0) {
    return (
      <div className="mt-3">
        <EmptyState
          illustration={noResultsIllustration}
          title={hasUnfilteredResults ? 'No vacancies match that search' : 'No vacancies in the latest scan'}
          description={
            hasUnfilteredResults
              ? 'Try a different role or broader keywords.'
              : 'The completed scan did not return any vacancies.'
          }
        />
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      {vacancies.map((vacancy) => (
        <VacancyCard key={vacancy.key} vacancy={vacancy} onSelect={onSelect} selected={vacancy.key === selectedKey} />
      ))}
    </div>
  );
}
