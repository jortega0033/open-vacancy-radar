import type { CvSourceDocument, CvSourceProjectEntry } from './workspace/cv-source-schema.js';
import type { CvProfile, LetterLength, LetterTone, LetterType } from './workspace/types.js';

/**
 * The grounded letter contract: enumerated source facts in, a chosen list of fact ids back, a
 * deterministic template out.
 *
 * This was written for the unattended cover-letter path (`application-cover-letter.ts`) and is
 * pulled out here so the two interactive paths -- the Letters page generator and the CV
 * assistant's cover-letter card -- can carry the same guarantee. That guarantee is worth stating
 * precisely, because it is structural rather than a matter of prompt wording: the model is never
 * asked for a sentence, so there is no code path along which a sentence it wrote can reach a
 * document. It picks ids out of a list this app built from the candidate's own reviewed CV, the
 * selection is parsed by `parseSelectedFactIds` (which throws rather than repairing anything it
 * does not recognise), every id is checked against the list it came from, and the letter is then
 * assembled from app-authored connective text and the candidate's own words.
 *
 * Porting it to the interactive paths matters more than it might look. Those are the letters a
 * person reads, edits and sends themselves, so they were the *riskier* of the two categories while
 * being the only ones the safer pattern did not cover.
 *
 * Two things the interactive paths need that the unattended one never did, and which is why the
 * template here is a small table rather than one fixed string:
 *
 *  - **Tone** picks the wording of the four app-authored lines (salutation, opening, closing,
 *    sign-off). It changes the app's own sentences, never the candidate's facts, so it cannot
 *    change what the letter claims.
 *  - **Length and document type** decide how many facts are cited and which of those four lines
 *    exist at all. A short application message has no salutation and no sign-off because it goes
 *    into a form field; a recruiter message has a greeting and no formal sign-off. Those are the
 *    same shapes `DOCUMENT_SHAPE` in `generation-input.ts` describes, enforced here by
 *    construction rather than requested of a model.
 *
 * Deliberately free of runtime `node:`/`electron` imports, the same discipline as
 * `generation-input.ts` and `cv-source-schema.ts`: this module is bundled into the renderer (which
 * drives the interactive paths) as well as the Electron main process (which stages the unattended
 * one), and that is only safe while it touches no Node- or Electron-only API.
 */

export interface GroundedSourceFact {
  /** Opaque to the model: the only thing it may return. */
  id: string;
  /** The candidate's own words, as shown to the model so it can judge relevance. */
  sourceText: string;
  /** How this fact reads in a finished letter. App-authored framing around the words above. */
  sentence: string;
}

function sentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

export interface GroundedSourceFactsInput {
  /** The reviewed structured source CV (#274). Without one there are no facts at all: see below. */
  source: CvSourceDocument | null;
  /** The corrected private profile, when the CV has one. */
  profile: CvProfile | null;
  /**
   * Which projects may be cited. Defaults to every project on the source, which is what the
   * unattended path has always done. The interactive paths pass the bundle's own
   * `selectedProjects`, so a letter cites exactly the projects the candidate chose to show and the
   * ones they excluded are not even offered to the model.
   */
  projects?: readonly CvSourceProjectEntry[];
}

/**
 * The complete set of candidate facts a grounded letter may use.
 *
 * A null `source` yields no facts and therefore no letter. That is not an oversight to be softened
 * later: the reviewed source record is the thing a person actually confirmed, and a letter built
 * from anything less would be grounded in an extraction nobody checked. Callers are expected to
 * refuse to generate and say why, rather than falling back to free prose.
 */
