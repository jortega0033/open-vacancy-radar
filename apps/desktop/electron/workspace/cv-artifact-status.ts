import {
  CV_RENDER_CONTRACT_VERSION,
  type CvArtifactFormat,
  type CvArtifactRecord,
  type CvArtifactStatus,
  type CvEvidenceOverlay,
} from './cv-evidence-schema.js';

/**
 * What each exported format is worth right now (#419 step 9). Pure and dependency-free, so the main
 * process (which decides what may be confirmed) and the renderer (which shows it) read the same
 * answer from the same stored records.
 *
 * A record is "current" only while it was rendered from the case's present approved snapshot, under
 * the present render contract. Any change that drops approval (JD, source, fact, wording, project
 * selection), a new approval of any content, or a renderer contract change makes every earlier
 * record historical: it keeps its recorded hash and loses its status. A file edited on disk after
 * export is not re-read here; a record only ever says what the bytes were when they were saved.
 */

type StatusInput = Pick<CvEvidenceOverlay, 'state' | 'approvedResumeSnapshot' | 'artifacts' | 'legacyUnverifiedExport'>;

export function isCurrentArtifact(overlay: StatusInput, artifact: CvArtifactRecord): boolean {
  const snapshot = overlay.approvedResumeSnapshot;
  return (
    overlay.state === 'candidate_approved' &&
    snapshot !== null &&
    artifact.snapshotDigest === snapshot.digest &&
    artifact.snapshotApprovedAt === snapshot.approvedAt &&
    artifact.renderContractVersion === CV_RENDER_CONTRACT_VERSION
  );
}

/** The newest record of one format, or `null`. Records are stored oldest first. */
export function latestArtifactOfFormat(overlay: Pick<CvEvidenceOverlay, 'artifacts'>, format: CvArtifactFormat): CvArtifactRecord | null {
  for (let i = overlay.artifacts.length - 1; i >= 0; i -= 1) {
    const artifact = overlay.artifacts[i];
    if (artifact && artifact.format === format) return artifact;
  }
  return null;
}

export function cvArtifactStatus(overlay: StatusInput, format: CvArtifactFormat): CvArtifactStatus {
  const latest = latestArtifactOfFormat(overlay, format);
  if (!latest) return overlay.legacyUnverifiedExport ? 'legacy_unverified' : 'not_exported';
  if (!isCurrentArtifact(overlay, latest)) {
    // A file that failed its checks and is no longer the current approval has nothing left to say.
    return latest.validation.ok ? 'stale' : 'not_exported';
  }
  if (!latest.validation.ok) return 'qa_failed';
  return latest.confirmedAt ? 'accepted' : 'awaiting_review';
}

/** True when the approved snapshot was made under an older render contract and so cannot be exported
 * until the candidate approves the case again (which recomposes it under the current contract). */
export function snapshotNeedsReapproval(overlay: Pick<CvEvidenceOverlay, 'state' | 'approvedResumeSnapshot'>): boolean {
  return (
    overlay.state === 'candidate_approved' &&
    overlay.approvedResumeSnapshot !== null &&
    overlay.approvedResumeSnapshot.renderContractVersion !== CV_RENDER_CONTRACT_VERSION
  );
}
