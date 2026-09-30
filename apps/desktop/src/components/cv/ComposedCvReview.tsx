import { useCallback, useEffect, useState } from 'react';
import { composeApprovedTailoredResume, type ComposedTailoredResume } from '../../../electron/resume-source.js';
import { proposeWordingFromFacts } from '../../../electron/workspace/cv-evidence-schema.js';
import type { CvApprovedWording, CvEvidenceOverlayRecord, CvExportFormat, CvProfile, CvSourceDocument } from '../../window.js';
import { sha256HexOfSource } from './content-hash.js';
import type { VacancyLead } from './types.js';
import { describeError } from './useAgentRun.js';
import { vacancyKeyFor } from './vacancy-key.js';

export interface ComposedCvReviewProps {
  cvId: string | null;
  vacancy: VacancyLead | null;
  sourceCv?: CvSourceDocument | null;
  profile?: CvProfile | null;
}

/**
 * The candidate-approved composition path (#419, step 5-6): previews and approves the CV
 * `composeApprovedTailoredResume` builds from unchanged reviewed source text and active,
 * candidate-approved wording only -- never from `TailorCv`'s free-form advisory draft, which this
 * component neither reads nor affects.
 *
 * "Propose" and "approve" are the same action here, by design (#419: "require explicit approval of
 * the *exact text*"). `handlePreview` computes `proposeWordingFromFacts` -- the sentence each
 * self-reported clarification fact composes into, in the candidate's own words, never AI-generated
 * -- and folds those proposals into the very resume shown in the preview below. `handleApprove`
 * persists exactly that same proposal set. The candidate never approves text they have not seen
 * rendered in the actual CV.
 */