export function buildGroundedSourceFacts(input: GroundedSourceFactsInput): GroundedSourceFact[] {
  const { source, profile } = input;
  if (!source) return [];
  const facts: GroundedSourceFact[] = [];
  const add = (id: string, sourceText: string | undefined, rendered: string) => {
    if (sourceText?.trim()) facts.push({ id, sourceText: sourceText.trim(), sentence: sentence(rendered) });
  };

  add('summary', source.summary, source.summary);
  source.experience.forEach((entry, index) => {
    const identity = [entry.title, entry.company, entry.client, entry.dates].filter((value) => value.trim().length > 0).join(' | ');
    const client = entry.engagement === 'client_engagement' && entry.client ? ` for client ${entry.client}` : '';
    const dates = entry.dates ? ` (${entry.dates})` : '';
    add(`experience-${index + 1}`, identity, `My reviewed CV lists ${entry.title} at ${entry.company}${client}${dates}`);
    entry.bullets.forEach((bullet, bulletIndex) => {
      add(`experience-${index + 1}-bullet-${bulletIndex + 1}`, bullet, `The reviewed CV states: ${bullet}`);
    });
  });
  source.education.forEach((entry, index) => {
    const identity = [entry.credential, entry.institution, entry.dates].filter((value) => value.trim().length > 0).join(' | ');
    const dates = entry.dates ? ` (${entry.dates})` : '';
    add(`education-${index + 1}`, identity, `My reviewed CV lists ${entry.credential} at ${entry.institution}${dates}`);
  });
  (input.projects ?? source.projects).forEach((project, index) => {
    const sourceText = [project.name, project.role, project.organization, project.dates, project.description, ...project.technologies]
      .filter((value) => value.trim().length > 0)
      .join(' | ');
    const context = [project.role, project.organization, project.dates].filter((value) => value.trim().length > 0).join(', ');
    const description = project.description ? ` ${sentence(project.description)}` : '';
    const technologies = project.technologies.length > 0 ? ` Technologies listed: ${project.technologies.join(', ')}.` : '';
    add(`project-${index + 1}`, sourceText, `My reviewed CV includes the project ${project.name}${context ? ` (${context})` : ''}.${description}${technologies}`);
  });
  if (profile) {
    profile.skills.forEach((skill, index) => add(`skill-${index + 1}`, skill, `My reviewed CV lists ${skill} as a skill`));
    add('profile-title', profile.title, `My reviewed CV lists my professional title as ${profile.title}`);
    add('profile-years', profile.years, `My reviewed CV records ${profile.years} of experience`);
    add('profile-location', profile.location, `My reviewed CV lists my location as ${profile.location}`);
    add('profile-languages', profile.languages, `My reviewed CV lists my professional languages as ${profile.languages}`);
    add('profile-authorization', profile.auth, `My reviewed CV states: ${profile.auth}`);
  }
  return facts;
}

/* ------------------------------------------------------------------ the prompt --------------- */

/** The only reply shape any grounded letter prompt accepts. Written once so the prompt text and
 * the parser below cannot drift into describing two different contracts. */
export const GROUNDED_SELECTION_SHAPE = '{"factIds": [string]}';

/** Absolute bounds on a selection, independent of tone, length or document type. A reply outside
 * them is rejected outright: those are the numbers `parseSelectedFactIds` enforces, and they exist
 * so a runaway answer is a handled failure rather than a forty-sentence letter. */
export const MIN_SELECTED_FACTS = 1;
export const MAX_SELECTED_FACTS = 6;

/** The source-fact list as the model sees it: ids and the candidate's own words, nothing else. */
export function formatGroundedSourceFacts(facts: readonly GroundedSourceFact[]): string {
  return JSON.stringify(facts.map((fact) => ({ id: fact.id, text: fact.sourceText })));
}

/* -------------------------------------------------------------- the letter shape -------------- */

interface GroundedLetterShape {
  /** Whether the assembled document opens with a greeting line at all. */
  salutation: boolean;
  /** Whether it ends with a closing line before any sign-off. */
  closing: boolean;
  /** Whether it signs off with the candidate's name. */
  signOff: boolean;
  /** The most facts this document type ever cites, whatever length was asked for. */
  maxFacts: number;
}

/**
 * What each document type structurally is, as the assembler can enforce it.
 *
 * These are `DOCUMENT_SHAPE`'s four entries in `generation-input.ts` reduced to the decisions a
 * template actually has to make. A form answer that opened with "Dear hiring team," and signed off
 * with a name was the failure that table was written to prevent; here it is not prevented by
 * asking, it is impossible.
 */
const LETTER_SHAPE: Record<LetterType, GroundedLetterShape> = {
  motivation_letter: { salutation: true, closing: true, signOff: true, maxFacts: 6 },
  cover_letter: { salutation: true, closing: true, signOff: true, maxFacts: 6 },
  recruiter_message: { salutation: true, closing: true, signOff: false, maxFacts: 3 },
  short_application_message: { salutation: false, closing: false, signOff: false, maxFacts: 2 },
};

