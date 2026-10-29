import type {
  InterviewDocumentView,
  InterviewPackageView,
  InterviewRoundView,
} from '../../../electron/interview-context-types.js';
import type { NextRound, PriorRound, SubmittedBasis, SubmittedDocument } from './interview-prep-prompt.js';

/**
 * #691: how the documents of an application and the recorded rounds read on screen, and how they are
 * handed to the prompt builder. Pure functions so the drawer, the panels and the tests read one wording.
 */

export const ROUND_TYPE_LABEL: Record<InterviewRoundView['roundType'], string> = {
  recruiter_screen: 'Recruiter screen',
  phone_screen: 'Phone screen',
  technical: 'Technical interview',
  hiring_manager: 'Hiring manager interview',
  panel: 'Panel interview',
  take_home: 'Take-home assignment',
  onsite: 'On-site interview',
  final: 'Final interview',
  other: 'Other conversation',
};

export const ROUND_STATE_LABEL: Record<InterviewRoundView['state'], string> = {
  planned: 'Planned',
  held: 'Done',
};

export function documentLabel(doc: Pick<InterviewDocumentView, 'slot' | 'kind'>): string {
  if (doc.slot === 'cv') return 'CV';
  if (doc.kind === 'motivation_letter') return 'motivation letter';
  if (doc.kind === 'cover_letter') return 'cover letter';
  return 'letter';
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function day(iso: string | null): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  return iso.slice(0, 10);
}

export function fingerprint(hash: string | null): string | null {
  return hash ? hash.slice(0, 12) : null;
}

export function provenanceText(doc: InterviewDocumentView): string {
  switch (doc.provenance) {
    case 'receipt_backed':
      return 'This app attached this file when it sent the application and then saw a confirmation. The confirmation does not show the file itself.';
    case 'user_confirmed':
      if (doc.source === 'person_text') return 'You pasted this as the text you sent.';
      if (doc.source === 'linked_copy') {
        const on = day(doc.statedAt);
        return `You said your linked ${documentLabel(doc)}${on ? `, as it read on ${on},` : ''} is what you sent.`;
      }
      return 'You said this is the version you sent.';
    case 'prepared':
      return 'Prepared by this app for this application. You have not said you sent this version.';
    case 'unknown':
      return 'You said you do not know which version you sent.';
  }
}

export function provenanceBadge(doc: InterviewDocumentView): string {
  switch (doc.provenance) {
    case 'receipt_backed':
      return 'Sent by this app';
    case 'user_confirmed':
      return 'You confirmed';
    case 'prepared':
      return 'Prepared only';
    case 'unknown':
      return 'Version unknown';
  }
}

export function integrityNotes(doc: InterviewDocumentView): string[] {
  const notes: string[] = [];
  if (doc.textState === 'changed') notes.push('The stored text no longer matches its record, so it is left out.');
  if (doc.textState === 'missing') notes.push('The stored text is gone, so it is left out.');
  if (doc.textState === 'not_stored' && doc.source === 'artifact_only') {
    notes.push('This app recorded the file fingerprint but never kept its text, so it cannot be read here.');
  }
  if (doc.fileState === 'missing') notes.push('The file is no longer on this computer.');
  if (doc.fileState === 'changed') notes.push('The file on this computer changed after it was recorded.');
  if (doc.textTruncated) notes.push('The text is long, so only the first part is used.');
  return notes;
}

export function evidenceText(pkg: InterviewPackageView): string {
  const on = day(pkg.submission.recordedAt);
  switch (pkg.submission.evidence) {
    case 'receipt': {
      const what = pkg.submission.receiptKind === 'receipt_reference' ? 'a receipt reference' : 'a confirmation';
      return `Sent by this app${on ? ` on ${on}` : ''}. It saw ${what}.`;
    }
    case 'user_reported':
      return `You reported applying${on ? ` on ${on}` : ''}.`;
    case 'none':
      return pkg.kind === 'prepared' ? 'Not recorded as sent.' : 'No submission is recorded in this app.';
  }
}

