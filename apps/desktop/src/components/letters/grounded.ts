import type { GenerationInputBundle } from '../../../electron/generation-input.js';
import {
  assembleGroundedLetter,
  buildGroundedSourceFacts,
  selectGroundedFacts,
  type GroundedSelectionLabels,
  type GroundedSourceFact,
} from '../../../electron/grounded-letter.js';
import type { LetterLength, LetterTone, LetterType } from '../../window.js';

/**
 * The interactive half of the grounded letter contract (F-J): the two screens that generate a
 * letter in front of a person share this module, so "what may this letter say" has one answer
 * whichever screen asked.
 *
 * `electron/grounded-letter.ts` owns the contract itself. What lives here is the bundle-shaped
 * glue: which facts a `GenerationInputBundle` offers, and how a model's reply becomes a finished
 * document or a handled failure. Both are one function each on purpose. A component that had to
 * remember to validate before displaying would eventually forget, and "the raw model output was
 * shown to the user as if it were a letter" is precisely the failure this ticket exists to remove.
 */

/**
 * The facts this bundle offers, which is a narrower list than the unattended path's.
 *
 * The narrowing is `selectedProjects`: the candidate's own project choice (their pins, and their
 * per-CV `maxProjects` cap) is applied before the model ever sees the list, so a project they
 * deliberately excluded is not merely unlikely to be cited, it has no id to cite.
 */
export function groundedLetterFacts(bundle: GenerationInputBundle): GroundedSourceFact[] {
  return buildGroundedSourceFacts({
    source: bundle.sourceCv,
    profile: bundle.profile,
    projects: bundle.selectedProjects,
  });
}

/** Whether this bundle can produce a grounded letter at all. False means the CV behind it has no
 * reviewed source record, which is a state the user can leave rather than a defect: see the
 * message below. */
export function canGenerateGroundedLetter(bundle: GenerationInputBundle | null): boolean {
  return bundle !== null && groundedLetterFacts(bundle).length > 0;
}

/**
 * Why a letter cannot be generated, in the user's terms and with the step that clears it. The
 * reviewed source record is the CV a person actually confirmed; without one there is nothing this
 * app is willing to put its name to in a letter, and offering a free-prose draft instead would
 * hand back exactly the risk the grounded path removes.
 */
export const GROUNDED_LETTER_UNAVAILABLE =
  'This CV has no reviewed source record yet, so there are no confirmed facts to write from. Open it in your CV library, review and confirm the extracted source, then come back.';

/**
 * Said on both screens, because it is a real property of the output rather than a caveat.
 *
 * The draft is not model prose: it is the candidate's own confirmed sentences with this app's
 * connecting lines around them, and those lines are written in English. A posting in another
 * language needs a translation pass before sending, and the user should learn that from the screen
 * rather than from the letter.
 */
export const GROUNDED_LETTER_DISCLOSURE =
  'Assembled from facts you confirmed on your CV, with connecting lines written by this app in English. Nothing in it is written by the model: it only chooses which of your facts to cite.';

const LABELS: GroundedSelectionLabels = {
  run: 'the letter generation run',
  document: 'the generated letter',
};

export interface GroundedLetterRequest {
  bundle: GenerationInputBundle;
  type: LetterType;
  tone: LetterTone;
  length: LetterLength;
}

/**
 * Turns one model reply into a finished letter, or throws with a message the screen can show.
 *
 * Throwing is the whole point. There is no partial success here and no salvage path: a reply that
 * is not a well-formed selection of known ids produces no document, so nothing a component
 * displays can be something this function did not assemble.
 */
export function renderGroundedLetterFromSelection(raw: string, request: GroundedLetterRequest): string {
  const { bundle, type, tone, length } = request;
  const facts = selectGroundedFacts(raw, groundedLetterFacts(bundle), LABELS);
  return assembleGroundedLetter({
    type,
    tone,
    length,
    facts,
    role: bundle.vacancy.title,
    company: bundle.vacancy.company,
    candidateName: bundle.sourceCv?.contact.name ?? '',
    maxChars: bundle.constraints.maxChars,
  });
}
