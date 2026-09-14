import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

/**
 * CV text extraction for the main process. Kept in its own module (rather than inline in main.ts)
 * for the same reason as send-to-renderer.ts: it is pure "path in, text out" logic with no Electron
 * runtime dependency, so it stays testable and the IPC handler stays a thin, auditable wrapper.
 *
 * PDF extraction uses `unpdf`, a pure-JS, zero-runtime-dependency wrapper around a serverless
 * build of Mozilla's pdf.js. It was chosen over `pdfjs-dist`'s legacy Node build because it needs
 * no worker file to locate, no `standardFontDataUrl`/`isEvalSupported` tuning, and no
 * `@napi-rs/canvas` (a native, prebuild-install-backed optional dependency of pdfjs-dist) for the
 * text-only path (i.e. nothing that requires a native rebuild toolchain in Electron's main
 * process). `pdf-parse` was rejected: it is effectively unmaintained and its entry point runs a
 * debug harness that reads a fixture file from disk when imported without a module parent.
 */
export interface CvFileContent {
  fileName: string;
  text: string;
}

/** Also the `dialog.showOpenDialog` filter list. See main.ts. */
export const CV_FILE_EXTENSIONS = ['pdf', 'txt', 'md', 'docx'] as const;

/**
 * A CV is a handful of pages. This bound exists so a mis-selected multi-hundred-megabyte file
 * fails fast with a clear message instead of pinning the main process inside pdf.js.
 */
export const MAX_CV_FILE_BYTES = 10 * 1024 * 1024;

/**
 * A `.docx` is a ZIP container (issue #357): the pre-read `MAX_CV_FILE_BYTES` bound above only
 * limits the *compressed* size, not what a pathological or malicious archive can decompress to.
 * This bounds the extracted text every format hands back before it is normalized, so a small
 * compressed file cannot cause unbounded memory/text growth in this process. Generous for any real
 * CV -- even a long, multi-page one is a few thousand characters, nowhere near this.
 *
 * This check runs *after* `extractDocxText`'s decompression, not before it, so it bounds the result
 * but not the transient memory `mammoth`/`jszip` use while producing it. That gap is deliberately
 * accepted rather than pre-inspecting the archive's own (attacker-controlled) declared sizes, which
 * would mean trusting exactly the metadata a crafted file could lie about. What actually keeps this
 * bounded is that `MAX_CV_FILE_BYTES` caps the *compressed* input to 10 MiB and `mammoth` reads a
 * `.docx` as one flat ZIP archive (its parts named by convention, e.g. `word/document.xml`) -- it
 * never recurses into a part as if it were itself another archive. Single-layer DEFLATE (what a
 * ZIP entry actually uses) has a real but bounded worst-case expansion ratio, nowhere near the
 * multi-layer nested-archive ratios a classic "zip bomb" (e.g. 42.zip) relies on to reach
 * pathological (petabyte-scale) sizes; a 10 MiB compressed `.docx` cannot approach that here.
 */
export const MAX_CV_EXTRACTED_TEXT_CHARS = 2_000_000;

function tooLargeError(fileName: string, byteLength: number): Error {
  return new Error(
    `"${fileName}" is ${Math.round(byteLength / 1024 / 1024)} MB. CV files are limited to ${
      MAX_CV_FILE_BYTES / 1024 / 1024
    } MB`,
  );
}

function tooMuchExtractedTextError(fileName: string): Error {
  return new Error(
    `"${fileName}" expanded to an unexpectedly large amount of text (over ${MAX_CV_EXTRACTED_TEXT_CHARS.toLocaleString('en-US')} characters) and was rejected. If this is a real CV, export or paste it as .txt/.md instead.`,
  );
}

/** Collapses the ragged whitespace pdf.js produces so the prompt stays readable and compact. */
function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Raw (unnormalized) pdf.js text extraction, shared by every caller that needs a PDF's text back
 * in this app: this module's own upload path, `resume-pdf-validation.ts`'s rendered-output check,
 * and `application-review-session.ts`'s pre-submit gate (#202). Imported lazily so the
 * (comparatively large) pdf.js build is only paid for when a PDF actually needs reading, and so
 * importing any of those modules in a test that never touches a PDF never pulls pdf.js in. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { extractText } = await import('unpdf');
  const { text } = await extractText(bytes, { mergePages: true });
  return text;
}

