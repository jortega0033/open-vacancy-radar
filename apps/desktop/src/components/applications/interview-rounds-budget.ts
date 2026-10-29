import { defuseForgedSectionHeaders } from './defuse-section-headers-prompt.js';

/**
 * #691: how much of the candidate's own record of earlier interview rounds one prep pack may carry.
 *
 * One deterministic policy, used by BOTH the prompt builder and the drawer/rounds panel, so the
 * numbers a person is shown before generating are the numbers the prompt states and obeys:
 *
 *  - only the newest `maxRounds` held rounds are used; older rounds are dropped first, whole;
 *  - each round contributes at most `feedbackChars` of its notes (the stored note may be longer: it
 *    stays intact in storage and in the rounds panel) and at most `maxTopics` open topics of
 *    `topicChars` each;
 *  - the notes and topics of all included rounds together stay within `totalChars`; rounds are taken
 *    newest first and the first one that no longer fits ends the list (older ones are dropped).
 *
 * Nothing is cut silently: every omission is counted here and surfaced by the prompt and the UI.
 * Measuring happens after forged section headers are defused (which lengthens text), so an
 * adversarial note cannot use the defusing to exceed the budget.
 */
export const ROUNDS_PROMPT_BUDGET = {
  maxRounds: 6,
  feedbackChars: 2_000,
  maxTopics: 12,
  topicChars: 200,
  totalChars: 12_000,
  /** Metadata is cut hard so adversarial type/date strings cannot widen a round. */
  typeChars: 40,
  dateChars: 10,
} as const;

/**
 * The most a whole EARLIER ROUNDS block can occupy: the content budget plus per-round headings and
 * disclosure lines, the block heading and one omission summary. Asserted against the real prompt.
 */
export const ROUNDS_BLOCK_MAX_CHARS = 16_000;

/** The shape the plan needs from a held round (the prompt's `PriorRound`). */
export interface BudgetedRoundInput {
  type: string;
  date: string | null;
  feedback: string;
  openTopics: readonly string[];
}

export interface PlannedRound {
  /** Index into the held-rounds list the plan was made from (oldest first). */
  sourceIndex: number;
  type: string;
  date: string | null;
  /** The part of the notes the prompt uses ('' when none were recorded). */
  feedback: string;
  /** Length of the recorded notes after trimming and defusing, and of the part used. */
  feedbackRecordedChars: number;
  feedbackUsedChars: number;
  topics: string[];
  topicsRecorded: number;
  /** Topics beyond `maxTopics` plus topics shortened to `topicChars`. */
  topicsDropped: number;
  topicsShortened: number;
}

export interface RoundsPlan {
  /** Included rounds, oldest first (so [R1] is the oldest included). */
  rounds: PlannedRound[];
  /** Held rounds the candidate recorded. */
  recorded: number;
  /** Older held rounds left out. */
  omittedRounds: number;
  /** Included rounds whose notes were shortened. */
  shortenedNotes: number;
  /** Included rounds with topics dropped or shortened. */
  shortenedTopicRounds: number;
}

const flat = (value: string): string => value.replace(/\s+/gu, ' ').trim();

function planOne(round: BudgetedRoundInput, sourceIndex: number): PlannedRound {
  const notes = defuseForgedSectionHeaders(round.feedback.trim());
  const used = notes.length > ROUNDS_PROMPT_BUDGET.feedbackChars ? notes.slice(0, ROUNDS_PROMPT_BUDGET.feedbackChars) : notes;

  const topics: string[] = [];
  let topicsShortened = 0;
  let topicsRecorded = 0;
  for (const raw of round.openTopics) {
    const topic = flat(raw);
    if (!topic) continue;
    topicsRecorded += 1;
    if (topics.length >= ROUNDS_PROMPT_BUDGET.maxTopics) continue;
    if (topic.length > ROUNDS_PROMPT_BUDGET.topicChars) {
      topicsShortened += 1;
      topics.push(topic.slice(0, ROUNDS_PROMPT_BUDGET.topicChars));
    } else {
      topics.push(topic);
    }
  }

  const type = flat(round.type);
  return {
    sourceIndex,
    type: type.slice(0, ROUNDS_PROMPT_BUDGET.typeChars),
    date: round.date ? flat(round.date).slice(0, ROUNDS_PROMPT_BUDGET.dateChars) : null,
    feedback: used,
    feedbackRecordedChars: notes.length,
    feedbackUsedChars: used.length,
    topics,
    topicsRecorded,
    topicsDropped: topicsRecorded - topics.length,
    topicsShortened,
  };
}

const contentChars = (round: PlannedRound): number =>
  round.feedbackUsedChars + round.topics.reduce((sum, topic) => sum + topic.length, 0);

