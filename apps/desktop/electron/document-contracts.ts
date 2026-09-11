import { isAcceptableDocumentLink } from './document-links.js';
import {
  DEFAULT_PAGE_BOUNDS,
  type DocumentAcceptanceContract,
  type DocumentArtifactKind,
  type DocumentTarget,
  type RequiredContentItem,
} from './document-acceptance.js';
import type { TailoredResume } from './resume-schema.js';

/**
 * Builds the acceptance contract for each kind of document this app renders (#276). Kept apart
 * from `document-acceptance.ts` so the validator itself stays free of the resume schema and of any
 * per-template knowledge: the validator checks a contract, and this file is the only place that
 * knows what a CV or a letter is supposed to contain.
 *
 * Every contract is derived from the content that is actually about to be rendered. Nothing here
 * invents a requirement the document was never given -- a contract that asked for content the
 * generator never produced would refuse every honest document, and a contract that asked for less
 * than the document claims would not be a check at all.
 */

/** Only links the template turned into real anchors can be required to survive as annotations --
 * see `resume-html.ts`, which renders anything that is not an absolute http(s)/mailto URL as plain
 * text rather than silently "fixing" a link the candidate's own CV wrote that way. */
function anchorableLinks(links: readonly string[]): string[] {
  return links.map((link) => link.trim()).filter((link) => isAcceptableDocumentLink(link));
}

export interface ResumeContractOptions {
  /** The vacancy this CV was tailored for, or null for a library export with no target. */
  target?: DocumentTarget | null;
  /** Employers the reviewed source CV attests to. Lets a genuine re-application to a previous
   * employer through the work-history rule that otherwise refuses a fabricated one. */
  verifiedEmployers?: readonly string[];
}

export function resumeAcceptanceContract(resume: TailoredResume, options: ResumeContractOptions = {}): DocumentAcceptanceContract {
  // The candidate's own name is not listed here: it is the document's *identity*, checked by
  // `identity` below, so that a CV carrying someone else's name reports "wrong document" rather
  // than "a required string is missing".
  const requiredContent: RequiredContentItem[] = [];
  for (const entry of resume.experience) {
    if (entry.company) requiredContent.push({ label: 'employer', text: entry.company });
    if (entry.title) requiredContent.push({ label: 'role', text: entry.title });
    // #274: an engagement whose end client never reached the page reads as direct employment at
    // the agency, which is a different (and wrong) claim about the candidate's history.
    if (entry.engagement === 'client_engagement' && entry.client) requiredContent.push({ label: 'client', text: entry.client });
  }
  // #274's own acceptance case: a selected project silently absent from the finished document is
  // exactly the "looks complete, lost evidence" failure this validation exists to catch.
  for (const project of resume.projects) {
    if (project.name) requiredContent.push({ label: 'project', text: project.name });
  }

  const employmentHistoryText = [
    ...resume.experience.flatMap((entry) => [entry.company, entry.client, entry.title, ...entry.bullets]),
    ...resume.projects.flatMap((project) => [project.organization, project.description]),
  ].filter((text) => text.trim().length > 0);

  return {
    kind: 'cv',
    identity: {
      candidateName: resume.contact.name,
      // What `resume-html.ts` puts in the document's own <title>, which Chromium carries into the
      // finished PDF's /Title. Kept in step with that template deliberately: the two together are
      // what makes "this is someone else's file" detectable from the bytes alone.
      documentTitle: resume.contact.name || 'Resume',
    },
    requiredContent,
    requiredLinks: [...anchorableLinks(resume.contact.links), ...resume.projects.flatMap((project) => anchorableLinks(project.links))],
    target: options.target ?? null,
    targetRule: 'states_own_history',
    employmentHistoryText,
    verifiedEmployers: options.verifiedEmployers ?? [],
    pageBounds: DEFAULT_PAGE_BOUNDS.cv,
  };
}

export interface LetterContractOptions {
  kind: Extract<DocumentArtifactKind, 'cover_letter' | 'motivation_letter'>;
  /** The letter's own heading, e.g. "Cover Letter" -- what `renderLetterHtml` prints and titles. */
  title: string;
  body: string;
  candidateName: string;
  target: DocumentTarget | null;
}

/**
 * The letter half of the shared contract, and the reason #276 lists "CV and letter paths receive
 * equivalent applicable checks" as its own acceptance case: before this, a letter was staged with
 * no validation whatsoever, so a blank, clipped or empty-bodied letter could be registered and
 * reported ready exactly like a good one.
 *
 * Everything that applies to a letter applies here -- extractable text, page bounds, blank pages,
 * clipping, overprinting, link integrity, identity. What differs is only what genuinely differs
 * between the two documents: a letter is addressed to the employer, so naming the company and role
 * is required rather than suspect.
 */
export function letterAcceptanceContract(options: LetterContractOptions): DocumentAcceptanceContract {
  const requiredContent: RequiredContentItem[] = [];
  // The letter's own first paragraph: a letter whose opening never reached the page is a letter
  // that lost its content, however much of the rest survived.
  const openingParagraph = options.body.split(/\n{2,}/).map((paragraph) => paragraph.trim()).find((paragraph) => paragraph.length > 0);
  if (openingParagraph !== undefined) requiredContent.push({ label: 'opening paragraph', text: openingParagraph });

  return {
    kind: options.kind,
    identity: { candidateName: options.candidateName, documentTitle: options.title },
    requiredContent,
    requiredLinks: [],
    target: options.target,
    targetRule: 'addresses_target',
    employmentHistoryText: [],
    verifiedEmployers: [],
    pageBounds: DEFAULT_PAGE_BOUNDS[options.kind],
  };
}
