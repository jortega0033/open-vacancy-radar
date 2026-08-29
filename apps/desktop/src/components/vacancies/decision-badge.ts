import type { DiscoveryVacancyAudit } from '@open-vacancy-radar/vacancy-engine';

type Decision = DiscoveryVacancyAudit['decision'];

/**
 * Monochrome decision styling: state is conveyed via contrast/weight/borders/opacity, never hue
 * (see DESIGN-TOKENS.md and App.tsx's RUN_STATUS_BADGE_CLASS for the pattern this mirrors).
 * `official_review_candidate` is the one decision worth promoting — solid fill. The rest are
 * various shades of "did not qualify," ordered roughly by how close they came.
 */
export const DECISION_BADGE_CLASS: Record<Decision, string> = {
  official_review_candidate: 'badge badge-neutral font-mono align-middle',
  salary_unverified: 'badge badge-outline font-mono align-middle',
  salary_below_threshold: 'badge badge-outline border-2 font-mono font-bold align-middle',
  location_restricted: 'badge badge-ghost font-mono align-middle opacity-60',
  role_mismatch: 'badge badge-ghost font-mono align-middle opacity-60',
  non_vacancy: 'badge badge-ghost font-mono align-middle opacity-40',
};

export function decisionBadgeClass(decision: Decision): string {
  return DECISION_BADGE_CLASS[decision] ?? 'badge badge-ghost font-mono align-middle';
}

export function decisionLabel(decision: Decision): string {
  return decision.replace(/_/g, ' ');
}
