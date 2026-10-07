import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { rankingText } from './profile-summary.js';

export interface RankingSummaryProps {
  /** Null until the profile has loaded (or when it could not be read): nothing is shown then. */
  profile: CandidateProfile | null;
  /** Opens the edit form. The caller owns the dialog, so other prompts on the page can open it too. */
  onEdit: () => void;
}

/**
 * One thin line for Search, shown over ranked results: "Ranking for: <roles>, <country>. Edit".
 * Edit opens the same form as the CV page. With nothing set it renders nothing: the empty Search
 * page already has one role flow, and the CV page card asks the single question.
 */
export function RankingSummary({ profile, onEdit }: RankingSummaryProps) {
  if (!profile) return null;

  const text = rankingText(profile);
  if (!text) return null;
  return (
    <p className="mt-2 flex items-center gap-2 text-xs text-base-content/70">
      <span>Ranking for: {text}</span>
      <button
        type="button"
        className="link link-primary"
        aria-label="Edit what you are looking for"
        onClick={onEdit}
      >
        Edit
      </button>
    </p>
  );
}
