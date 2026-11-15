import { Document, Packer, Paragraph } from 'docx';
import { jsPDF } from 'jspdf';
import type { SaveFileResult } from '../../window.js';

/** Strips characters invalid in a Windows/macOS filename and collapses whitespace, so a letter
 * title like "Senior Frontend Engineer / Redwood?" becomes a real, usable suggested filename. */
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

/**
 * #738: pins what would otherwise vary between two renders of the same letter (jsPDF stamps the
 * current time and a random file id), so the same version always produces the same bytes. The
 * library passes the version's own creation time and content hash.
 */
export interface LetterRenderPin {
  createdAt: string;
  /** Any hex string; the first 32 characters become the PDF file id. */
  contentHash: string;
}

export async function buildLetterDocxBase64(title: string, body: string): Promise<string> {
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
  return Packer.toBase64String(doc);
}

export async function exportDocx(title: string, body: string): Promise<SaveFileResult> {
  return window.system.saveFile({
    suggestedName: `${sanitizeFileName(title)}.docx`,
    data: await buildLetterDocxBase64(title, body),
    encoding: 'base64',
    filters: [{ name: 'Word document', extensions: ['docx'] }],
  });
}

/** The PDF a letter exports as. The library preview draws exactly these bytes. */
export function buildLetterPdf(title: string, body: string, pin?: LetterRenderPin): Uint8Array {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  if (pin) {
    doc.setCreationDate(new Date(pin.createdAt));
    doc.setFileId(pin.contentHash.slice(0, 32).toUpperCase().padEnd(32, '0'));
  }
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

  return new Uint8Array(doc.output('arraybuffer'));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Saves already-built PDF bytes, so what the preview showed is exactly what is written. */
export async function savePdfBytes(title: string, bytes: Uint8Array): Promise<SaveFileResult> {
  return window.system.saveFile({
    suggestedName: `${sanitizeFileName(title)}.pdf`,
    data: toBase64(bytes),
    encoding: 'base64',
    filters: [{ name: 'PDF document', extensions: ['pdf'] }],
  });
}

export async function exportPdf(title: string, body: string): Promise<SaveFileResult> {
  return savePdfBytes(title, buildLetterPdf(title, body));
}
