import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { RoleQuickInput } from './RoleQuickInput.js';
import { rankingText } from './profile-summary.js';

export interface RankingSummaryProps {
  /** Null until the profile has loaded (or when it could not be read): nothing is shown then. */
  profile: CandidateProfile | null;
  /** Opens the edit form. The caller owns the dialog, so other prompts on the page can open it too. */
  onEdit: () => void;
  /** Called with the profile saved from the single role input. */
  onProfileSaved: (profile: CandidateProfile) => void;
}

/**
 * One thin line for Search: "Ranking for: <roles>, <country>. Edit". With nothing set it is the
 * single role question instead. Edit opens the same form as the CV page.
 */
export function RankingSummary({ profile, onEdit, onProfileSaved }: RankingSummaryProps) {
  if (!profile) return null;

  const text = rankingText(profile);
  return (
    <div className="mt-2">
      {text ? (
        <p className="flex items-center gap-2 text-xs text-base-content/70">
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
      ) : (
        <RoleQuickInput compact onSaved={onProfileSaved} />
      )}
    </div>
  );
}
