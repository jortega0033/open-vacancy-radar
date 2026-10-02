import { useEffect, useState } from 'react';
import { cvArtifactStatus } from '../../../electron/workspace/cv-artifact-status.js';
import type { CvDocumentRecord, CvEvidenceOverlayRecord } from '../../window.js';
import type { VacancyLead } from '../cv/index.js';
import { formatCvDate } from './cv-profile.js';
import { describeNextStep, describeTailoringCase, vacancyFromCase } from './tailoring-cases.js';

export interface TailoringCasesProps {
  documents: readonly CvDocumentRecord[];
  /** Opens the case in the tailoring workspace, on the CV it belongs to. */
  onOpen(vacancy: VacancyLead, cvId: string): void;
}

const STATE_LABEL: Record<CvEvidenceOverlayRecord['state'], string> = {
  needs_input: 'Needs your input',
  conflict: 'Facts in conflict',
  draft: 'In progress',
  candidate_approved: 'CV approved',
  qa_failed: 'Failed its checks',
  artifact_approved: 'Files accepted',
};

/** A draft a CV change put on hold (#449): it reads as a draft, but the cause is the CV. */
const CV_CHANGED_LABEL = 'CV changed, review needed';

const ARTIFACT_LABEL = {
  not_exported: 'not exported',
  awaiting_review: 'waiting for your review',
  qa_failed: 'failed its checks',
  accepted: 'accepted',
  stale: 'out of date',
  legacy_unverified: 'not verified',
} as const;

const ORIGIN_LABEL: Record<CvEvidenceOverlayRecord['origin'], string> = {
  manual: 'Job you entered',
  vacancy: 'Found vacancy',
};

interface CvCases {
  cv: CvDocumentRecord;
  cases: CvEvidenceOverlayRecord[];
  /** Ids of draft cases whose CV changed after the case was started or last rebased. */
  cvChanged: ReadonlySet<string>;
}

/**
 * Every tailoring case, grouped by the CV it belongs to, so a case can be opened again after the
 * workspace was left (#419). Each row reads what the case stored: its label, where it started, its
 * state and the status of each exported format. The list is read from the database, never from
 * what the screen last held.
 */
export function TailoringCases({ documents, onOpen }: TailoringCasesProps) {
  const [groups, setGroups] = useState<CvCases[] | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    void Promise.all(
      documents.map(async (cv) => {
        const cases = await window.workspace.listCvEvidenceOverlays(cv.id);
        // Only a draft can be one a CV change put on hold. A failed look at what changed reads as
        // "no change" rather than hiding the case.
        const cvChanged = new Set<string>();
        await Promise.all(
          cases
            .filter((tailoringCase) => tailoringCase.state === 'draft')
            .map(async (tailoringCase) => {
              try {
                if ((await window.workspace.previewCvEvidenceRebase(tailoringCase.id)).inputsChanged) {
                  cvChanged.add(tailoringCase.id);
                }
              } catch {
                // keeps the plain draft label
              }
            }),
        );
        return { cv, cases, cvChanged };
      }),
    )
      .then((loaded) => {
        if (!cancelled) setGroups(loaded.filter((group) => group.cases.length > 0));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'could not load your tailoring cases');
      });
    return () => {
      cancelled = true;
    };
  }, [documents]);

  if (error) {
    return (
      <div className="alert alert-error mt-4 text-sm" role="alert">
        {error}
      </div>
    );
  }
  if (!groups) {
    return (
      <section className="mt-8" aria-labelledby="tailoring-cases-heading">
        <h2 id="tailoring-cases-heading" className="text-base font-semibold">
          Tailoring cases
        </h2>
        <p className="mt-1 text-sm text-base-content/60" role="status">
          Loading your tailoring cases…
        </p>
      </section>
    );
  }

  return (
    <section className="mt-8" aria-labelledby="tailoring-cases-heading">
      <h2 id="tailoring-cases-heading" className="text-base font-semibold">
        Tailoring cases
      </h2>
      <p className="mt-1 text-sm text-base-content/60">
        Open a case to continue where you left off. Its job description, requirements, facts, wording and files are
        kept.
      </p>
      {groups.length === 0 && (
        <p className="mt-3 text-sm text-base-content/60">
          Cases you start with Tailor for a job, or from a vacancy, appear here.
        </p>
      )}
      {groups.map(({ cv, cases, cvChanged }) => (
        <div key={cv.id} className="mt-3">
          <div className="text-sm font-medium">{cv.name}</div>
          <div className="ovr-responsive-table overflow-x-auto">
            <table className="table" aria-label={`Tailoring cases for ${cv.name}`}>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Started from</th>
                  <th>State</th>
                  <th>PDF</th>
                  <th>Word</th>
                  <th>Next step</th>
                  <th>Updated</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((tailoringCase) => {
                  const label = describeTailoringCase(tailoringCase);
                  return (
                    <tr key={tailoringCase.id}>
                      <td>{label}</td>
                      <td>{ORIGIN_LABEL[tailoringCase.origin]}</td>
                      <td>{cvChanged.has(tailoringCase.id) ? CV_CHANGED_LABEL : STATE_LABEL[tailoringCase.state]}</td>
                      <td>{ARTIFACT_LABEL[cvArtifactStatus(tailoringCase, 'pdf')]}</td>
                      <td>{ARTIFACT_LABEL[cvArtifactStatus(tailoringCase, 'docx')]}</td>
                      <td>{describeNextStep(tailoringCase, cvChanged.has(tailoringCase.id))}</td>
                      <td>{formatCvDate(tailoringCase.updatedAt)}</td>
                      <td className="text-right">
                        <button
                          type="button"
                          className="btn btn-outline btn-xs"
                          aria-label={`Open ${label}`}
                          onClick={() => onOpen(vacancyFromCase(tailoringCase), cv.id)}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}
