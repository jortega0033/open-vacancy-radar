import { GENERATION_INPUT_BUDGETS } from '../../../electron/generation-input.js';
import {
  clampPromptText,
  fieldPromptText,
  GROUNDING_RULES,
  MAX_CV_PROMPT_CHARS,
  UNTRUSTED_VACANCY_RULE,
} from '../cv/prompts.js';
import { defuseForgedSectionHeaders } from './defuse-section-headers-prompt.js';
import { describeRoundsOmissions, planIsComplete, planPriorRounds, ROUNDS_PROMPT_BUDGET } from './interview-rounds-budget.js';
import type { CompanyEvidenceProseFact } from '../../../electron/company-evidence.js';
import {
  COMPANY_EVIDENCE_RULE,
  NO_COMPANY_EVIDENCE_RULE,
  companyEvidenceBlock,
  currentCompanyEvidence,
} from './interview-prompt-company-evidence.js';

/**
 * Prompt builder for "Prepare interview" (issue #358): one bounded, grounded, review-only prep
 * pack built from application context this app already owns.
 *
 * Lives outside `cv/` for the same reason `letters/prompt.ts` does (see that file's own header
 * comment): the safety layer -- `GROUNDING_RULES`, `UNTRUSTED_VACANCY_RULE`, and the
 * clamp/field helpers -- is imported from `cv/prompts.ts`, never re-derived, so the
 * delimiter-forging defence and the no-tools/no-invention rules stay one piece of text shared
 * across every feature that builds a prompt.
 *
 * This module does no IPC or record-fetching of its own: it is a pure function of a plain data
 * bag the caller (`InterviewPrepDrawer`) assembles from records it already fetched. That keeps
 * the exact instructions sent to the CLI reviewable and testable as data, matching every other
 * prompt builder in this app.
 *
 * The one property specific to this feature, beyond the shared no-invention rules: the CV and
 * letter linked to an application can drift after the application was actually sent (a person
 * edits their CV library entry later, reuses a letter, etc.), so nothing here may describe either
 * document as what the interviewer actually received. See `PROVENANCE_RULE` below -- this is the
 * ticket's own "important adaptation" and is stated explicitly rather than left implicit in
 * `GROUNDING_RULES`, which has no opinion on provenance at all.
 */

export type InterviewPrepStage = 'recruiter_screen' | 'interview';

export interface InterviewPrepContext {
  role: string;
  company: string;
  /** '' when not provided. */
  location: string;
  status: InterviewPrepStage;
  /** '' when not provided. */
  nextStep: string;
  /** '' when not provided. */
  contact: string;
  /** '' when not provided. */
  notes: string;
  /** null when no saved job is linked. */
  savedJob: { salary: string | null; arrangement: string | null; verification: string | null } | null;
  /** null when no application attempt with a captured snapshot is linked. */
  jdSnapshot: { text: string; complete: boolean } | null;
  /** null when no CV is linked, or the linked id no longer resolves. */
  cv: { name: string; text: string } | null;
  /** null when no letter is linked, or the linked id no longer resolves. */
  letter: { type: string; body: string } | null;
  /**
   * Sourced public facts about the employer (#689), already filtered by the support policy.
   * `undefined` = the caller did not ask for company evidence (nothing about it is said);
   * an array, even an empty one, = it did, and the prompt states plainly what is and is not on file.
   * Kept apart from `cv` and `letter`: nothing in here is a fact about the candidate.
   */
  companyEvidence?: readonly CompanyEvidenceProseFact[];
  /**
   * #691: the documents of the selected recorded package. `undefined` = no package is used and the
   * current linked CV/letter above are the only (clearly labelled) basis, exactly as before. When set,
   * a document with text replaces the current linked one for its slot; a document without text says so
   * and the current linked one is offered as a labelled fallback for that slot only.
   */
  submitted?: SubmittedBasis;
  /** #691: true when the application links a CV / letter that is no longer in the library. */
  staleLinks?: { cv: boolean; letter: boolean };
  /** #691: interview rounds the candidate recorded. `prior` = rounds they held, oldest first. */
  rounds?: { prior: readonly PriorRound[]; next: NextRound | null };
}

