import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

/**
 * CV text extraction for the main process. Kept in its own module (rather than inline in main.ts)
 * for the same reason as send-to-renderer.ts: it is pure "path in, text out" logic with no Electron
 * runtime dependency, so it stays testable and the IPC handler stays a thin, auditable wrapper.
 *
 * PDF extraction uses `unpdf` — a pure-JS, zero-runtime-dependency wrapper around a serverless
 * build of Mozilla's pdf.js. It was chosen over `pdfjs-dist`'s legacy Node build because it needs
 * no worker file to locate, no `standardFontDataUrl`/`isEvalSupported` tuning, and no
 * `@napi-rs/canvas` (a native, prebuild-install-backed optional dependency of pdfjs-dist) for the
 * text-only path — i.e. nothing that requires a native rebuild toolchain in Electron's main
 * process. `pdf-parse` was rejected: it is effectively unmaintained and its entry point runs a
 * debug harness that reads a fixture file from disk when imported without a module parent.
 */
export interface CvFileContent {
  fileName: string;
  text: string;
}

/** Also the `dialog.showOpenDialog` filter list — see main.ts. */
export const CV_FILE_EXTENSIONS = ['pdf', 'txt', 'md'] as const;

/**
 * A CV is a handful of pages. This bound exists so a mis-selected multi-hundred-megabyte file
 * fails fast with a clear message instead of pinning the main process inside pdf.js.
 */
export const MAX_CV_FILE_BYTES = 10 * 1024 * 1024;

function tooLargeError(fileName: string, byteLength: number): Error {
  return new Error(
    `"${fileName}" is ${Math.round(byteLength / 1024 / 1024)} MB — CV files are limited to ${
      MAX_CV_FILE_BYTES / 1024 / 1024
    } MB`,
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

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  // Imported lazily so the (comparatively large) pdf.js build is only paid for when the user
  // actually picks a PDF, and so importing this module in a test never pulls pdf.js in.
  const { extractText } = await import('unpdf');
  const { text } = await extractText(bytes, { mergePages: true });
  return text;
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
 * on every platform (typing a name, "All files" on some window managers) — validation happens on
 * both sides of the boundary, never only in the picker.
 */
export async function readCvFile(filePath: string): Promise<CvFileContent> {
  const fileName = basename(filePath);
  const extension = cvFileExtension(filePath);

  if (!isSupportedCvFile(filePath)) {
    throw new Error(`unsupported CV file type ".${extension}" — expected one of: ${CV_FILE_EXTENSIONS.join(', ')}`);
  }

  // Checked from the directory entry BEFORE reading, so an accidentally-picked multi-gigabyte file
  // never lands in the main process's heap at all. Reading first and measuring the buffer
  // afterwards still spared pdf.js, but not the read itself — a large enough file would have
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
    extension === 'pdf' ? await extractPdfText(Uint8Array.from(buffer)) : buffer.toString('utf8');

  const text = normalizeText(raw);
  if (!text) {
    throw new Error(
      extension === 'pdf'
        ? `no selectable text found in "${fileName}" — it looks like a scanned image; export a text-based PDF or paste the CV as .txt`
        : `"${fileName}" is empty`,
    );
  }

  return { fileName, text };
}