/**
 * DOCX -> plain text (issue #357), via mammoth's narrow bytes-in/text-out `extractRawText` API --
 * deliberately not its HTML-conversion path, since this app only ever needs candidate-authored CV
 * text, never DOCX-derived HTML, images or relationships rendered anywhere (let alone in a
 * privileged Electron context). Mammoth is pure JS (no native/Python runtime), makes no network
 * requests, and never executes document content or macros. Imported lazily for the same reason
 * `extractPdfText` imports `unpdf` lazily: a test or caller that never touches a DOCX never pays for
 * it, and mammoth's own dependency tree (jszip et al.) only loads when actually needed.
 */
async function extractDocxText(buffer: Buffer, fileName: string): Promise<string> {
  const mammoth = await import('mammoth');
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (err) {
    throw new Error(
      `could not read "${fileName}" as a Word document: ${
        err instanceof Error ? err.message : 'the file may be corrupted, encrypted, or not a real .docx'
      }`,
      { cause: err },
    );
  }
}

export function cvFileExtension(filePath: string): string {
  return extname(filePath).slice(1).toLowerCase();
}

export function isSupportedCvFile(filePath: string): boolean {
  return (CV_FILE_EXTENSIONS as readonly string[]).includes(cvFileExtension(filePath));
}

/**
 * Reads one CV file and returns its plain text. The extension is re-validated here even though
 * `dialog.showOpenDialog` was given a filter, because that filter is a UI hint the user can defeat
 * on every platform (typing a name, "All files" on some window managers): validation happens on
 * both sides of the boundary, never only in the picker.
 */
export async function readCvFile(filePath: string): Promise<CvFileContent> {
  const fileName = basename(filePath);
  const extension = cvFileExtension(filePath);

  if (!isSupportedCvFile(filePath)) {
    throw new Error(`unsupported CV file type ".${extension}": expected one of: ${CV_FILE_EXTENSIONS.join(', ')}`);
  }

  // Checked from the directory entry BEFORE reading, so an accidentally-picked multi-gigabyte file
  // never lands in the main process's heap at all. Reading first and measuring the buffer
  // afterwards still spared pdf.js, but not the read itself: a large enough file would have
  // exhausted memory (or hit Node's own buffer ceiling) before this bound could ever be applied.
  const stats = await stat(filePath);
  if (stats.size > MAX_CV_FILE_BYTES) throw tooLargeError(fileName, stats.size);

  const buffer = await readFile(filePath);
  // Re-checked against what was actually read: `size` is 0 for some special files (procfs-style
  // entries), and the file can grow between the two calls.
  if (buffer.byteLength > MAX_CV_FILE_BYTES) throw tooLargeError(fileName, buffer.byteLength);

  // Copied into a standalone Uint8Array: pdf.js takes ownership of (and may detach) the buffer it
  // is handed, which must never be Node's shared allocation pool that `readFile` can return.
  const raw =
    extension === 'pdf'
      ? await extractPdfText(Uint8Array.from(buffer))
      : extension === 'docx'
        ? await extractDocxText(buffer, fileName)
        : buffer.toString('utf8');

  // Applied to every format, not just docx, but this is the bound issue #357 exists for: a `.docx`
  // is a ZIP container, so the pre-read `MAX_CV_FILE_BYTES` check above bounds only what was
  // downloaded/compressed, never what a pathological archive can expand to once extracted.
  if (raw.length > MAX_CV_EXTRACTED_TEXT_CHARS) throw tooMuchExtractedTextError(fileName);

  const text = normalizeText(raw);
  if (!text) {
    throw new Error(
      extension === 'pdf'
        ? `no selectable text found in "${fileName}". It looks like a scanned image; export a text-based PDF or paste the CV as .txt`
        : extension === 'docx'
          ? `"${fileName}" contains no readable text`
          : `"${fileName}" is empty`,
    );
  }

  return { fileName, text };
}
