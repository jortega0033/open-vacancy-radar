import { cvArtifactStatus, snapshotNeedsReapproval } from '../../../electron/workspace/cv-artifact-status.js';
import { currentCvJdRevisionId, describeCvJdGaps } from '../../../electron/workspace/cv-evidence-schema.js';
import { describeCvSourceGaps, selectSourceProjects } from '../../../electron/workspace/cv-source-schema.js';
import type { CvEvidenceOverlayRecord, CvSourceDocument } from '../../window.js';
import { describeNextStep } from '../cv-library/tailoring-cases.js';

/**
 * The seven steps of a tailoring case and the one action that moves it on (#446).
 *
 * Everything here is derived from the stored case and the same gap helpers the cards and the main
 * process use (`describeCvJdGaps`, the requirement fields, `snapshotNeedsReapproval`,
 * `cvArtifactStatus`), never from what a card happens to be showing. A case reopened after its job
 * description or CV changed therefore cannot show a step as done on the strength of older input: the
 * requirement revision, the source hash baseline and the approval snapshot are all checked.
 */
export type CaseStepId = 'job' | 'requirements' | 'answers' | 'facts' | 'projects' | 'approve' | 'files';
export type CaseStepState = 'done' | 'needs_you' | 'blocked' | 'not_started';

export interface CaseStep {
  id: CaseStepId;
  number: number;
  label: string;
  state: CaseStepState;
  /** One short phrase saying why, for the step's own line. */
  detail: string;
  /** The element id of the card section this step opens (see the `cv-step-*` ids on the cards). */
  targetId: string;
}

export interface CaseProgress {
  steps: CaseStep[];
  /** Exactly one action, or a statement that the CV is approved. Never empty. */
  next: string;
  complete: boolean;
}

export interface CaseProgressInput {
  overlay: CvEvidenceOverlayRecord | null;
  sourceCv: CvSourceDocument | null;
  /** The CV changed after the case was started or last rebased (`previewCvEvidenceRebase`). */
  cvChanged: boolean;
}

const LABEL: Record<CaseStepId, string> = {
  job: 'Job description',
  requirements: 'Requirements',
  answers: 'Your answers',
  facts: 'Facts and wording',
  projects: 'Projects',
  approve: 'Approve CV',
  files: 'Files',
};

const TARGET: Record<CaseStepId, string> = {
  job: 'cv-step-job',
  requirements: 'cv-step-requirements',
  answers: 'cv-step-answers',
  facts: 'cv-step-facts',
  projects: 'cv-step-projects',
  approve: 'cv-step-approve',
  files: 'cv-step-files',
};

const ORDER: readonly CaseStepId[] = ['job', 'requirements', 'answers', 'facts', 'projects', 'approve', 'files'];

/** Steps that cannot be finished until another one is. Projects stand alone: they depend on the
 * reviewed CV, not on the requirements. */