export function ComposedCvReview({ cvId, vacancy, sourceCv, profile }: ComposedCvReviewProps) {
  const [overlay, setOverlay] = useState<CvEvidenceOverlayRecord | null>(null);
  const [composed, setComposed] = useState<ComposedTailoredResume | null>(null);
  const [proposedWording, setProposedWording] = useState<CvApprovedWording[]>([]);
  const [error, setError] = useState<string>();
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [exporting, setExporting] = useState<CvExportFormat | null>(null);
  const [exportedPath, setExportedPath] = useState<string>();

  const vacancyKey = vacancy ? vacancyKeyFor(vacancy) : null;

  useEffect(() => {
    setComposed(null);
    setProposedWording([]);
    setApproved(false);
    setError(undefined);
    if (!cvId || !vacancyKey) {
      setOverlay(null);
      return;
    }
    let cancelled = false;
    void window.workspace.getCvEvidenceOverlay(cvId, vacancyKey).then((record) => {
      if (!cancelled) setOverlay(record);
    });
    return () => {
      cancelled = true;
    };
  }, [cvId, vacancyKey]);

  const canPreview = !!overlay && !!cvId && !!vacancyKey && !!sourceCv;

  const handlePreview = useCallback(async () => {
    if (!cvId || !vacancyKey || !sourceCv) return;
    setError(undefined);
    setApproved(false);
    try {
      // Re-fetched fresh rather than trusting this component's own `overlay` state: the sibling
      // RequirementMapping panel (mounted alongside this one in CvAssistant) writes to the same
      // overlay row independently, and this component has no subscription to those writes.
      // Composing against a stale snapshot could show wrong blockers -- stale "still needs review"
      // warnings, or a missing one introduced after this component's initial mount fetch.
      const fresh = await window.workspace.getCvEvidenceOverlay(cvId, vacancyKey);
      if (!fresh) {
        setError('Map this vacancy’s requirements above first, so there is something to compose from.');
        return;
      }
      setOverlay(fresh);
      const currentHash = await sha256HexOfSource(sourceCv);
      const proposed = proposeWordingFromFacts(fresh, currentHash);
      setProposedWording(proposed);
      setComposed(
        composeApprovedTailoredResume(
          sourceCv,
          { ...fresh, wordingVariants: [...fresh.wordingVariants, ...proposed] },
          currentHash,
          profile?.skills ?? [],
        ),
      );
    } catch (err) {
      setError(describeError(err, 'could not build the composed CV'));
    }
  }, [cvId, vacancyKey, sourceCv, profile]);

  const handleApprove = useCallback(async () => {
    if (!overlay || !composed || composed.blockers.length > 0) return;
    setApproving(true);
    setError(undefined);
    try {
      // Persists exactly the wording the preview above showed and nothing more: the same
      // `proposedWording` list `handlePreview` folded into `composed.resume`.
      const updated = await window.workspace.updateCvEvidenceOverlay(overlay.id, {
        wordingVariants: [...overlay.wordingVariants, ...proposedWording],
        state: 'candidate_approved',
      });
      setOverlay(updated);
      setApproved(true);
    } catch (err) {
      setError(describeError(err, 'could not approve this CV'));
    } finally {
      setApproving(false);
    }
  }, [overlay, composed, proposedWording]);

  const handleExport = useCallback(
    async (format: CvExportFormat) => {
      if (!overlay) return;
      setExporting(format);
      setError(undefined);
      setExportedPath(undefined);
      try {
        const result = await window.workspace.exportCvEvidenceOverlay(overlay.id, format);
        if (result.saved && result.path) setExportedPath(result.path);
      } catch (err) {
        setError(describeError(err, 'could not export this CV'));
      } finally {
        setExporting(null);
      }
    },
    [overlay],
  );

  const isApproved = approved || overlay?.state === 'candidate_approved' || overlay?.state === 'artifact_approved';

  if (!cvId || !vacancy) return null;

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div className="card-title text-base font-bold">Approved CV</div>
        <p className="text-sm text-base-content/60">
          Built only from your unchanged reviewed CV and wording you explicitly approved above --
          never from the tailored draft, which stays a separate, advisory read.
        </p>

        {!overlay && (
          <div className="text-sm text-base-content/60">
            Map this vacancy&rsquo;s requirements above first, so there is something to compose from.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-outline" onClick={() => void handlePreview()} disabled={!canPreview}>
            Preview approved CV
          </button>
          {composed && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleApprove()}
              disabled={composed.blockers.length > 0 || approving || isApproved}
            >
              {approving && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
              {isApproved ? 'Approved' : 'Approve CV'}
            </button>
          )}
          {isApproved && (
            <>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => void handleExport('pdf')}
                disabled={exporting !== null}
              >
                {exporting === 'pdf' && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
                Export as PDF
              </button>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => void handleExport('docx')}
                disabled={exporting !== null}
              >
                {exporting === 'docx' && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
                Export as Word
              </button>
            </>
          )}
        </div>

        {error && (
          <div className="alert alert-error text-sm" role="alert">
            {error}
          </div>
        )}
        {exportedPath && (
          <div className="text-sm font-medium" role="status">
            Saved to {exportedPath}
          </div>
        )}
        {approved && (
          <div className="text-sm font-medium" role="status">
            Approved. This is the version ready for export.
          </div>
        )}

        {composed && composed.blockers.length > 0 && (
          <div className="alert alert-warning text-sm" role="alert">
            <ul className="list-disc pl-4">
              {composed.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </div>
        )}

        {composed && (
          <div className="rounded-box border border-base-300 p-4 text-sm" aria-label="Composed CV preview">
            {composed.resume.summary && <p className="mb-2">{composed.resume.summary}</p>}
            {composed.resume.experience.map((entry) => (
              <div key={`${entry.company}-${entry.title}`} className="mb-2">
                <div className="font-medium">
                  {entry.title} at {entry.company}
                </div>
                <ul className="list-disc pl-5">
                  {entry.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              </div>
            ))}
            {composed.resume.projects.map((project) => (
              <div key={project.name} className="mb-2">
                <div className="font-medium">{project.name}</div>
                <p>{project.description}</p>
              </div>
            ))}
            {composed.resume.skills.length > 0 && (
              <div className="text-xs text-base-content/60">Skills: {composed.resume.skills.join(', ')}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