export type BasisProvenance = 'prepared' | 'user_confirmed' | 'receipt_backed' | 'unknown';

export interface SubmittedDocument {
  /** 'CV', 'cover letter' or 'motivation letter'. */
  label: string;
  provenance: BasisProvenance;
  source: 'draft' | 'artifact_only' | 'person_text' | 'linked_copy' | 'none';
  version: number | null;
  /** First 12 characters of the recorded hash, or null. */
  fingerprint: string | null;
  /** The text, only when the app holds it and it matches its record. */
  text: string | null;
}

export interface SubmittedBasis {
  /** Short human label of the package, e.g. "record version 2". */
  reference: string;
  evidence: 'receipt' | 'user_reported' | 'none';
  /** YYYY-MM-DD or null. */
  recordedOn: string | null;
  cv: SubmittedDocument | null;
  letter: SubmittedDocument | null;
}

export interface PriorRound {
  /** The record's id, so the rounds panel can say how a pack uses this round. Never sent in the prompt. */
  id?: string;
  type: string;
  /** YYYY-MM-DD or null when the candidate did not record a date. */
  date: string | null;
  feedback: string;
  openTopics: readonly string[];
}

export interface NextRound {
  type: string;
  date: string | null;
}

/** Exported so a test (or a future caller) can read the exact bound this prompt applies to the
 * JD snapshot without re-deriving it from `GENERATION_INPUT_BUDGETS`. */
export const MAX_INTERVIEW_PREP_JD_CHARS = GENERATION_INPUT_BUDGETS.interviewPrepJdChars;
export const MAX_INTERVIEW_PREP_LETTER_CHARS = GENERATION_INPUT_BUDGETS.interviewPrepLetterChars;

const STAGE_LABEL: Record<InterviewPrepStage, string> = {
  recruiter_screen: 'Recruiter screen',
  interview: 'Interview',
};

/**
 * The additional invention prohibitions this feature needs on top of `GROUNDING_RULES`
 * (issue #358, acceptance criteria): `GROUNDING_RULES` already forbids a fabricated employer, job
 * title, date, degree, certification, technology, metric, language proficiency, work
 * authorization, mobility, visa sponsorship or EOR arrangement. What it does not cover, and what
 * this feature is specifically tempted to invent, is a project the candidate never did, a
 * seniority level or title they never held, and -- the one unique to interview prep -- feedback,
 * an evaluation or an outcome from a conversation that has not happened yet.
 */
const INTERVIEW_PREP_EXTRA_RULES =
  'Beyond the rules above: never invent a project the candidate did not do, a seniority level or job title they did not hold, or any interview feedback, evaluation or outcome. This preparation runs before the conversation happens, so there is nothing about how it went to report.';

/**
 * The provenance-honesty rule (issue #358, section 3): the linked CV/letter can have changed
 * since the application was actually sent, so nothing here may claim either document is what an
 * interviewer received or what was submitted. This also covers the more indirect version of the
 * same mistake -- treating the current CV/letter as a reliable prediction of what the interviewer
 * will ask about, which is exactly as misleading as claiming it was submitted if the document has
 * since changed.
 */
const PROVENANCE_RULE =
  'Never describe the candidate\'s linked CV or letter below as "the version the interviewer received" or "what was submitted" for this application, and never present them as a reliable prediction of what the interviewer already knows or will ask about -- they are the candidate\'s current linked CV/letter, which may have changed since they applied. Frame every claim you draw from them as "your CV/letter currently says," not as a fact already in the interviewer\'s hands.';

/** #691: how each kind of document basis may be described. Present whenever a recorded package is used. */
const SUBMITTED_BASIS_RULE =
  'The DOCUMENT BASIS block lists every document this preparation uses, each with a reference ([D1], [D2]). Cite the reference whenever you draw on a document. Describe each document only the way its basis line allows: "sent" documents may be called the CV or letter the candidate sent; a document "prepared for this application" must be called that, never what the interviewer received; a "current" document must be framed as "your CV/letter currently says". Never mix text from one document into another.';

