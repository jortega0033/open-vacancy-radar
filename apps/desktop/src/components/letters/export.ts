import { Document, Packer, Paragraph } from 'docx';
import { jsPDF } from 'jspdf';
import type { SaveFileResult } from '../../window.js';

/** Strips characters invalid in a Windows/macOS filename and collapses whitespace, so a letter
 * title like "Senior Frontend Engineer / Redwood?" becomes a valid suggested filename. */
export function sanitizeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'letter';
}

/** Splits the plain-text body into paragraphs on blank lines, the same shape a letter is already
 * written in (see the prompt's "Output the document text only" instruction). */
function paragraphs(body: string): string[] {
  return body.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
}

export async function exportMarkdown(title: string, body: string): Promise<SaveFileResult> {
  const markdown = `# ${title}\n\n${body.trim()}\n`;
  return window.system.saveFile({
    suggestedName: `${sanitizeFileName(title)}.md`,
    data: markdown,
    encoding: 'utf8',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
}

export async function exportDocx(title: string, body: string): Promise<SaveFileResult> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: title, heading: 'Heading1' }),
          ...paragraphs(body).map((text) => new Paragraph({ text, spacing: { after: 200 } })),
        ],
      },
    ],
  });
  const base64 = await Packer.toBase64String(doc);
  return window.system.saveFile({
    suggestedName: `${sanitizeFileName(title)}.docx`,
    data: base64,
    encoding: 'base64',
    filters: [{ name: 'Word document', extensions: ['docx'] }],
  });
}

export async function exportPdf(title: string, body: string): Promise<SaveFileResult> {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 56;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  for (const line of doc.splitTextToSize(title, maxWidth) as string[]) {
    doc.text(line, margin, y);
    y += 20;
  }
  y += 12;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  for (const para of paragraphs(body)) {
    for (const line of doc.splitTextToSize(para, maxWidth) as string[]) {
      if (y > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += 16;
    }
    y += 10;
  }

  const base64 = doc.output('datauristring').split(',')[1] ?? '';
  return window.system.saveFile({
    suggestedName: `${sanitizeFileName(title)}.pdf`,
    data: base64,
    encoding: 'base64',
    filters: [{ name: 'PDF document', extensions: ['pdf'] }],
  });
}
