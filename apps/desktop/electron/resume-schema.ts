/**
 * The structured-resume shape produced by the unattended tailoring path (#199), and the design
 * decision #156 flagged as needing to be made before implementation: a tailored CV rendered
 * unattended into a real PDF needs real sections (contact/experience/skills/education) a template
 * can lay out reliably, not one prose blob a renderer can only wrap in a styled shell.
 *
 * Deliberately separate from `buildCvTailorPrompt`'s existing plain-text output (`prompts.ts`),
 * which stays exactly as it is: that prompt backs `TailorCv.tsx`'s live, streamed, interactive
 * draft, where a reader watches prose accumulate token by token. A structured JSON object streamed
 * the same way reads as a stream of broken fragments until the final closing brace arrives, which
 * would be a real UX regression for a feature that already shipped. The unattended path (#199) has
 * no such constraint: nothing renders progress until generation finishes, so the model is free to
 * return one complete JSON object instead.
 *
 * Same "no runtime imports" discipline as `workspace/cv-profile-schema.ts`, for the same reason:
 * this file is imported by the renderer (prompt building, response coercion) and will be imported
 * by Electron main (PDF rendering) once that lands, and the only thing that makes sharing it safe is
 * that it never touches an Electron- or Node-only API at runtime.
 */

export interface ResumeContact {
  name: string;
  title: string;
  location: string;
  email: string;
  phone: string;
  /** Portfolio/LinkedIn/GitHub links, exactly as they appear in the source CV. */
  links: string[];
}

export interface ResumeExperienceEntry {
  company: string;
  title: string;
  /** Free text, e.g. "Jan 2021 - Present": CVs write dates too many different ways to parse into
   * a structured range without risking a wrong inference the source CV never stated. */
  dates: string;
  bullets: string[];
}

export interface ResumeEducationEntry {
  institution: string;
  credential: string;
  dates: string;
}

export interface TailoredResume {
  contact: ResumeContact;
  summary: string;
  experience: ResumeExperienceEntry[];
  skills: string[];
  education: ResumeEducationEntry[];
}

/** Field size budgets. Generous for a real resume, finite against a hostile or over-eager answer --
 * the same reasoning as `CV_PROFILE_LIMITS`. */
export const RESUME_LIMITS = {
  /** name / title / location / email / phone / company / institution / credential / dates */
  shortField: 512,
  /** each link, each skill */
  listItem: 512,
  /** each bullet point */
  bullet: 1_000,
  summary: 4_000,
  links: 10,
  skills: 100,
  experienceEntries: 30,
  bulletsPerEntry: 20,
  educationEntries: 15,
} as const;

/** An empty `TailoredResume`: every field present, nothing invented. The safe value to fall back
 * to when a response cannot be coerced at all, rather than throwing and losing the whole attempt. */
export const EMPTY_TAILORED_RESUME: TailoredResume = {
  contact: { name: '', title: '', location: '', email: '', phone: '', links: [] },
  summary: '',
  experience: [],
  skills: [],
  education: [],
};

/** The JSON shape the structured-resume prompt asks for, and the same shape the response coercion
 * below reads back -- kept next to each other in this one dependency-free file so the two can never
 * drift the way two independently hand-maintained copies could. */
export const RESUME_JSON_SHAPE =
  '{"contact": {"name": string, "title": string, "location": string, "email": string, "phone": string, "links": string[]}, ' +
  '"summary": string, ' +
  '"experience": [{"company": string, "title": string, "dates": string, "bullets": string[]}], ' +
  '"skills": string[], ' +
  '"education": [{"institution": string, "credential": string, "dates": string}]}';