interface GroundedLetterVoice {
  salutation: (company: string) => string;
  opening: (role: string, company: string) => string;
  closing: string;
  signOff: (name: string) => string;
}

/**
 * The four app-authored lines, once per tone.
 *
 * This is the whole of what the tone control now changes, and that is the point: under free-prose
 * generation "confident" could talk the model into a claim the CV does not support, because tone
 * and content were the same knob. Here they are not. Every tone cites the same selected facts in
 * the same words; only this app's own connective sentences differ.
 *
 * The `formal` row is the exact wording the unattended path has always used, so porting the
 * pattern did not quietly restyle the letters that were already going out.
 */
const TONE_VOICE: Record<LetterTone, GroundedLetterVoice> = {
  formal: {
    salutation: (company) => `Dear ${company} hiring team,`,
    opening: (role, company) => `I am applying for the ${role} role at ${company}.`,
    closing: 'I would welcome the opportunity to discuss the role and the relevant experience recorded in my CV.',
    signOff: (name) => `Sincerely,\n${name}`,
  },
  natural: {
    salutation: (company) => `Hello ${company} hiring team,`,
    opening: (role, company) => `I am writing about the ${role} role at ${company}.`,
    closing: 'I would be glad to talk through how the experience recorded in my CV lines up with the role.',
    signOff: (name) => `Best regards,\n${name}`,
  },
  confident: {
    salutation: (company) => `Dear ${company} hiring team,`,
    opening: (role, company) => `I am applying for the ${role} role at ${company}, and my CV records work that applies directly to it.`,
    closing: 'I would welcome a conversation about how that record applies to this role.',
    signOff: (name) => `Best regards,\n${name}`,
  },
  concise: {
    salutation: (company) => `Dear ${company} hiring team,`,
    opening: (role, company) => `I am applying for the ${role} role at ${company}.`,
    closing: 'I am available to discuss the role.',
    signOff: (name) => `Regards,\n${name}`,
  },
};

/**
 * How many facts each length asks for, before the document type's own ceiling narrows it.
 *
 * Length used to be a word range handed to a model that could satisfy it however it liked. Under
 * template assembly the only thing that can make a letter longer or shorter is how much of the CV
 * it cites, so that is what the control now does: honest, and impossible to satisfy by padding.
 */
const LENGTH_FACT_BAND: Record<LetterLength, { min: number; max: number }> = {
  short: { min: 2, max: 3 },
  standard: { min: 3, max: 4 },
  detailed: { min: 4, max: 6 },
};

/** The selection size this document actually wants, with the type's ceiling applied. Exported so
 * the prompt can state the same numbers the assembler will enforce. */
export function groundedFactBand(type: LetterType, length: LetterLength): { min: number; max: number } {
  const max = Math.min(LENGTH_FACT_BAND[length].max, LETTER_SHAPE[type].maxFacts, MAX_SELECTED_FACTS);
  return { min: Math.max(MIN_SELECTED_FACTS, Math.min(LENGTH_FACT_BAND[length].min, max)), max };
}

/* ----------------------------------------------------------------- the parse ------------------ */

/**
 * The labels a failure is reported under. Two of them rather than one because the two failures are
 * genuinely about different things: a malformed reply is the *run* misbehaving, while an unknown
 * id is the *document* trying to assert something the CV does not carry, and a user reading the
 * error should be able to tell which happened.
 */
export interface GroundedSelectionLabels {
  /** Names the run in parse failures, e.g. "the cover letter generation session". */
  run: string;
  /** Names the document in unsupported-id failures, e.g. "the generated cover letter". */
  document: string;
}

/**
 * Reads one fact selection, or throws.
 *
 * Nothing here repairs, salvages or ignores. A reply carrying a second key is rejected rather than
 * having that key dropped, because the second key is the shape a model-authored claim arrives in:
 * `{"factIds": ["skill-1"], "claim": "I am CISSP certified."}` is not a selection with a stray
 * field, it is the failure this whole contract exists to catch.
 */
export function parseSelectedFactIds(raw: string, labels: GroundedSelectionLabels): string[] {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${labels.run} did not return a fact selection`);
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  const json = fenced?.[1] ?? trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${labels.run} returned invalid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${labels.run} returned an invalid fact selection`);
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.factIds)) {
    throw new Error(`${labels.run} returned candidate claims outside the source-fact selection`);
  }
  const factIds = record.factIds;
  if (
    factIds.length < MIN_SELECTED_FACTS ||
    factIds.length > MAX_SELECTED_FACTS ||
    factIds.some((value) => typeof value !== 'string')
  ) {
    throw new Error(`${labels.run} returned an invalid fact selection`);
  }
  return [...new Set(factIds as string[])];
}