/** #691: the candidate's own notes from earlier rounds. Present only when such notes exist. */
const PRIOR_ROUNDS_RULE =
  "The EARLIER ROUNDS block is the candidate's own report of earlier conversations, cited as [R1], [R2], and so on. Use it to decide what to prepare for next, especially the topics the candidate marked as open, and cite the round whenever you use it. It is not evidence: never treat anything in it as the candidate's experience or a CV fact, never as a verified fact about the employer, and never infer from it how the employer judged the candidate, whether they will advance, or any other outcome.";

/** #691: added when the rounds budget left something out, so the model treats the gap as unknown. */
const PRIOR_ROUNDS_OMISSION_RULE =
  'The EARLIER ROUNDS block states which earlier rounds, or which parts of a note or topic list, are not included. Treat everything not shown as unknown: do not infer, reconstruct or guess it, and say plainly that you could not see it when it would matter.';

const STAR_RULE =
  'For the STAR candidates section, draw only on facts the CV text below actually states. Where a Situation, Task, Action or Result element of a candidate story is not supported by the CV text, say plainly that element is missing and phrase it as a question back to the candidate (for example, "What was the measurable result of this project?") -- never invent it.';

function roleFraming(context: InterviewPrepContext): string {
  const role = fieldPromptText(context.role);
  const company = fieldPromptText(context.company);
  return context.status === 'recruiter_screen'
    ? `You are helping a candidate prepare for an upcoming recruiter screen for the ${role} role at ${company}. A recruiter screen is an early, broader conversation: expect questions about motivation, logistics and high-level fit rather than deep technical probing.`
    : `You are helping a candidate prepare for an upcoming interview for the ${role} role at ${company}. Expect deeper questions about the candidate's actual experience, technical depth, and the specific claims on their CV and letter.`;
}

function jdProvenanceRule(context: InterviewPrepContext): string {
  return context.jdSnapshot
    ? 'You may treat the job description snapshot below as durable evidence of what was actually read for this application: it was captured while working this application and has not changed since.'
    : 'No job description snapshot was captured for this application. Say so plainly in your answer, and do not use outside knowledge of this role, company or industry to fill the gap.';
}

function headings(): string {
  return `Reply in Markdown using exactly these headings, in this order:

## Likely questions
Questions this candidate is likely to be asked, drawn only from the role, the known gaps below, and whether this is a recruiter screen or an interview -- never from outside knowledge of what this specific employer or interviewer typically asks.

## Claims to be ready to defend
CV and letter claims an interviewer may probe further, and what evidence in the supplied text backs each one.

## Gaps and how to bridge them
Acknowledge each gap honestly, connect it to adjacent supported experience where one genuinely exists, and state a learning path. Never claim direct experience the candidate does not have.

## STAR candidates
CV-grounded STAR (Situation, Task, Action, Result) stories only, following the STAR rule above.

## Questions to ask
Questions the candidate could ask, grounded in the vacancy and the context below. Never invent a company fact to justify a question.

## Before the call
A short logistics checklist using the next step and contact below where available. State plainly when logistics information is missing.`;
}

function applicationContextBlock(context: InterviewPrepContext): string {
  const location = context.location.trim() ? fieldPromptText(context.location) : '(not provided)';
  const nextStep = context.nextStep.trim() ? fieldPromptText(context.nextStep) : '(not provided)';
  const contact = context.contact.trim() ? fieldPromptText(context.contact) : '(not provided)';
  const notes = context.notes.trim()
    ? clampPromptText(context.notes, GENERATION_INPUT_BUDGETS.candidateInstructionChars)
    : '(not provided)';
  return [
    '=== APPLICATION CONTEXT ===',
    `Role: ${fieldPromptText(context.role)}`,
    `Company: ${fieldPromptText(context.company)}`,
    `Location: ${location}`,
    `Stage: ${STAGE_LABEL[context.status]}`,
    `Next step: ${nextStep}`,
    `Contact: ${contact}`,
    `Notes: ${notes}`,
  ].join('\n');
}

