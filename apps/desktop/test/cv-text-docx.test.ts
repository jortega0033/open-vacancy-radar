import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { MAX_CV_EXTRACTED_TEXT_CHARS, readCvFile } from '../electron/cv-text.js';

/**
 * The DOCX path is a real ZIP/XML document being parsed by this app's main process (issue #357),
 * exactly the kind of branch cv-text.test.ts (plain strings only) and cv-text-pdf.test.ts (a
 * different format) cannot exercise. Fixtures are built here with the `docx` package -- already a
 * dependency for CV export -- rather than committed as binary files, for the same reason
 * cv-text-pdf.test.ts builds its own PDFs: what is being parsed stays readable in the diff.
 */
async function buildDocx(children: (Paragraph | Table)[]): Promise<Buffer> {
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

function heading(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1 });
}

function paragraph(text: string): Paragraph {
  return new Paragraph({ children: [new TextRun(text)] });
}

function bullet(text: string): Paragraph {
  return new Paragraph({ text, bullet: { level: 0 } });
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cv-text-docx-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeDocx(name: string, children: (Paragraph | Table)[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, await buildDocx(children));
  return path;
}

describe('readCvFile: real DOCX extraction (issue #357)', () => {
  it('extracts headings, paragraphs, bullet lists and a table into readable text', async () => {
    const path = await writeDocx('cv.docx', [
      heading('Jake Ortega'),
      paragraph('Senior Frontend Engineer with 8 years of Angular experience.'),
      heading('Skills'),
      bullet('Angular'),
      bullet('TypeScript'),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph('Company')] }),
              new TableCell({ children: [new Paragraph('Role')] }),
            ],
          }),
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph('Acme Corp')] }),
              new TableCell({ children: [new Paragraph('Frontend Architect')] }),
            ],
          }),
        ],
      }),
    ]);

    const result = await readCvFile(path);

    expect(result.fileName).toBe('cv.docx');
    expect(result.text).toContain('Jake Ortega');
    expect(result.text).toContain('Senior Frontend Engineer with 8 years of Angular experience.');
    expect(result.text).toContain('Angular');
    expect(result.text).toContain('TypeScript');
    expect(result.text).toContain('Acme Corp');
    expect(result.text).toContain('Frontend Architect');
  });

  it('extracts Unicode text and hyperlink-adjacent text without corrupting it', async () => {
    const path = await writeDocx('unicode-cv.docx', [
      paragraph('José García, Ingeniero de Software (São Paulo)'),
      paragraph('Portfolio: example.invalid/jose (see attached link)'),
    ]);

    const result = await readCvFile(path);

    expect(result.text).toContain('José García');
    expect(result.text).toContain('São Paulo');
    expect(result.text).toContain('example.invalid/jose');
  });

  it('rejects an empty (no-text) document rather than returning a blank CV', async () => {
    const path = await writeDocx('empty.docx', [new Paragraph({ children: [] })]);

    await expect(readCvFile(path)).rejects.toThrow(/"empty\.docx" contains no readable text/);
  });

  it('rejects a corrupted/truncated ZIP with an actionable message, not a crash', async () => {
    const full = await buildDocx([paragraph('Some CV text.')]);
    const truncated = full.subarray(0, Math.floor(full.byteLength / 2));
    const path = join(dir, 'truncated.docx');
    await writeFile(path, truncated);

    await expect(readCvFile(path)).rejects.toThrow(/could not read "truncated\.docx" as a Word document/);
  });

  it('accepts an uppercase .DOCX extension the same as lowercase', async () => {
    const buffer = await buildDocx([paragraph('Case-insensitive extension check.')]);
    const path = join(dir, 'cv.DOCX');
    await writeFile(path, buffer);

    const result = await readCvFile(path);
    expect(result.text).toContain('Case-insensitive extension check.');
  });

  it('rejects extracted text past the bound instead of allowing unbounded growth from one small file', async () => {
    // A real CV is nowhere near this; this fixture exists purely to prove the post-extraction
    // bound is actually enforced, not to model a realistic document. One long paragraph, not
    // thousands of small ones: it exercises the same bound without paying for a few thousand
    // `docx`/mammoth object round trips this assertion has no need for.
    const path = await writeDocx('oversized.docx', [paragraph('x'.repeat(MAX_CV_EXTRACTED_TEXT_CHARS + 1_000))]);

    await expect(readCvFile(path)).rejects.toThrow(
      new RegExp(`expanded to an unexpectedly large amount of text \\(over ${MAX_CV_EXTRACTED_TEXT_CHARS.toLocaleString('en-US')} characters\\)`),
    );
  });
});
