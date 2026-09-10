import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { TailoredResume } from './resume-schema.js';

/**
 * The DOCX rendering of the same default OVR resume template `resume-html.ts` renders to HTML
 * (#156): the same `TailoredResume` sections (contact header, summary, experience, skills,
 * education), just built with the `docx` package instead of an HTML string. This is a new
 * rendering target, not a second copy of the template's actual content decisions -- every
 * function here mirrors its `resume-html.ts` counterpart one-for-one (same section order, same
 * "omit an empty section entirely" rule), so the two can never describe two different resumes for
 * the same `TailoredResume` input.
 *
 * Pure aside from `Packer.toBuffer`'s own internal zip-writing, no Electron or Node filesystem API:
 * this can run in the renderer's own test environment just as well as in Electron main, the same
 * "no runtime imports" discipline `resume-schema.ts` documents for itself.
 */

const CONTACT_SEPARATOR = '  ·  ';

function contactLineText(resume: TailoredResume): string {
  return [resume.contact.location, resume.contact.email, resume.contact.phone, ...resume.contact.links]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(CONTACT_SEPARATOR);
}

function headingParagraph(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 80 } });
}

function experienceParagraphs(resume: TailoredResume): Paragraph[] {
  if (resume.experience.length === 0) return [];
  const out: Paragraph[] = [headingParagraph('Experience')];
  for (const entry of resume.experience) {
    const titleAndCompany = [entry.title, entry.company].filter((part) => part.trim().length > 0).join(', ');
    out.push(
      new Paragraph({
        spacing: { before: 120 },
        children: [
          new TextRun({ text: titleAndCompany, bold: true }),
          ...(entry.dates ? [new TextRun({ text: `\t${entry.dates}`, color: '555555' })] : []),
        ],
      }),
    );
    for (const bullet of entry.bullets) {
      out.push(new Paragraph({ text: bullet, bullet: { level: 0 } }));
    }
  }
  return out;
}

function educationParagraphs(resume: TailoredResume): Paragraph[] {
  if (resume.education.length === 0) return [];
  const out: Paragraph[] = [headingParagraph('Education')];
  for (const entry of resume.education) {
    const credentialAndInstitution = [entry.credential, entry.institution]
      .filter((part) => part.trim().length > 0)
      .join(', ');
    out.push(
      new Paragraph({
        spacing: { before: 80 },
        children: [
          new TextRun({ text: credentialAndInstitution, bold: true }),
          ...(entry.dates ? [new TextRun({ text: `\t${entry.dates}`, color: '555555' })] : []),
        ],
      }),
    );
  }
  return out;
}

function skillsParagraphs(resume: TailoredResume): Paragraph[] {
  if (resume.skills.length === 0) return [];
  return [headingParagraph('Skills'), new Paragraph({ text: resume.skills.join(', ') })];
}

function summaryParagraphs(resume: TailoredResume): Paragraph[] {
  if (resume.summary.trim().length === 0) return [];
  return [new Paragraph({ text: resume.summary, spacing: { after: 120 } })];
}

/** Renders one `TailoredResume` into the app's default resume template as a real `.docx` buffer. */
export async function renderResumeDocx(resume: TailoredResume): Promise<Buffer> {
  const contactLine = contactLineText(resume);
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: resume.contact.name || 'Candidate',
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.LEFT,
          }),
          ...(resume.contact.title
            ? [new Paragraph({ children: [new TextRun({ text: resume.contact.title, italics: true })] })]
            : []),
          ...(contactLine
            ? [new Paragraph({ children: [new TextRun({ text: contactLine, color: '555555', size: 20 })] })]
            : []),
          ...summaryParagraphs(resume),
          ...experienceParagraphs(resume),
          ...skillsParagraphs(resume),
          ...educationParagraphs(resume),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
