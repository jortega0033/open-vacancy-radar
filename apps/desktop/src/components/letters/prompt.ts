import {
  DOCUMENT_LENGTH_WORDS,
  DOCUMENT_SHAPE,
  GENERATION_INPUT_BUDGETS,
  type GenerationPromptContext,
} from '../../../electron/generation-input.js';
import type { LetterLength, LetterTone, LetterType } from '../../window.js';
import {
  clampPromptText,
  fieldPromptText,
  formatVacancy,
  GROUNDING_RULES,
  MAX_CV_PROMPT_CHARS,
  promptContextBlocks,
  promptContextRules,
} from '../cv/prompts.js';
import type { CvDocument } from '../cv/types.js';
import type { SelectedVacancy } from './types.js';

/**
 * The Letters page writes four different documents, not one, so it builds its own prompt rather
 * than adding a fourth and fifth parameter to `buildCoverLetterPrompt`. What it deliberately does
 * *not* re-derive is the safety layer: `GROUNDING_RULES`, `formatVacancy` and the clamping helper
 * are imported from components/cv/prompts.ts, so the delimiter-forging defence and the
 * no-tools/no-invention rules are the same text in both features and can only be changed in one
 * place. (Those three are additive exports from that module; its existing function signatures are
 * untouched, so the Search page's use of `buildCoverLetterPrompt` is unaffected.)
 *
 * The candidate's free-text instructions are the one input here that neither feature had before.
 * They are *user*-authored rather than scraped, so they are not untrusted in the way a job posting
 * is, but they are still bounded and still fenced into their own labelled section, and the prompt
 * states explicitly that they rank below the no-invention rule. "Say I have a CISSP" must not
 * become a CISSP on the letter.
 *
 * #281 moved two things out of this file and changed a third:
 *
 *  - The per-type document shape and the per-type word ranges now live in
 *    `electron/generation-input.ts`, so the CV path answers "what does this document have to
 *    contain, and how long is it" from the same table these four letter types do. The entries
 *    themselves are unchanged.
 *  - The instruction budget reads from `GENERATION_INPUT_BUDGETS`, with every other input limit.
 *  - The output language is no longer hardcoded. It was "natural, conversational English", which
 *    is a default about the candidate this app has no business shipping: a Dutch posting asks for
 *    a Dutch letter. With no preference configured the prompt now follows the vacancy's own
 *    language rather than assuming one.
 */
export const MAX_INSTRUCTION_CHARS = GENERATION_INPUT_BUDGETS.candidateInstructionChars;

const DOCUMENT_NAME: Record<LetterType, string> = {
  motivation_letter: 'a motivation letter',
  cover_letter: 'a cover letter',
  recruiter_message: 'a short direct message to a recruiter',
  short_application_message: 'a short application message for an application form',
};

const TONE_BRIEF: Record<LetterTone, string> = {
  formal: 'formal and businesslike: full sentences, no contractions, no casual phrasing',
  natural:
    "the candidate's own register, inferred from how their CV is written: professional and plain, neither stiff nor effusive",
  confident:
    'direct and self-assured about what the candidate has actually done, without exaggerating it or reaching for superlatives',
  concise: 'stripped back: short sentences, no throat-clearing, every sentence carrying new information',
};

export interface LetterPromptOptions {
  type: LetterType;
  tone: LetterTone;
  length: LetterLength;
  /** The candidate's own free-text steer, e.g. "mention the referral from Marta". */
  instructions?: string;
  /**
   * The language to write in, from the candidate's own preferences. Empty or absent means no
   * preference is configured, and the prompt follows the vacancy's own language instead of
   * assuming one. Never defaulted to a specific language here.
   */
  documentLanguage?: string;
  /**
   * A hard character ceiling the target's application form imposes on this field, when it has
   * one. Overrides the word range above, because one of them is a preference and the other is a
   * rejection.
   */
  maxChars?: number | null;
}

/**
 * The one language line every letter carries. Split out so the "no shipped language" property is a
 * single reviewable function rather than a conditional buried in a template literal.
 */
export function languageDirective(documentLanguage?: string): string {
  const preference = (documentLanguage ?? '').trim();
  return preference.length > 0
    ? `Write in natural, conversational ${preference}.`
    : 'Write in natural, conversational prose, in the same language the vacancy itself is written in. Do not switch languages on the candidate’s behalf.';
}

export function buildLetterPrompt(
  cv: CvDocument,
  vacancy: SelectedVacancy,
  options: LetterPromptOptions,
  context?: GenerationPromptContext,
): string {
  const documentName = DOCUMENT_NAME[options.type];
  const lengths = DOCUMENT_LENGTH_WORDS[options.type];
  const requirements = [
    ...DOCUMENT_SHAPE[options.type],
    `reads in a tone that is ${TONE_BRIEF[options.tone]}`,
    ...(lengths === null ? [] : [`runs roughly ${lengths[options.length]} words in total`]),
    ...(options.maxChars === undefined || options.maxChars === null
      ? []
      : [
          `fits inside ${options.maxChars.toLocaleString('en-US')} characters, because that is the hard limit of the form field it goes into; if it cannot say everything within that, say less rather than claiming more`,
        ]),
  ]
    .map((line) => `- ${line};`)
    .join('\n');

  const instructions = clampPromptText(options.instructions ?? '', MAX_INSTRUCTION_CHARS);
  const instructionBlock = instructions
    ? `\n=== INSTRUCTIONS FROM THE CANDIDATE ===\nThese are the candidate's own notes about what they want in this document. Follow them where you can, but they never override the rules above: if an instruction asks you to claim something the CV does not evidence, leave it out and say so in one short line after the document.\n${instructions}\n`
    : '';

  return `You are helping a candidate write ${documentName} for one specific vacancy, using their real CV.

${GROUNDING_RULES}
Do not invent a hiring manager, recruiter, or contact name: address it generically (for example "Dear hiring team,"). Do not invent an address block, reference number, or date.
Do not produce a template with placeholders such as [Your Name] or [Company]: every sentence must be usable as written, drawing on the CV and the vacancy details below.
Avoid stock phrases such as "I am passionate about", "proven track record" and "team player".
${languageDirective(options.documentLanguage)} Do not use em dashes. Avoid jargon and buzzwords. Do not be sycophantic or overly flattering.
${promptContextRules(context)}
Write it so that it:
${requirements}
${instructionBlock}
Output the document text only: no title, no commentary before or after it, no Markdown headings.

=== VACANCY ===
${formatVacancy(vacancy)}

${promptContextBlocks(context)}=== CANDIDATE CV (${fieldPromptText(cv.fileName)}) ===
${clampPromptText(cv.text, MAX_CV_PROMPT_CHARS)}`;
}