function savedJobBlock(context: InterviewPrepContext): string {
  if (!context.savedJob) return '';
  const { salary, arrangement, verification } = context.savedJob;
  return [
    '',
    '=== SAVED JOB DETAILS ===',
    `Salary: ${salary ? fieldPromptText(salary) : '(not provided)'}`,
    `Arrangement: ${arrangement ? fieldPromptText(arrangement) : '(not provided)'}`,
    `Verification: ${verification ? fieldPromptText(verification) : '(not provided)'}`,
  ].join('\n');
}

function jdBlock(context: InterviewPrepContext): string {
  if (!context.jdSnapshot) {
    return '\nNo job description snapshot is available for this application. Do not use outside knowledge of this role or company to fill this gap.';
  }
  const completeness = context.jdSnapshot.complete ? 'believed complete' : 'may be truncated at the source';
  const text = clampPromptText(defuseForgedSectionHeaders(context.jdSnapshot.text), MAX_INTERVIEW_PREP_JD_CHARS);
  return `\n=== VACANCY / JOB DESCRIPTION (durable snapshot captured during this application; ${completeness}) ===\n${text}`;
}

function cvBlock(context: InterviewPrepContext): string {
  if (!context.cv) {
    return context.staleLinks?.cv
      ? "\nThe CV linked to this application is no longer in the candidate's library, so no current CV text is available."
      : '\nNo CV is linked to this application.';
  }
  const text = clampPromptText(defuseForgedSectionHeaders(context.cv.text), MAX_CV_PROMPT_CHARS);
  return `\n=== YOUR CURRENT LINKED CV (may differ from what you actually submitted for this application) ===\n${text}`;
}

function letterBlock(context: InterviewPrepContext): string {
  if (!context.letter) {
    return context.staleLinks?.letter
      ? "\nThe letter linked to this application is no longer in the candidate's library, so no current letter text is available."
      : '\nNo letter is linked to this application.';
  }
  const text = clampPromptText(defuseForgedSectionHeaders(context.letter.body), MAX_INTERVIEW_PREP_LETTER_CHARS);
  return `\n=== YOUR CURRENT LINKED LETTER (may differ from what you actually submitted) ===\nType: ${fieldPromptText(context.letter.type)}\n${text}`;
}

function companyEvidenceRule(context: InterviewPrepContext, now: Date): string {
  if (context.companyEvidence === undefined) return '';
  return `\n${currentCompanyEvidence(context.companyEvidence, now).length > 0 ? COMPANY_EVIDENCE_RULE : NO_COMPANY_EVIDENCE_RULE}`;
}

const PROVENANCE_LINE: Record<BasisProvenance, string> = {
  receipt_backed:
    'sent: this app attached this file when it sent the application and then observed a confirmation (the confirmation itself does not show the file)',
  user_confirmed: 'sent: the candidate confirmed this is the version they sent',
  prepared: 'prepared for this application by this app; the candidate has not confirmed they sent this version',
  unknown: 'the candidate does not know which version they sent',
};

function sourceNote(doc: SubmittedDocument): string {
  if (doc.source === 'person_text') return ' (text the candidate supplied)';
  if (doc.source === 'linked_copy') return ' (a copy of their library document that they said they sent)';
  return '';
}

function describeDocument(ref: string, doc: SubmittedDocument): string {
  const version = doc.version !== null ? `version ${doc.version}` : 'no version number';
  const fingerprint = doc.fingerprint ? `, fingerprint ${fieldPromptText(doc.fingerprint)}` : '';
  const availability = doc.text ? '' : '; its text is not available to this preparation';
  return `[${ref}] ${fieldPromptText(doc.label)}: ${version}${fingerprint}, ${PROVENANCE_LINE[doc.provenance]}${sourceNote(doc)}${availability}`;
}

interface Slot {
  ref: string;
  /** The recorded document, when the package lists one. */
  recorded: SubmittedDocument | null;
  /** Whether the current linked document is used for this slot (labelled as current). */
  useCurrent: boolean;
}

