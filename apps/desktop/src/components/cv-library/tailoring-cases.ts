import { cvArtifactStatus, snapshotNeedsReapproval } from '../../../electron/workspace/cv-artifact-status.js';
import { currentCvJdRevisionId } from '../../../electron/workspace/cv-evidence-schema.js';
import type { CvEvidenceOverlayRecord } from '../../window.js';
import type { VacancyLead } from '../cv/index.js';

/** What the candidate sees for one tailoring case. The role and company are stored with the case
 * (#419); a case that predates them is labelled from its key, or from the start of its saved text. */
export function describeTailoringCase(overlay: CvEvidenceOverlayRecord): string {
  const title = overlay.caseTitle.trim();
  const company = overlay.caseCompany.trim();
  if (title || company) return [title, company].filter(Boolean).join(' at ');
  const key = overlay.vacancyKey;
  if (key.startsWith('fields:')) {
    const [keyTitle = '', keyCompany = ''] = key.slice('fields:'.length).split('|');
    if (keyTitle || keyCompany) return [keyTitle, keyCompany].filter(Boolean).join(' at ');
  }
  if (key.startsWith('url:')) return key.slice('url:'.length);
  const firstLine = overlay.jdSnapshot.trim().split('\n')[0]?.slice(0, 60) ?? '';
  return firstLine ? `Pasted job: ${firstLine}` : 'Pasted job with no text saved yet';
}

/**
 * The vacancy the workspace opens on for an existing case. Everything comes from what the case
 * stored: its own key (so the same record is found again, whatever the title says), its latest job
 * description revision, and the role and company it was opened for. Nothing is fetched or guessed.
 */
export function vacancyFromCase(overlay: CvEvidenceOverlayRecord): VacancyLead {
  const latest = overlay.jdRevisions.at(-1);
  const url = latest?.url || (overlay.vacancyKey.startsWith('url:') ? overlay.vacancyKey.slice('url:'.length) : '');
  return {
    title: overlay.caseTitle.trim() || describeTailoringCase(overlay),
    company: overlay.caseCompany.trim(),
    location: '',
    url,
    description: overlay.jdSnapshot,
    requirements: null,
    caseKey: overlay.vacancyKey,
    jdOrigin: latest?.origin ?? (overlay.origin === 'manual' ? 'manual' : 'found'),
    ...(latest?.requisition ? { jdRequisition: latest.requisition } : {}),
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The first thing the candidate can do to move a case forward, read from what the case stored (#499).
 * It follows the same blockers the workspace shows, in the order the workspace asks for them: a
 * changed CV first, then the job description, the requirements, the facts, approval, and last the
 * exported files. `cvChanged` says the CV changed after the case was started or last rebased; the
 * list reads that from the main process, so this stays free of any hashing.
 */
export function describeNextStep(overlay: CvEvidenceOverlayRecord, cvChanged: boolean): string {
  if (overlay.state === 'qa_failed') return 'Fix the failed checks';
  if (cvChanged) return 'Review what changed in your CV';
  if (overlay.state === 'candidate_approved' || overlay.state === 'artifact_approved') {
    if (snapshotNeedsReapproval(overlay)) return 'Approve the CV again';
    const statuses = [cvArtifactStatus(overlay, 'pdf'), cvArtifactStatus(overlay, 'docx')];
    if (cvArtifactStatus(overlay, 'pdf') === 'awaiting_review') return 'Review PDF';
    if (statuses.includes('awaiting_review')) return 'Review Word file';
    if (statuses.includes('qa_failed')) return 'Export again';
    if (statuses.includes('stale') || statuses.includes('legacy_unverified')) return 'Export your files again';
    return statuses.includes('accepted') ? 'Done' : 'Export your files';
  }
  if (overlay.state === 'conflict') return 'Resolve conflicting facts';
  if (overlay.jdSnapshot.trim().length === 0) return 'Add the job description';

  const revisionId = currentCvJdRevisionId(overlay);
  const coverage = overlay.requirementCoverage;
  if (coverage.revisionId !== revisionId || coverage.status === 'not_run') return 'Map the requirements';
  if (coverage.status === 'partial') return 'Map the rest of the requirements';
  const active = overlay.requirements.filter((requirement) => !requirement.excluded);
  const toReview = active.filter((requirement) => !requirement.reviewed || requirement.jdRevisionId !== revisionId);
  if (toReview.length > 0) return `Review ${plural(toReview.length, 'requirement', 'requirements')}`;
  const questions = active.filter(
    (requirement) => requirement.classification === 'required' && requirement.evidenceClass === 'needs_verification',
  );
  if (questions.length > 0) return `Answer ${plural(questions.length, 'question', 'questions')}`;
  const proposed = overlay.facts.filter((fact) => fact.approval === 'proposed');
  if (proposed.length > 0) return `Review ${plural(proposed.length, 'fact', 'facts')}`;
  return 'Approve the CV';
}
