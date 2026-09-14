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

export interface LetterRenderOptions {
  /** #276: whose letter this is. A letter that never names its sender cannot be told apart from
   * anyone else's letter once it is a finished PDF, which is exactly the "wrong document attached"
   * case the shared acceptance contract has to be able to catch. Omitted for a letter the caller
   * has no candidate name for; the contract then simply has one fewer identity signal. */
  candidateName?: string;
}

/** Renders one generated letter into a complete, standalone HTML document ready for
 * `webContents.loadURL('data:text/html,...')` + `printToPDF`. */
export function renderLetterHtml(title: string, body: string, options: LetterRenderOptions = {}): string {
  const paragraphHtml = paragraphs(body)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join('');
  const requestedName = options.candidateName?.trim() ?? '';
  // A generated letter often signs itself off already; adding a second copy underneath would read
  // as a template bug to the person receiving it.
  const candidateName = requestedName.length > 0 && !body.includes(requestedName) ? requestedName : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title || 'Letter')}</title>
<style>
@page { margin: 56px 64px; }
/* Same reason as resume-html.ts: an unbreakable run must wrap rather than print off the page. */
body { font: 11.5pt/1.6 Georgia, 'Times New Roman', serif; color: #1a1a1a; margin: 0; overflow-wrap: anywhere; }
h1 { font-size: 15pt; margin: 0 0 18px; }
p { margin: 0 0 14px; }
.signature { margin-top: 20px; }
</style></head>
<body>
${title ? `<h1>${escapeHtml(title)}</h1>` : ''}
${paragraphHtml}
${candidateName ? `<p class="signature">${escapeHtml(candidateName)}</p>` : ''}
</body></html>`;
}