function slots(context: InterviewPrepContext): { cv: Slot; letter: Slot } {
  const submitted = context.submitted;
  const plan = (recorded: SubmittedDocument | null, hasCurrent: boolean): Omit<Slot, 'ref'> => {
    if (!submitted) return { recorded: null, useCurrent: hasCurrent };
    if (recorded?.text) return { recorded, useCurrent: false };
    // Not recorded, or recorded without text (not known, a file whose text this app never held): the
    // current linked document is a labelled fallback for this slot only.
    return { recorded, useCurrent: hasCurrent };
  };
  return {
    cv: { ref: 'D1', ...plan(submitted?.cv ?? null, context.cv !== null) },
    letter: { ref: 'D2', ...plan(submitted?.letter ?? null, context.letter !== null) },
  };
}

function evidenceLine(submitted: SubmittedBasis): string {
  const on = submitted.recordedOn ? ` on ${fieldPromptText(submitted.recordedOn)}` : '';
  switch (submitted.evidence) {
    case 'receipt':
      return `Application: sent by this app${on}; a confirmation was observed.`;
    case 'user_reported':
      return `Application: the candidate reported applying${on}.`;
    default:
      return 'Application: no submission is recorded in this app.';
  }
}

function basisBlock(context: InterviewPrepContext): string {
  const submitted = context.submitted;
  if (!submitted) return '';
  const plan = slots(context);
  const lines = ['', `=== DOCUMENT BASIS (${fieldPromptText(submitted.reference)}) ===`, evidenceLine(submitted)];
  const entries: Array<[Slot, string]> = [
    [plan.cv, 'CV'],
    [plan.letter, 'letter'],
  ];
  for (const [slot, label] of entries) {
    if (slot.recorded) lines.push(describeDocument(slot.ref, slot.recorded));
    else lines.push(`[${slot.ref}] ${label}: none is recorded with this application's documents.`);
    if (slot.useCurrent) {
      lines.push(
        `[${slot.ref}-current] the candidate's current linked ${label}, used only because no recorded text is available for it; it may differ from what was sent.`,
      );
    }
  }
  return lines.join('\n');
}

function recordedDocumentBlock(ref: string, doc: SubmittedDocument, max: number): string {
  const label = fieldPromptText(doc.label).toUpperCase();
  const heading =
    doc.provenance === 'prepared'
      ? `${label} PREPARED FOR THIS APPLICATION [${ref}] (not confirmed as sent)`
      : `${label} THE CANDIDATE SENT [${ref}]`;
  return `\n=== ${heading} ===\n${clampPromptText(defuseForgedSectionHeaders(doc.text ?? ''), max)}`;
}

function documentBlocks(context: InterviewPrepContext): string {
  if (!context.submitted) return `${cvBlock(context)}\n${letterBlock(context)}`;
  const plan = slots(context);
  const parts: string[] = [];
  if (plan.cv.recorded?.text) parts.push(recordedDocumentBlock(plan.cv.ref, plan.cv.recorded, MAX_CV_PROMPT_CHARS));
  else if (plan.cv.useCurrent) parts.push(cvBlock(context));
  if (plan.letter.recorded?.text) {
    parts.push(recordedDocumentBlock(plan.letter.ref, plan.letter.recorded, MAX_INTERVIEW_PREP_LETTER_CHARS));
  } else if (plan.letter.useCurrent) parts.push(letterBlock(context));
  return parts.length > 0 ? parts.join('\n') : '\nNo document text is available for this application.';
}

function usesCurrentDocuments(context: InterviewPrepContext): boolean {
  if (!context.submitted) return true;
  const plan = slots(context);
  return plan.cv.useCurrent || plan.letter.useCurrent;
}