export function kindText(pkg: InterviewPackageView): string | null {
  switch (pkg.kind) {
    case 'legacy':
      return 'Sent before this app kept a list of the documents you sent. What it still holds for this application is listed.';
    case 'row':
      return 'This application has no documents prepared by this app. Only what you tell the app is listed.';
    case 'prepared':
      return 'This app prepared these documents. Nothing records that they were sent.';
    case 'recorded':
      return null;
  }
}

export function packageTitle(pkg: InterviewPackageView): string {
  const record = pkg.version ? `record version ${pkg.version}` : pkg.kind === 'legacy' ? 'earlier record' : 'not recorded';
  const requisition = pkg.requisition ? ` (${pkg.requisition})` : '';
  return `${pkg.role} at ${pkg.company}${requisition}, ${record}`;
}

function basisDocument(doc: InterviewDocumentView | undefined): SubmittedDocument | null {
  if (!doc) return null;
  return {
    label: documentLabel(doc),
    provenance: doc.provenance,
    source: doc.source,
    version: doc.version,
    fingerprint: fingerprint(doc.contentHash ?? doc.artifactHash),
    text: doc.textState === 'available' ? doc.text : null,
  };
}

export function submittedBasis(pkg: InterviewPackageView): SubmittedBasis {
  return {
    reference: `${pkg.kind === 'prepared' ? 'prepared package' : 'recorded package'}${pkg.version ? `, record version ${pkg.version}` : ''}`,
    evidence: pkg.submission.evidence,
    recordedOn: day(pkg.submission.recordedAt),
    cv: basisDocument(pkg.documents.find((doc) => doc.slot === 'cv')),
    letter: basisDocument(pkg.documents.find((doc) => doc.slot === 'letter')),
  };
}

/** The round the pack prepares for (earliest planned) and the rounds already done, oldest first. */
export function roundsForPrep(
  rounds: readonly InterviewRoundView[],
  nextRoundId: string | null,
): { prior: PriorRound[]; next: NextRound | null } {
  const next = rounds.find((round) => round.id === nextRoundId && round.state === 'planned') ?? null;
  return {
    prior: rounds
      .filter((round) => round.state === 'held')
      .map((round) => ({
        type: ROUND_TYPE_LABEL[round.roundType],
        date: round.scheduledOn,
        feedback: round.feedback,
        openTopics: round.openTopics,
      })),
    next: next ? { type: ROUND_TYPE_LABEL[next.roundType], date: next.scheduledOn } : null,
  };
}

export function defaultNextRoundId(rounds: readonly InterviewRoundView[]): string | null {
  return rounds.find((round) => round.state === 'planned')?.id ?? null;
}

/** One line naming exactly what a prep pack is (or was) built from. */
export function basisSummary(
  pkg: InterviewPackageView | null,
  current: { cv: boolean; letter: boolean },
  priorRounds: number,
): string {
  const parts: string[] = [];
  const describe = (doc: InterviewDocumentView | undefined, slot: 'cv' | 'letter'): void => {
    const hasCurrent = slot === 'cv' ? current.cv : current.letter;
    if (!pkg) {
      if (hasCurrent) parts.push(`your current ${slot === 'cv' ? 'CV' : 'letter'} (it may differ from what you sent)`);
      return;
    }
    if (!doc) {
      if (hasCurrent) parts.push(`your current ${slot === 'cv' ? 'CV' : 'letter'} (none is recorded for this application)`);
      return;
    }
    const label = documentLabel(doc);
    const version = doc.version ? ` version ${doc.version}` : '';
    if (doc.textState === 'available') {
      parts.push(`${label}${version} (${provenanceBadge(doc).toLowerCase()})`);
    } else if (hasCurrent) {
      parts.push(`your current ${slot === 'cv' ? 'CV' : 'letter'} in place of the recorded ${label}, which has no text here`);
    }
  };
  describe(pkg?.documents.find((doc) => doc.slot === 'cv'), 'cv');
  describe(pkg?.documents.find((doc) => doc.slot === 'letter'), 'letter');
  if (priorRounds > 0) parts.push(`your notes from ${priorRounds} earlier ${priorRounds === 1 ? 'round' : 'rounds'}`);
  if (parts.length === 0) return 'No CV or letter text is available.';
  return capitalise(parts.join(', '));
}
