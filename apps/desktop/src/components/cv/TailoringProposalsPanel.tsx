import { useCallback, useEffect, useState } from 'react';
import type { CvProposalPayload, CvSourceDocument, CvTailoringProposalRecord } from '../../window.js';
import type { VacancyLead } from './types.js';
import { describeError } from './useAgentRun.js';
import { caseKeyFor } from './vacancy-key.js';
import { ErrorBanner } from '../shell/index.js';

export interface TailoringProposalsPanelProps {
  cvId: string | null;
  vacancy: VacancyLead | null;
  sourceCv?: CvSourceDocument | null;
  /** Called after a proposal is accepted, so panels that show the case's facts and wording can
   * reload what the acceptance just added. */
  onAccepted?: () => void;
}

function entryLabel(source: CvSourceDocument | null | undefined, id: string): string {
  if (!id) return 'no specific role or project';
  const experience = source?.experience.find((entry) => entry.id === id);
  if (experience) return `${experience.title} at ${experience.company}`;
  const project = source?.projects.find((entry) => entry.id === id);
  if (project) return `project "${project.name}"`;
  return id;
}

/** A plain-language summary of one proposal, for a candidate who has never seen this payload
 * shape before -- never the raw JSON. */
function describeProposal(payload: CvProposalPayload, source: CvSourceDocument | null | undefined): string {
  switch (payload.kind) {
    case 'requirement':
      return `New requirement: "${payload.data.text}"`;
    case 'evidence_link':
      return `Link an existing requirement to ${entryLabel(source, payload.data.anchorParentId)}`;
    case 'clarification_question':
      return `Question to answer: "${payload.data.question}"`;
    case 'fact':
      return `Claims you did: "${payload.data.activity}" on ${entryLabel(source, payload.data.parentId)}`;
    case 'wording':
      return `Proposed wording for ${entryLabel(source, payload.data.parentId)}: "${payload.data.text}"`;
    default: {
      // Exhaustiveness check: another `CvProposalKind` added without a branch here is a compile
      // error, not a silently blank summary.
      const exhaustive: never = payload;
      throw new Error(`describeProposal: unhandled payload kind "${(exhaustive as CvProposalPayload).kind}"`);
    }
  }
}

/**
 * #421's proposal review surface: whatever an authorized local MCP client has proposed for this
 * (CV, vacancy) case, staged in `cv_tailoring_proposals` and never touching the real
 * `CvEvidenceOverlay` until accepted here (see `cv-proposal-schema.ts`'s own header). Renders
 * nothing at all when there is no case yet or nothing pending -- most candidates never connect an
 * MCP client, and an empty "Proposals" card on every CV assistant screen would be noise for all of
 * them.
 */
const PROPOSAL_KIND_LABEL: Record<CvProposalPayload['kind'], string> = {
  requirement: 'Requirement',
  evidence_link: 'Link to a fact',
  clarification_question: 'Question',
  fact: 'Fact',
  wording: 'Wording',
};

export function TailoringProposalsPanel({ cvId, vacancy, sourceCv, onAccepted }: TailoringProposalsPanelProps) {
  const [overlayId, setOverlayId] = useState<string | null>(null);
  const [proposals, setProposals] = useState<CvTailoringProposalRecord[]>([]);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);

  const vacancyKey = vacancy ? caseKeyFor(vacancy) : null;

  const refresh = useCallback(() => {
    if (!cvId || !vacancyKey) {
      setOverlayId(null);
      setProposals([]);
      return;
    }
    void window.workspace.getCvEvidenceOverlay(cvId, vacancyKey).then((overlay) => {
      setOverlayId(overlay?.id ?? null);
      if (!overlay) {
        setProposals([]);
        return;
      }
      void window.workspace.listCvTailoringProposals(overlay.id).then(
        (list) => setProposals(list.filter((proposal) => proposal.status === 'pending')),
        (err) => setError(describeError(err, 'could not load proposals from connected clients')),
      );
    });
  }, [cvId, vacancyKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const decide = useCallback(
    (id: string, action: 'accept' | 'reject') => {
      setBusyId(id);
      setError(undefined);
      const call = action === 'accept' ? window.workspace.acceptCvTailoringProposal(id) : window.workspace.rejectCvTailoringProposal(id);
      void call.then(
        () => {
          setProposals((prev) => prev.filter((proposal) => proposal.id !== id));
          setBusyId(null);
          if (action === 'accept') onAccepted?.();
        },
        (err) => {
          setError(describeError(err, `could not ${action} this proposal`));
          setBusyId(null);
        },
      );
    },
    [onAccepted],
  );

  if (!overlayId || proposals.length === 0) return null;

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div className="card-title text-base font-bold">Suggestions from another app</div>
        <p className="text-sm text-base-content/60">
          Nothing changes in your CV until you accept it. Accepted facts and wording still need your
          approval below.
        </p>

        {error && (
          <ErrorBanner>
            {error}
          </ErrorBanner>
        )}

        <ul>
          {proposals.map((proposal) => (
            <li key={proposal.id} className="ovr-row flex items-start justify-between gap-3 border-b border-base-300">
              <div className="min-w-0">
                <span className="badge badge-ghost badge-sm">{PROPOSAL_KIND_LABEL[proposal.payload.kind]}</span>
                <p className="mt-1 text-sm">{describeProposal(proposal.payload, sourceCv)}</p>
              </div>
              <div className="flex flex-none gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busyId === proposal.id}
                  onClick={() => decide(proposal.id, 'accept')}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={busyId === proposal.id}
                  onClick={() => decide(proposal.id, 'reject')}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
