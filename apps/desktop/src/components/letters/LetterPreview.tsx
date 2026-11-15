import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { LetterRecord, LetterUsageRecord, LetterVersionRecord } from '../../window.js';
import { openPdfForReview, type PdfReview } from '../cv/pdf-pages.js';
import { describeError } from '../cv/useAgentRun.js';
import { ErrorBanner, PageLoading } from '../shell/index.js';
import { buildLetterDocxBase64, buildLetterPdf, sanitizeFileName, savePdfBytes } from './export.js';
import { formatUpdatedAt, labelFor, LETTER_TYPE_OPTIONS } from './types.js';

/** A letter is a page or two; a version past this is not drawn, so an odd body cannot render without limit. */
const MAX_PREVIEW_PAGES = 20;

const USAGE_LABEL: Record<LetterUsageRecord['kind'], string> = {
  recorded: 'On record',
  prepared: 'Prepared only, no send recorded',
  linked: 'Linked only, no send recorded',
};

const PROVENANCE_LABEL: Record<NonNullable<LetterUsageRecord['provenance']>, string> = {
  prepared: 'prepared by this app',
  user_confirmed: 'you confirmed you sent it',
  receipt_backed: 'sent by this app, receipt recorded',
  unknown: 'not known which version was sent',
};

function PdfPage({ review, pageNumber }: { review: PdfReview; pageNumber: number }) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = frame.current;
    const target = canvas.current;
    if (!element || !target) return;
    let cancelled = false;
    review
      .renderPage(pageNumber, target, element.clientWidth || 600)
      .then(() => review.extractText(pageNumber))
      .then((extracted) => {
        if (!cancelled) setText(extracted);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [review, pageNumber]);

  return (
    <figure className="m-0 flex flex-col gap-1" aria-label={`Page ${pageNumber} of ${review.pageCount}`}>
      <figcaption className="text-xs text-base-content/60">
        Page {pageNumber} of {review.pageCount}
      </figcaption>
      <div ref={frame} className="w-full border border-base-300 bg-white shadow-sm">
        <canvas ref={canvas} className="block h-auto w-full" aria-hidden="true" />
      </div>
      {failed && <p className="text-xs text-error">This page could not be drawn.</p>}
      {text !== undefined && (
        <details className="text-xs">
          <summary className="cursor-pointer text-base-content/70">Page text</summary>
          <pre className="mt-1 max-w-full font-sans break-words whitespace-pre-wrap">{text}</pre>
        </details>
      )}
    </figure>
  );
}

/** Draws the given PDF bytes page by page with the CV page's pdf.js renderer (#434). */
function PdfPages({ bytes }: { bytes: Uint8Array }) {
  const [review, setReview] = useState<PdfReview | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    let opened: PdfReview | null = null;
    setReview(null);
    setError(undefined);
    openPdfForReview(bytes)
      .then((result) => {
        opened = result;
        if (cancelled) {
          void result.destroy().catch(() => undefined);
          return;
        }
        if (result.pageCount > MAX_PREVIEW_PAGES) {
          setError(`This letter is ${result.pageCount} pages long, too long to preview here. Export it to read it.`);
          return;
        }
        setReview(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err, 'could not draw the preview'));
      });
    return () => {
      cancelled = true;
      if (opened) void opened.destroy().catch(() => undefined);
    };
  }, [bytes]);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!review) return <PageLoading label="Drawing the preview…" />;
  return (
    <div className="flex flex-col gap-4" data-testid="letter-preview-pages">
      {Array.from({ length: review.pageCount }, (_, index) => (
        <PdfPage key={index + 1} review={review} pageNumber={index + 1} />
      ))}
    </div>
  );
}

export interface LetterPreviewProps {
  letter: LetterRecord;
  /** Open at this version instead of the current one (the "Open in Letters" link from an application). */
  initialVersionId?: string | null;
  onBack: () => void;
  onEdit: (letter: LetterRecord) => void;
  /** Fired after "Restore this version" saved a new current version. */
  onChanged: (letter: LetterRecord) => void;
}

/**
 * #738: a read-only view of one library letter. The pages are the exact PDF that Export PDF writes:
 * the bytes are built once per version (pinned to that version's time and hash) and the same bytes
 * are drawn here and saved by Export, so the preview cannot differ from the file.
 *
 * Every version stays readable and exportable. "Restore this version" saves an older version as a new
 * one and never rewrites history, so whatever an application recorded as sent keeps reading the same.
 */