/** Decides which held rounds (oldest first) a prep pack uses, and how much of each. Pure and deterministic. */
export function planPriorRounds(prior: readonly BudgetedRoundInput[]): RoundsPlan {
  const included: PlannedRound[] = [];
  let total = 0;
  for (let index = prior.length - 1; index >= 0; index -= 1) {
    if (included.length >= ROUNDS_PROMPT_BUDGET.maxRounds) break;
    const planned = planOne(prior[index]!, index);
    const size = contentChars(planned);
    if (total + size > ROUNDS_PROMPT_BUDGET.totalChars) break;
    total += size;
    included.unshift(planned);
  }
  return {
    rounds: included,
    recorded: prior.length,
    omittedRounds: prior.length - included.length,
    shortenedNotes: included.filter((round) => round.feedbackUsedChars < round.feedbackRecordedChars).length,
    shortenedTopicRounds: included.filter((round) => round.topicsDropped > 0 || round.topicsShortened > 0).length,
  };
}

export function planIsComplete(plan: RoundsPlan): boolean {
  return plan.omittedRounds === 0 && plan.shortenedNotes === 0 && plan.shortenedTopicRounds === 0;
}

const n = (value: number): string => value.toLocaleString('en-US');

/** What a prep pack leaves out of the recorded rounds, in the person's words; null when nothing is left out. */
export function describeRoundsOmissions(plan: RoundsPlan): string | null {
  if (planIsComplete(plan)) return null;
  const parts: string[] = [];
  if (plan.omittedRounds > 0) {
    parts.push(
      `the ${n(plan.omittedRounds)} oldest ${plan.omittedRounds === 1 ? 'round is' : 'rounds are'} left out (a pack uses at most the ${ROUNDS_PROMPT_BUDGET.maxRounds} most recent, within ${n(ROUNDS_PROMPT_BUDGET.totalChars)} characters of notes and topics)`,
    );
  }
  if (plan.shortenedNotes > 0) {
    parts.push(
      `${n(plan.shortenedNotes)} ${plan.shortenedNotes === 1 ? 'note is' : 'notes are'} cut to the first ${n(ROUNDS_PROMPT_BUDGET.feedbackChars)} characters`,
    );
  }
  if (plan.shortenedTopicRounds > 0) {
    parts.push(
      `${n(plan.shortenedTopicRounds)} ${plan.shortenedTopicRounds === 1 ? 'round has' : 'rounds have'} open topics shortened (at most ${ROUNDS_PROMPT_BUDGET.maxTopics} topics of ${ROUNDS_PROMPT_BUDGET.topicChars} characters each)`,
    );
  }
  return parts.join('; ');
}

/** The short form of the same omissions, for the one-line "This prep pack uses" summary. */
export function describeRoundsOmissionsBrief(plan: RoundsPlan): string | null {
  if (planIsComplete(plan)) return null;
  const parts: string[] = [];
  if (plan.omittedRounds > 0) parts.push(`${n(plan.omittedRounds)} older ${plan.omittedRounds === 1 ? 'round' : 'rounds'} left out`);
  if (plan.shortenedNotes > 0) {
    parts.push(`${n(plan.shortenedNotes)} ${plan.shortenedNotes === 1 ? 'note' : 'notes'} cut to the first ${n(ROUNDS_PROMPT_BUDGET.feedbackChars)} characters`);
  }
  if (plan.shortenedTopicRounds > 0) {
    parts.push(`open topics limited in ${n(plan.shortenedTopicRounds)} ${plan.shortenedTopicRounds === 1 ? 'round' : 'rounds'}`);
  }
  return parts.join('; ');
}

/** How a prep pack uses one recorded round, for the rounds panel. */
export interface RoundPrepUse {
  included: boolean;
  /** The notes are longer than the part a prep pack uses. Only meaningful when included. */
  notesCut: boolean;
  topicsCut: boolean;
}

/** The sentence under a round in the rounds panel; null when a prep pack uses all of that round. */
export function describeRoundPrepUse(use: RoundPrepUse): string | null {
  if (!use.included) {
    return `Not used: a prep pack uses at most the ${ROUNDS_PROMPT_BUDGET.maxRounds} most recent rounds within ${n(ROUNDS_PROMPT_BUDGET.totalChars)} characters, and this one is older than those.`;
  }
  const cuts: string[] = [];
  if (use.notesCut) cuts.push(`only the first ${n(ROUNDS_PROMPT_BUDGET.feedbackChars)} characters of these notes are used`);
  if (use.topicsCut) {
    cuts.push(`open topics are limited to ${ROUNDS_PROMPT_BUDGET.maxTopics} of ${ROUNDS_PROMPT_BUDGET.topicChars} characters each`);
  }
  if (cuts.length === 0) return null;
  return `In a prep pack ${cuts.join(' and ')}. What you recorded stays as it is here.`;
}

/** Per recorded round id: how the plan treats it. `ids` is the held-rounds list the plan was made from. */
export function roundPrepUseById(plan: RoundsPlan, ids: readonly string[]): Map<string, RoundPrepUse> {
  const used = new Map<string, RoundPrepUse>();
  ids.forEach((id) => used.set(id, { included: false, notesCut: false, topicsCut: false }));
  for (const round of plan.rounds) {
    const id = ids[round.sourceIndex];
    if (id === undefined) continue;
    used.set(id, {
      included: true,
      notesCut: round.feedbackUsedChars < round.feedbackRecordedChars,
      topicsCut: round.topicsDropped > 0 || round.topicsShortened > 0,
    });
  }
  return used;
}