function roundsBlock(context: InterviewPrepContext): string {
  const rounds = context.rounds;
  if (!rounds) return '';
  const lines: string[] = [];
  if (rounds.next) {
    const when = rounds.next.date ? ` on ${fieldPromptText(rounds.next.date)}` : ' (date not recorded)';
    lines.push('', '=== NEXT ROUND (as the candidate recorded it) ===', `${fieldPromptText(rounds.next.type)}${when}`);
  }
  if (rounds.prior.length > 0) {
    const plan = planPriorRounds(rounds.prior);
    lines.push('', "=== EARLIER ROUNDS (the candidate's own notes of what they were told; nobody has checked them) ===");
    const omissions = describeRoundsOmissions(plan);
    lines.push(
      omissions
        ? `Not everything the candidate recorded is below: ${plan.rounds.length} of ${plan.recorded} earlier ${plan.recorded === 1 ? 'round' : 'rounds'} included. Left out or shortened: ${omissions}. Anything not shown here is unknown to you; do not guess at it.`
        : `All ${plan.recorded} earlier ${plan.recorded === 1 ? 'round' : 'rounds'} the candidate recorded are included.`,
    );
    plan.rounds.forEach((round, index) => {
      const when = round.date ? round.date : 'date not recorded';
      const feedback = round.feedback ? round.feedback : '(no notes recorded)';
      const topics = round.topics.length > 0 ? round.topics.join('; ') : '(none marked)';
      lines.push(`[R${index + 1}] ${round.type}, ${when}.`, `What the candidate noted: ${feedback}`);
      if (round.feedbackUsedChars < round.feedbackRecordedChars) {
        lines.push(
          `[Only the first ${round.feedbackUsedChars.toLocaleString('en-US')} of ${round.feedbackRecordedChars.toLocaleString('en-US')} characters of this note are included; the rest is not shown. Do not guess at it.]`,
        );
      }
      lines.push(`Topics the candidate marked as still open: ${topics}`);
      if (round.topicsDropped > 0 || round.topicsShortened > 0) {
        lines.push(
          `[Topics of this round: ${round.topicsRecorded} recorded, ${round.topics.length} shown${round.topicsShortened > 0 ? `, ${round.topicsShortened} cut to ${ROUNDS_PROMPT_BUDGET.topicChars} characters` : ''}. Do not guess at the rest.]`,
        );
      }
    });
  }
  return lines.join('\n');
}

export function buildInterviewPrepPrompt(context: InterviewPrepContext, now: Date = new Date()): string {
  const untrustedVacancyRule = context.jdSnapshot ? `\n${UNTRUSTED_VACANCY_RULE}` : '';
  const companyEvidenceSection =
    context.companyEvidence === undefined ? '' : companyEvidenceBlock(context.companyEvidence, now);
  const priorRounds = (context.rounds?.prior.length ?? 0) > 0;
  const extraRules = priorRounds
    ? "Beyond the rules above: never invent a project the candidate did not do, a seniority level or job title they did not hold, or any interview feedback, evaluation or outcome beyond what the EARLIER ROUNDS block states in the candidate's own words."
    : INTERVIEW_PREP_EXTRA_RULES;
  const provenanceRules = [
    context.submitted ? SUBMITTED_BASIS_RULE : '',
    usesCurrentDocuments(context) ? PROVENANCE_RULE : '',
    priorRounds ? PRIOR_ROUNDS_RULE : '',
    priorRounds && !planIsComplete(planPriorRounds(context.rounds!.prior)) ? PRIOR_ROUNDS_OMISSION_RULE : '',
  ]
    .filter(Boolean)
    .join('\n');
  const pastInterviews = priorRounds
    ? "This is a review-only preparation pack: beyond the candidate's own notes, never claim to know how any past conversation went, and never promise this preparation guarantees an outcome."
    : 'This is a review-only preparation pack: never claim to know how any past interview for this candidate went, and never promise this preparation guarantees an outcome.';

  return `${roleFraming(context)}

${GROUNDING_RULES}${untrustedVacancyRule}
${extraRules}
${provenanceRules}
${jdProvenanceRule(context)}
${STAR_RULE}${companyEvidenceRule(context, now)}
${pastInterviews}

${headings()}

${applicationContextBlock(context)}${savedJobBlock(context)}${basisBlock(context)}${roundsBlock(context)}
${jdBlock(context)}${companyEvidenceSection}
${documentBlocks(context)}`;
}
