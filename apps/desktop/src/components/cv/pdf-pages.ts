import { getResolvedPDFJS } from 'unpdf';

/**
 * Draws the pages of a saved PDF onto canvases in the renderer (#434), with the pdf.js that `unpdf`
 * already ships for CV import: no native canvas, no extra dependency, nothing added to the installer.
 *
 * The unpdf build bundles pdf.js's worker code and registers it on `globalThis.pdfjsWorker`, so pdf.js
 * runs its parser in the renderer's own thread and never starts a `Worker` or loads a worker file.
 * That is what makes it work under the renderer's `script-src 'self'` policy and from inside the
 * packaged asar without any `workerSrc` setting. A CV is a few pages, so the main-thread parse is
 * short. Fonts are drawn as glyph paths (`disableFontFace`) because the policy has no `font-src` for
 * `blob:` or `data:` fonts.
 */

export interface PdfReview {
  pageCount: number;
  /** Draws one page (1-based) onto `canvas`, sized to `cssWidth` CSS pixels at the device pixel ratio. */
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void>;
  destroy(): Promise<void>;
}

/** Largest canvas edge drawn, in device pixels. Keeps a hostile page size from allocating a huge bitmap. */
const MAX_CANVAS_EDGE = 3000;

export async function openPdfForReview(bytes: Uint8Array): Promise<PdfReview> {
  const { getDocument } = await getResolvedPDFJS();
  // pdf.js takes ownership of the array it is given, so it gets a copy.
  const task = getDocument({
    data: Uint8Array.from(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    useWorkerFetch: false,
  });
  const pdf = await task.promise;

  return {
    pageCount: pdf.numPages,
    async renderPage(pageNumber, canvas, cssWidth) {
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const scale = Math.min((Math.max(cssWidth, 1) * ratio) / base.width, MAX_CANVAS_EDGE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      page.cleanup();
    },
    async destroy() {
      await task.destroy();
    },
  };
}
