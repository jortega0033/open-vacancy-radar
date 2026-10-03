import { useCallback, useEffect, useRef, useState } from 'react';
import type { CvArtifactRecord, CvEvidenceOverlayRecord } from '../../window.js';
import { describeError } from './useAgentRun.js';
import { openPdfForReview, type PdfReview } from './pdf-pages.js';
import { ErrorBanner } from '../shell/index.js';

/** More pages than any CV the app exports (the acceptance contract caps a CV at four). A file past
 * this is not drawn here at all, so a replaced or odd file cannot make the panel render without limit. */
export const MAX_REVIEW_PAGES = 12;

export interface CvPdfPageReviewProps {
  overlayId: string;
  artifact: CvArtifactRecord;
  onOverlayChange: (overlay: CvEvidenceOverlayRecord) => void;
}

interface ReviewPageProps {
  review: PdfReview;
  pageNumber: number;
  onDrawn: (pageNumber: number) => void;
  onFailed: (message: string) => void;
}

/**
 * One page, drawn only when it scrolls into view. A page counts as shown once its canvas has been
 * painted and its text was read from the same PDF into an "Extracted text" disclosure (WCAG 1.1.1,
 * #458), so a canvas scrolled past is not enough: a page with no readable text fails the review
 * instead of counting. A page is a placeholder of the right proportions until then, so the list
 * does not jump while it fills.
 */
function ReviewPage({ review, pageNumber, onDrawn, onFailed }: ReviewPageProps) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  const [text, setText] = useState<string>();

  useEffect(() => {
    const element = frame.current;
    const target = canvas.current;
    if (!element || !target) return;
    let cancelled = false;
    let started = false;
    const draw = () => {
      if (started) return;
      started = true;
      review
        .renderPage(pageNumber, target, element.clientWidth)
        .then(() => review.extractText(pageNumber))
        .then((extracted) => {
          if (cancelled) return;
          if (extracted.trim() === '') {
            throw new Error(`page ${pageNumber} has no text that a screen reader can read, so it cannot be reviewed here. Export it again`);
          }
          setText(extracted);
          setDrawn(true);
          onDrawn(pageNumber);
        })
        .catch((err: unknown) => {
          if (!cancelled) onFailed(describeError(err, `page ${pageNumber} could not be drawn`));
        });
    };
    if (typeof IntersectionObserver === 'undefined') {
      draw();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          draw();
          observer.disconnect();
        }
      },
      { threshold: 0.05 },
    );
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [review, pageNumber, onDrawn, onFailed]);

  return (
    <figure className="m-0 flex shrink-0 flex-col gap-1" aria-label={`Page ${pageNumber} of ${review.pageCount}`}>
      <figcaption className="text-xs text-base-content/60">
        Page {pageNumber} of {review.pageCount}
        {drawn ? '' : ', not shown yet'}
      </figcaption>
      <div ref={frame} className="w-full border border-base-300 bg-white" style={drawn ? undefined : { aspectRatio: '1 / 1.414' }}>
        <canvas ref={canvas} className="block h-auto w-full" data-drawn={drawn ? 'true' : 'false'} />
      </div>
      {text !== undefined && (
        <details className="text-xs">
          <summary className="cursor-pointer text-base-content/70">Extracted text</summary>
          <pre className="mt-1 max-w-full font-sans break-words whitespace-pre-wrap">{text}</pre>
        </details>
      )}
    </figure>
  );
}

/**
 * The in-app read of a saved PDF's pages (#434). The main process returns the file's bytes only after
 * checking them against the hash recorded at export, and this draws every page in a scroll area inside
 * the panel (no horizontal scroll at the minimum window width, since each page is scaled to the panel).
 * Each page also carries its extracted text, read from the same bytes. When the last page has been
 * painted and its text read, this tells the main process how many pages were shown, which is
 * what unlocks accepting the PDF there. A file that cannot be read, drawn, read as text (an
 * image-only page) or has too many pages shows its reason and leaves accepting locked.
 */
export function CvPdfPageReview({ overlayId, artifact, onOverlayChange }: CvPdfPageReviewProps) {
  const [review, setReview] = useState<PdfReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const reviewRef = useRef<PdfReview | null>(null);
  const reported = useRef(false);
  const alreadyViewed = artifact.pagesViewedAt !== '';

  useEffect(
    () => () => {
      const open = reviewRef.current;
      reviewRef.current = null;
      if (open) void open.destroy().catch(() => undefined);
    },
    [],
  );

  const onDrawn = useCallback((pageNumber: number) => {
    setShown((previous) => (previous.has(pageNumber) ? previous : new Set(previous).add(pageNumber)));
  }, []);
  // A page that cannot be drawn ends this attempt: the list goes away and the reason stays, with a
  // button to try again, so a half-drawn document is never left looking like a readable one.
  const onFailed = useCallback((message: string) => {
    setError(message);
    const open = reviewRef.current;
    reviewRef.current = null;
    setReview(null);
    if (open) void open.destroy().catch(() => undefined);
  }, []);

  const pageCount = review?.pageCount ?? 0;
  useEffect(() => {
    if (!review || alreadyViewed || reported.current || shown.size < pageCount) return;
    reported.current = true;
    window.workspace
      .markCvArtifactPagesViewed(overlayId, artifact.artifactId, pageCount)
      .then(onOverlayChange)
      .catch((err: unknown) => {
        reported.current = false;
        setError(describeError(err, 'could not record that the pages were shown'));
      });
  }, [review, alreadyViewed, shown, pageCount, overlayId, artifact.artifactId, onOverlayChange]);

  async function load() {
    setLoading(true);
    setError(undefined);
    setShown(new Set());
    reported.current = false;
    try {
      const bytes = await window.workspace.readCvArtifactBytes(overlayId, artifact.artifactId);
      const opened = await openPdfForReview(bytes);
      if (opened.pageCount > MAX_REVIEW_PAGES) {
        await opened.destroy().catch(() => undefined);
        throw new Error(`this PDF is too long to preview here. Include fewer projects and export again`);
      }
      if (artifact.validation.pageCount !== undefined && opened.pageCount !== artifact.validation.pageCount) {
        await opened.destroy().catch(() => undefined);
        throw new Error(`this file changed since it was exported. Export it again`);
      }
      const previous = reviewRef.current;
      reviewRef.current = opened;
      if (previous) void previous.destroy().catch(() => undefined);
      setReview(opened);
    } catch (err) {
      setReview(null);
      setError(describeError(err, 'could not show this PDF'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2" aria-label="PDF page review">
      {!review && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-outline" onClick={() => void load()} disabled={loading}>
            {loading && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
            {error ? 'Try showing the pages again' : 'Show the pages here'}
          </button>
        </div>
      )}
      {review && (
        <>
          <p className="text-xs text-base-content/60" role="status" aria-label="Pages shown">
            {alreadyViewed ? `All ${pageCount} ${pageCount === 1 ? 'page was' : 'pages were'} shown.` : `Page ${Math.min(shown.size, pageCount)} of ${pageCount}. Scroll to read each page.`}
          </p>
          <div
            className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto overflow-x-hidden rounded-box border border-base-300 p-2"
            role="region"
            aria-label="PDF pages"
            tabIndex={0}
          >
            {Array.from({ length: pageCount }, (_unused, index) => (
              <ReviewPage key={index + 1} review={review} pageNumber={index + 1} onDrawn={onDrawn} onFailed={onFailed} />
            ))}
          </div>
        </>
      )}
      {error && (
        <ErrorBanner>
          {error}
        </ErrorBanner>
      )}
    </div>
  );
}