const REQUIRES: Record<CaseStepId, readonly CaseStepId[]> = {
  job: [],
  requirements: ['job'],
  answers: ['requirements'],
  facts: ['answers'],
  projects: [],
  approve: ['facts', 'projects'],
  files: ['approve'],
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function deriveCaseProgress({ overlay, sourceCv, cvChanged }: CaseProgressInput): CaseProgress {
  const sourceGaps = sourceCv ? describeCvSourceGaps(sourceCv) : ['no reviewed source'];
  const sourceBlocked = sourceGaps.length > 0;

  const complete: Record<CaseStepId, boolean> = {
    job: false,
    requirements: false,
    answers: false,
    facts: false,
    projects: false,
    approve: false,
    files: false,
  };
  const started: Record<CaseStepId, boolean> = { ...complete };
  const detail: Record<CaseStepId, string> = {
    job: 'Not added yet',
    requirements: 'Not read yet',
    answers: '',
    facts: '',
    projects: '',
    approve: '',
    files: '',
  };

  if (overlay) {
    const revisionId = currentCvJdRevisionId(overlay);
    const active = overlay.requirements.filter((requirement) => !requirement.excluded);

    // 1. Job description: present, and not known to be cut off or unconfirmed.
    const jdGaps = describeCvJdGaps(overlay);
    started.job = overlay.jdSnapshot.trim().length > 0;
    complete.job = started.job && jdGaps.length === 0;
    detail.job = complete.job ? 'Saved' : started.job ? 'Looks incomplete: confirm or paste the full text' : 'Not added yet';

    // 2. Requirements: extracted for the *current* revision, every item reviewed against it, and
    // every quote found. A requirement reviewed against older text counts as not reviewed.
    const coverage = overlay.requirementCoverage;
    const coverageCurrent = coverage.revisionId === revisionId && coverage.status === 'complete';
    const toReview = active.filter(
      (requirement) => !requirement.reviewed || requirement.jdRevisionId !== revisionId || requirement.quoteStart < 0,
    );
    started.requirements = overlay.requirements.length > 0 || coverage.status !== 'not_run';
    complete.requirements = coverageCurrent && toReview.length === 0 && overlay.requirements.length > 0;
    detail.requirements = complete.requirements
      ? `${plural(active.length, 'requirement', 'requirements')} reviewed`
      : !coverageCurrent
        ? coverage.status === 'partial' && coverage.revisionId === revisionId
          ? 'Only part of the posting is read'
          : 'Not read for this job description yet'
        : `${plural(toReview.length, 'requirement', 'requirements')} to review`;

    // 3. Your answers: required items the CV cannot yet evidence are still waiting on the candidate.
    const questions = active.filter(
      (requirement) => requirement.classification === 'required' && requirement.evidenceClass === 'needs_verification',
    );
    started.answers = overlay.facts.length > 0;
    complete.answers = complete.requirements && questions.length === 0;
    detail.answers = complete.answers ? 'No open questions' : questions.length > 0 ? `${plural(questions.length, 'question', 'questions')} to answer` : 'After the requirements';

    // 4. Facts and wording: nothing proposed is waiting, and no two facts contradict.
    const proposed = overlay.facts.filter((fact) => fact.approval === 'proposed');
    const conflicted = overlay.state === 'conflict';
    started.facts = overlay.facts.some((fact) => fact.approval === 'approved' || fact.approval === 'rejected') || overlay.wordingVariants.length > 0;
    complete.facts = proposed.length === 0 && !conflicted;
    detail.facts = conflicted ? 'Facts contradict each other' : proposed.length > 0 ? `${plural(proposed.length, 'fact', 'facts')} to review` : 'Nothing waiting';

    // 5. Projects: the selection the candidate approved is the one the CV shows now.
    const shown = sourceCv ? selectSourceProjects(sourceCv) : [];
    const shownIds = shown.map((project) => project.id).join('\n');
    const approvedIds = overlay.projectSelection?.projectIds.join('\n') ?? null;
    started.projects = overlay.projectSelection !== null;
    complete.projects = !!sourceCv && (shown.length === 0 || approvedIds === shownIds);
    detail.projects = shown.length === 0 && !!sourceCv ? 'No projects to choose' : complete.projects ? 'Selection approved' : started.projects ? 'Projects changed: approve again' : 'Not approved yet';

    // 6. Approve CV: approved, and the approval was built under the current document format.
    const approved = overlay.state === 'candidate_approved' || overlay.state === 'artifact_approved';
    started.approve = approved;
    complete.approve = approved && !snapshotNeedsReapproval(overlay);
    // A kept snapshot on an unapproved case means it was approved once and an edit since then (job
    // description, requirements, facts, wording or projects) took the approval back (#564).
    detail.approve = complete.approve
      ? 'Approved'
      : approved
        ? 'Approve again'
        : overlay.approvedResumeSnapshot
          ? 'Changed since you approved it: approve again'
          : 'Not approved yet';

    // 7. Files: at least one file looked at and confirmed, none still waiting on that.
    const formats = (['pdf', 'docx'] as const).map((format) => cvArtifactStatus(overlay, format));
    started.files = overlay.artifacts.length > 0;
    complete.files =
      complete.approve &&
      formats.includes('accepted') &&
      !formats.some((status) => status === 'awaiting_review' || status === 'qa_failed' || status === 'stale');
    detail.files = complete.files
      ? 'Confirmed'
      : formats.includes('awaiting_review')
        ? 'A file waits for your review'
        : formats.includes('qa_failed')
          ? 'A file failed its checks'
          : 'Not exported yet';
  }

  // A step is only Done once what it depends on is Done: "no facts waiting" means nothing while the
  // requirements that would produce them have not been read.
  for (const id of ORDER) {
    if (complete[id] && !REQUIRES[id].every((required) => complete[required])) complete[id] = false;
  }

  const hardBlocked = (id: CaseStepId): string | null => {
    if (!overlay) return id === 'job' ? null : 'No case yet';
    if (id === 'projects' || id === 'approve' || id === 'files') {
      if (cvChanged) return 'Your CV changed: review what changed first';
      if (sourceBlocked) return 'Review this CV’s source first';
    }
    return null;
  };

  const firstIncomplete = ORDER.find((id) => !complete[id]);
  const steps: CaseStep[] = ORDER.map((id, index) => {
    let state: CaseStepState;
    let why = detail[id];
    if (complete[id]) {
      state = 'done';
    } else {
      const hard = hardBlocked(id);
      const waitingOn = REQUIRES[id].find((required) => !complete[required]);
      if (hard) {
        state = 'blocked';
        why = hard;
      } else if (waitingOn) {
        state = 'blocked';
        why = `After ${LABEL[waitingOn].toLowerCase()}`;
      } else {
        state = id === firstIncomplete || started[id] ? 'needs_you' : 'not_started';
      }
    }
    return { id, number: index + 1, label: LABEL[id], state, detail: why, targetId: TARGET[id] };
  });

  return { steps, next: nextAction({ overlay, sourceBlocked, cvChanged, complete }), complete: ORDER.every((id) => complete[id]) };
}

/**
 * Exactly one action. The ordering comes from `describeNextStep`, the same function the library's
 * case list uses, so the two never disagree; the workspace only adds the two things that list does
 * not know: the project approval and the reviewed source CV.
 */
function nextAction(input: {
  overlay: CvEvidenceOverlayRecord | null;
  sourceBlocked: boolean;
  cvChanged: boolean;
  complete: Record<CaseStepId, boolean>;
}): string {
  const { overlay, sourceBlocked, cvChanged, complete } = input;
  if (!overlay) return 'Next: add the job description';
  const base = describeNextStep(overlay, cvChanged);
  if (base === 'Done') return 'Your CV is approved and its files are confirmed.';
  if (base === 'Approve the CV' || base.startsWith('Export') || base === 'Approve the CV again') {
    if (sourceBlocked && !cvChanged) return 'Next: review this CV’s source';
    if (base === 'Approve the CV' && !complete.projects) return 'Next: approve the project selection';
  }
  return `Next: ${base.charAt(0).toLowerCase()}${base.slice(1)}`;
}
