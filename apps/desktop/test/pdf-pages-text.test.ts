// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { openPdfForReview } from '../src/components/cv/pdf-pages.js';

/** A PDF whose pages each carry one content stream, built here so what pdf.js reads is visible in the diff. */
function buildPdf(streams: readonly string[]): Uint8Array {
  const pageNums = streams.map((_stream, index) => 4 + index * 2);
  const objects: string[] = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${pageNums.map((n) => `${n} 0 R`).join(' ')}]/Count ${streams.length}>>`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  streams.forEach((stream, index) => {
    objects.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents ${5 + index * 2} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`);
    objects.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
  });
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

describe('openPdfForReview extractText', () => {
  it('reads each page of the same document as its own text, and nothing for an image-only page', async () => {
    const review = await openPdfForReview(
      buildPdf([
        'BT /F1 14 Tf 20 250 Td (Jane Doe, frontend engineer) Tj ET',
        'BT /F1 14 Tf 20 250 Td (Second page skills) Tj ET',
        '0 0 0 rg 20 20 260 260 re f',
      ]),
    );
    try {
      expect(review.pageCount).toBe(3);
      expect(await review.extractText(1)).toBe('Jane Doe, frontend engineer');
      expect(await review.extractText(2)).toBe('Second page skills');
      expect(await review.extractText(3)).toBe('');
    } finally {
      await review.destroy();
    }
  });
});
