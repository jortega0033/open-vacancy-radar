import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCvFile } from '../electron/cv-text.js';

/**
 * The PDF path is the only place user-supplied file *content* (not just a path) is parsed by this
 * app, and it is the one branch of `readCvFile` that cv-text.test.ts cannot reach: that suite only
 * covers .txt/.md and the pre-parse guards, so `extractPdfText` (the lazy `unpdf` import, the
 * `Uint8Array.from(buffer)` copy that exists because pdf.js may detach the buffer it is handed, and
 * the "scanned image, no selectable text" failure) was never executed by any test. A green suite
 * therefore said nothing about whether picking a PDF worked at all.
 *
 * These fixtures are built here rather than committed as binary files so what is being parsed is
 * readable in the diff, and so the "no text layer" case is unambiguously a PDF with no text rather
 * than a file someone might later assume was corrupt.
 */
function buildPdf(contentStream: string): Uint8Array {
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${contentStream.length}>>\nstream\n${contentStream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cv-text-pdf-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writePdf(name: string, contentStream: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, buildPdf(contentStream));
  return path;
}

describe('readCvFile: real PDF extraction', () => {
  it('extracts the text layer of an actual parsed PDF, normalized', async () => {
    const path = await writePdf(
      'cv.pdf',
      'BT /F1 12 Tf 20 260 Td (Jake Ortega) Tj 0 -20 Td (Angular   architect) Tj ET',
    );

    const result = await readCvFile(path);

    expect(result.fileName).toBe('cv.pdf');
    expect(result.text).toContain('Jake Ortega');
    expect(result.text).toContain('Angular architect'); // runs of spaces collapsed by normalizeText
    expect(result.text).not.toMatch(/\r/u);
    expect(result.text).toBe(result.text.trim());
  }, 30_000);

  it('reports a PDF with no text layer as a scan rather than returning an empty CV', async () => {
    // A page whose content stream draws only a filled rectangle: a valid PDF, zero selectable text.
    // This is what a phone-photographed or flatbed-scanned CV looks like to pdf.js, and silently
    // returning "" here would send an empty CV to the model.
    const path = await writePdf('scan.pdf', '0 0 0 rg 20 20 260 260 re f');

    await expect(readCvFile(path)).rejects.toThrow(/No selectable text found in "scan\.pdf"/);
  }, 30_000);
});
