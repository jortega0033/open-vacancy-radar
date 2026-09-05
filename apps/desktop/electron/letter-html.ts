/**
 * The unattended-staging HTML template for a generated letter (cover letter, motivation letter,
 * recruiter message -- #199's "and letter" half of "tailored CV + letter"). Deliberately simple:
 * unlike a resume, a letter has no section-layout problem to solve (it is, and always has been,
 * flowing prose -- see the existing interactive `letters/export.ts`), so this is a plain styled
 * shell around the generated paragraphs, not a new structured format. Pure string building, no
 * Electron or Node API, for the same reason as `resume-html.ts`.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** Splits on blank lines, matching `letters/export.ts`'s own `paragraphs()` -- the same shape the
 * letter prompts are already instructed to produce (see `prompts.ts`'s "no title, no commentary,
 * no Markdown headings" instructions). */
function paragraphs(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

/** Renders one generated letter into a complete, standalone HTML document ready for
 * `webContents.loadURL('data:text/html,...')` + `printToPDF`. */
export function renderLetterHtml(title: string, body: string): string {
  const paragraphHtml = paragraphs(body)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title || 'Letter')}</title>
<style>
@page { margin: 56px 64px; }
body { font: 11.5pt/1.6 Georgia, 'Times New Roman', serif; color: #1a1a1a; margin: 0; }
h1 { font-size: 15pt; margin: 0 0 18px; }
p { margin: 0 0 14px; }
</style></head>
<body>
${title ? `<h1>${escapeHtml(title)}</h1>` : ''}
${paragraphHtml}
</body></html>`;
}