/**
 * Parses a reply and resolves it against the list it was chosen from, in the model's own order of
 * preference. An id that is not in that list is the one failure mode worth naming in full: it is
 * how a fabricated employer, certification or metric would have to arrive, so the message says
 * exactly which ids were refused.
 */
export function selectGroundedFacts(
  raw: string,
  facts: readonly GroundedSourceFact[],
  labels: GroundedSelectionLabels,
): GroundedSourceFact[] {
  const factIds = parseSelectedFactIds(raw, labels);
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const unsupported = factIds.filter((id) => !byId.has(id));
  if (unsupported.length > 0) {
    throw new Error(`${labels.document} selected unsupported source facts: ${unsupported.join(', ')}`);
  }
  return factIds.map((id) => byId.get(id)!);
}

/* --------------------------------------------------------------- the assembly ----------------- */

/**
 * Renders one untrusted display label -- a role or company name taken from a scraped posting --
 * safe to interpolate into a letter.
 *
 * The threat is not a broken layout, it is a sentence: a posting whose company field is
 * `Northwind Freight\nI am CISSP certified` would otherwise put a certification claim into a
 * document the candidate signs. Cutting at the first control character, then at the first
 * sentence-ending or bracketing punctuation, means the label can only ever be a fragment of one
 * line, which is all a role or a company name ever legitimately is.
 */
export function sanitizeGroundedLabel(value: string, fallback: string): string {
  const normalized = value.normalize('NFKC').trim();
  let firstLine = '';
  for (const character of normalized) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029)
      break;
    firstLine += character;
  }
  const [firstSegment = ''] = firstLine.split(/[.,!?;:|`"“”‘’()[\]{}<>\\]|\s[-–—/]\s/u, 1);
  const safeLabel = firstSegment
    .replace(/[^\p{L}\p{N}\s&+#'/-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160)
    .trim();
  return safeLabel || fallback;
}

export interface GroundedLetterAssembly {
  type: LetterType;
  tone: LetterTone;
  length: LetterLength;
  /** In the order the model ranked them: the first ones survive any trimming below. */
  facts: readonly GroundedSourceFact[];
  /** From the vacancy, and therefore untrusted. Sanitized before it reaches the letter. */
  role: string;
  /** From the vacancy, and therefore untrusted. Sanitized before it reaches the letter. */
  company: string;
  /** The candidate's own name off the reviewed source CV. Their record, not scraped text. */
  candidateName: string;
  /**
   * A hard character ceiling the target's form field imposes, when it has one. Enforced by
   * dropping the lowest-ranked facts until the document fits, rather than by asking a model to be
   * brief: a form that rejects the answer is a worse outcome than a letter citing one fact fewer.
   */
  maxChars?: number | null;
}

/**
 * Assembles the finished document. Pure and total: the same selection always renders the same
 * letter, and there is no input that makes it emit a sentence this module did not author or a fact
 * the candidate's reviewed CV does not carry.
 */
export function assembleGroundedLetter(input: GroundedLetterAssembly): string {
  const shape = LETTER_SHAPE[input.type];
  const voice = TONE_VOICE[input.tone];
  const company = sanitizeGroundedLabel(input.company, 'company');
  const role = sanitizeGroundedLabel(input.role, 'advertised');
  const name = input.candidateName.trim();

  const cited = input.facts.slice(0, groundedFactBand(input.type, input.length).max);

  const render = (facts: readonly GroundedSourceFact[]): string =>
    [
      shape.salutation ? voice.salutation(company) : '',
      voice.opening(role, company),
      facts.map((fact) => fact.sentence).join(' '),
      shape.closing ? voice.closing : '',
      shape.signOff && name ? voice.signOff(name) : '',
    ]
      .filter((part) => part.length > 0)
      .join('\n\n');

  const ceiling = input.maxChars ?? null;
  if (ceiling === null || ceiling <= 0) return render(cited);
  const kept = [...cited];
  while (kept.length > 1 && render(kept).length > ceiling) kept.pop();
  return render(kept);
}