export function LetterPreview({ letter, initialVersionId = null, onBack, onEdit, onChanged }: LetterPreviewProps) {
  const pickerId = useId();
  const [versions, setVersions] = useState<LetterVersionRecord[] | null>(null);
  const [usage, setUsage] = useState<LetterUsageRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialVersionId);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Opening the preview replaced the button that was focused; move focus to what replaced it.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [rows, uses] = await Promise.all([
          window.workspace.listLetterVersions(letter.id),
          window.workspace.listLetterUsage(letter.id).catch(() => [] as LetterUsageRecord[]),
        ]);
        if (cancelled) return;
        setVersions(rows);
        setUsage(uses);
        setLoadError(undefined);
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err, 'could not load this letter’s versions'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [letter.id, letter.currentVersionId]);

  const current = versions?.find((version) => version.id === letter.currentVersionId) ?? versions?.at(-1) ?? null;
  const requested = versions?.find((version) => version.id === selectedId) ?? null;
  const shown = requested ?? current;
  const missingRequested = versions !== null && selectedId !== null && requested === null;
  const isCurrent = shown !== null && shown.id === current?.id;

  const bytes = useMemo(
    () => (shown ? buildLetterPdf(shown.title, shown.body, { createdAt: shown.createdAt, contentHash: shown.contentHash }) : null),
    [shown],
  );

  const exportPdf = useCallback(async () => {
    if (!shown || !bytes) return;
    setActionError(undefined);
    try {
      const result = await savePdfBytes(shown.title, bytes);
      if (result.saved) setNotice(`Saved ${result.path?.split(/[/\\]/).pop() ?? 'the PDF'}.`);
    } catch (err) {
      setActionError(describeError(err, 'could not export this letter'));
    }
  }, [shown, bytes]);

  const exportDocx = useCallback(async () => {
    if (!shown) return;
    setActionError(undefined);
    try {
      const result = await window.system.saveFile({
        suggestedName: `${sanitizeFileName(shown.title)}.docx`,
        data: await buildLetterDocxBase64(shown.title, shown.body),
        encoding: 'base64',
        filters: [{ name: 'Word document', extensions: ['docx'] }],
      });
      if (result.saved) setNotice(`Saved ${result.path?.split(/[/\\]/).pop() ?? 'the document'}.`);
    } catch (err) {
      setActionError(describeError(err, 'could not export this letter'));
    }
  }, [shown]);

  const restore = useCallback(async () => {
    if (!shown || isCurrent) return;
    setBusy(true);
    setActionError(undefined);
    try {
      const updated = await window.workspace.restoreLetterVersion(letter.id, shown.id);
      setSelectedId(null);
      if (updated.currentVersionId === letter.currentVersionId) {
        setNotice(`Version ${shown.version} has the same text as the current version, so nothing was saved.`);
        return;
      }
      setNotice(
        updated.currentVersion !== null
          ? `Version ${shown.version} is now the current text, saved as version ${updated.currentVersion}.`
          : `Version ${shown.version} is now the current text.`,
      );
      onChanged(updated);
    } catch (err) {
      setActionError(describeError(err, 'could not restore this version'));
    } finally {
      setBusy(false);
    }
  }, [shown, isCurrent, letter.id, letter.currentVersionId, onChanged]);

  return (
    <section aria-label={`Preview of ${letter.title}`} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button className="btn btn-ghost btn-sm" type="button" onClick={onBack}>
          Back to library
        </button>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => void exportPdf()} disabled={!bytes}>
            Export PDF
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => void exportDocx()} disabled={!shown}>
            Export DOCX
          </button>
          {isCurrent ? (
            <button className="btn btn-primary btn-sm" type="button" onClick={() => onEdit(letter)}>
              Edit
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" type="button" onClick={() => void restore()} disabled={busy || !shown}>
              Restore this version
            </button>
          )}
        </div>
      </div>

      <header>
        {/* The selected version's own title: an older version may have had a different one. */}
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
          {shown?.title ?? letter.title}
        </h2>
        <p className="text-sm text-base-content/70">
          {[letter.company, letter.role, labelFor(LETTER_TYPE_OPTIONS, letter.type)].filter(Boolean).join(' · ')}
        </p>
        <p className="text-xs text-base-content/60">
          Created {letter.createdAt ? formatUpdatedAt(letter.createdAt) : 'date not recorded'} · Updated{' '}
          {formatUpdatedAt(letter.updatedAt)}
        </p>
      </header>

      {loadError && <ErrorBanner>{loadError}</ErrorBanner>}
      {actionError && <ErrorBanner>{actionError}</ErrorBanner>}
      {notice && (
        <p role="status" className="text-sm text-base-content/70">
          {notice}
        </p>
      )}
      {missingRequested && (
        <ErrorBanner>That version of this letter is no longer on record. Showing the current version.</ErrorBanner>
      )}

      {versions && versions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={pickerId} className="ovr-eyebrow">
            Version
          </label>
          <select
            id={pickerId}
            className="select select-sm"
            value={shown?.id ?? ''}
            onChange={(event) => {
              setNotice(undefined);
              setSelectedId(event.target.value);
            }}
          >
            {[...versions].reverse().map((version) => (
              <option key={version.id} value={version.id}>
                {`Version ${version.version} of ${versions.length}, ${formatUpdatedAt(version.createdAt)}${version.id === current?.id ? ' (current)' : ''}`}
              </option>
            ))}
          </select>
          {!isCurrent && <span className="badge badge-outline">Older version, read-only</span>}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div>{versions === null && !loadError ? <PageLoading label="Loading the letter…" /> : bytes && <PdfPages bytes={bytes} />}</div>

        <aside aria-label="Used in" className="rounded-box border border-base-300 p-3 text-sm">
          <h3 className="font-semibold">Used in</h3>
          {usage.length === 0 ? (
            <p className="mt-1 text-xs text-base-content/70">No application records or links name this letter.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {usage.map((use, index) => (
                <li key={`${use.kind}-${use.applicationId ?? use.attemptId ?? 'none'}-${index}`} className="text-xs">
                  <span className="font-medium">{[use.role, use.company].filter(Boolean).join(' at ') || 'Application'}</span>
                  <br />
                  <span className="text-base-content/70">
                    {USAGE_LABEL[use.kind]}
                    {use.version !== null ? `, version ${use.version}` : ''}
                    {use.kind === 'recorded' && use.provenance ? ` (${PROVENANCE_LABEL[use.provenance]})` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </section>
  );
}
