import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { CvDocumentRecord } from '../../window.js';
import { CvDrawer, type CvDrawerSubmitPayload } from '../cv-library/CvDrawer.js';

/**
 * The in-place recovery for a tailoring stop that is only waiting on the CV's source review (#756).
 *
 * The default Welcome path saves an uploaded CV without reading it into reviewed records, so the
 * first Apply fails with "no reviewed source record" and nothing on the page could fix it: the
 * primary action was Try again, which fails identically, and the actual fix lived on the CV page.
 * This hook opens the exact same review drawer the CV page uses (`CvDrawer`), over whatever is on
 * screen, with the read started, and reports back once the person has confirmed and saved. The
 * selected application stays put underneath; the caller resumes tailoring on `onReviewed`.
 *
 * Nothing here bypasses the review: the drawer's Save is what stamps `reviewedAt`, exactly as it
 * does on the CV page, and an unreviewed extraction never reaches tailoring.
 */
export interface CvReviewDrawerOptions {
  /** The CV the application was started from; null means the library's default CV. */
  sourceCvId: string | null;
  /** Called after the review was saved. The drawer is already closed by then. */
  onReviewed: () => void;
}

export interface CvReviewDrawer {
  /** Loads the CV and opens the review. Safe to call again while open (no-op). */
  open: () => Promise<void>;
  /** True while the CV is being read from the library, before the drawer shows. */
  loading: boolean;
  /** Why the review could not open (the CV is gone), for the caller to show. */
  error: string | null;
  /** Mount this where the drawer should live; null while closed. */
  drawer: ReactNode;
}

async function resolveCv(sourceCvId: string | null): Promise<CvDocumentRecord | undefined> {
  const documents = await window.workspace.listCvDocuments();
  if (sourceCvId) return documents.find((doc) => doc.id === sourceCvId);
  const settings = await window.workspace.getSettings();
  return documents.find((doc) => doc.id === settings.defaultCvId) ?? documents.find((doc) => doc.isDefault);
}

export function useCvReviewDrawer({ sourceCvId, onReviewed }: CvReviewDrawerOptions): CvReviewDrawer {
  const [record, setRecord] = useState<CvDocumentRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onReviewedRef = useRef(onReviewed);
  onReviewedRef.current = onReviewed;

  const open = useCallback(async () => {
    if (record || loading) return;
    setLoading(true);
    setError(null);
    try {
      const found = await resolveCv(sourceCvId);
      if (!found) {
        setError('The CV this application was started from is no longer in your library.');
        return;
      }
      setRecord(found);
    } catch {
      setError('We could not open your CV for review.');
    } finally {
      setLoading(false);
    }
  }, [record, loading, sourceCvId]);

  const handleSubmit = useCallback(
    async (payload: CvDrawerSubmitPayload) => {
      if (!record) return;
      await window.workspace.updateCvDocument(record.id, payload);
      setRecord(null);
      onReviewedRef.current();
    },
    [record],
  );

  const drawer = record ? (
    <CvDrawer
      key={record.id}
      mode="edit"
      record={record}
      autoReadSource
      onCancel={() => setRecord(null)}
      onSubmit={handleSubmit}
    />
  ) : null;

  return { open, loading, error, drawer };
}

export interface CvReviewRequiredNoticeProps {
  busy: boolean;
  loading: boolean;
  error: string | null;
  onReview: () => void;
  onUseOriginal: () => void;
}

/**
 * One line and the one button that fixes it. "Try again" is deliberately absent: with nothing
 * changed, a retry fails the same way, so offering it as the main action was the dead end #756
 * describes. Using the CV as it is stays available, as it was.
 */
export function CvReviewRequiredNotice({ busy, loading, error, onReview, onUseOriginal }: CvReviewRequiredNoticeProps) {
  return (
    <div className="space-y-3" data-testid="cv-review-required">
      <p className="text-sm text-base-content/70">
        Your CV needs one review before it can be tailored. The app reads your CV into records, you check them, and
        tailoring continues from here.
      </p>
      {error && (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={busy || loading} onClick={onReview}>
          {loading && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
          Review this CV
        </button>
        <button type="button" className="btn btn-outline" disabled={busy || loading} onClick={onUseOriginal}>
          Use my CV as it is
        </button>
      </div>
    </div>
  );
}
