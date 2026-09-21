import { ConfirmDialog } from '../shell/ConfirmDialog.js';
import type { UseCvPicker } from './useCvPicker.js';

export interface CvTranscriptionFlowProps {
  picker: UseCvPicker;
}

/**
 * Renders whichever step of the AI-transcription fallback (issue #396) is active in `picker.state`,
 * or nothing at all for `'idle'`/`'picking'`/`'done'` -- the caller (`CvUpload`/`CvUploadAction`)
 * already knows how to render those. Shared by both so the consent, review, and error UI is defined
 * once rather than duplicated across the two upload entry points this fallback applies to.
 */
export function CvTranscriptionFlow({ picker }: CvTranscriptionFlowProps) {
  const { state } = picker;

  if (state.phase === 'consent') {
    return (
      <ConfirmDialog
        title="Transcribe with AI?"
        message={
          <>
            &ldquo;{state.fileName}&rdquo; has no selectable text. It looks like a scanned image. {state.providerLabel}{' '}
            can transcribe it for you, but that means sending the original PDF file to your configured{' '}
            {state.providerLabel} CLI for this one operation. The transcribed text will be shown to you for review
            before anything is saved.
          </>
        }
        confirmLabel="Send for transcription"
        onConfirm={picker.confirmTranscription}
        onCancel={picker.declineTranscription}
      />
    );
  }

  if (state.phase === 'transcribing') {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-base-content/70" role="status">
        <span className="loading loading-spinner loading-xs" aria-hidden="true" />
        <span>
          Transcribing &ldquo;{state.fileName}&rdquo;&hellip;
        </span>
        <button className="btn btn-ghost btn-xs" type="button" onClick={picker.cancel}>
          Cancel
        </button>
      </div>
    );
  }

  if (state.phase === 'review') {
    return (
      <div className="flex flex-col gap-2 rounded-box border border-base-300 bg-base-200/40 p-3">
        <p className="text-sm">
          Review the transcribed text below before saving it. A vision model can misread dates, employers, or
          technologies, so check it over and correct anything that looks wrong.
        </p>
        <textarea
          className="textarea textarea-bordered h-48 w-full font-mono text-xs"
          aria-label="transcribed CV text"
          value={picker.reviewText}
          onChange={(event) => picker.setReviewText(event.target.value)}
        />
        <div className="flex gap-2">
          <button
            className="btn btn-primary btn-sm"
            type="button"
            onClick={picker.confirmReview}
            disabled={picker.reviewText.trim().length === 0}
          >
            Looks correct, use this text
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={picker.cancel}>
            Discard
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === 'unavailable') {
    return (
      <div className="alert alert-warning flex items-center justify-between text-sm" role="alert">
        <span>
          {state.reason === 'too-many-pages'
            ? `"${state.fileName}" has too many pages for automatic transcription. Export a text-based PDF or paste the CV as .txt instead.`
            : `"${state.fileName}" looks like a scanned image with no selectable text. Your configured AI runtime can't accept file attachments right now, so automatic transcription isn't available. Export a text-based PDF or paste the CV as .txt instead.`}
        </span>
        <button className="btn btn-ghost btn-xs" type="button" onClick={picker.reset}>
          Dismiss
        </button>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="alert alert-error flex items-center justify-between text-sm" role="alert">
        <span>{state.message}</span>
        <button className="btn btn-ghost btn-xs" type="button" onClick={picker.reset}>
          Dismiss
        </button>
      </div>
    );
  }

  return null;
}
