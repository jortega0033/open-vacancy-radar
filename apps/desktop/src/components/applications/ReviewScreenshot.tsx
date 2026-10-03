import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from '../shell/Dialog.js';

export interface ReviewScreenshotProps {
  screenshotBase64: string;
  alt: string;
  /** Classes for the box the preview image sits in. The compact layout passes a height cap and
   * scroll; the two-pane layout passes none, so the image gets the pane's full width (#469). */
  frameClassName?: string;
}

/**
 * The form screenshot with a "View full size" action. Full size shows the capture at its own pixel
 * dimensions in a scrollable overlay, never stretched, so a low-resolution capture is not made to
 * look sharper than it is.
 *
 * The overlay is portalled to `document.body`: the review dialog's box is transformed while it
 * opens, and a transformed ancestor would turn `position: fixed` into "fixed inside the dialog".
 * It registers with `useEscapeToClose`, so Escape closes only the overlay and leaves the review
 * open, and it hands focus back to the button that opened it.
 */
export function ReviewScreenshot({ screenshotBase64, alt, frameClassName = '' }: ReviewScreenshotProps) {
  const [fullSize, setFullSize] = useState(false);
  const src = `data:image/png;base64,${screenshotBase64}`;

  return (
    <>
      <div className={`border-base-300 bg-base-200 ${frameClassName}`}>
        <img src={src} alt={alt} className="w-full" draggable={false} />
      </div>
      <div className="flex justify-end border-t border-base-300 bg-base-100 px-3 py-2">
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => setFullSize(true)}>
          View full size
        </button>
      </div>
      {fullSize
        ? createPortal(
            <FullSizeScreenshot
              src={src}
              alt={`${alt} at original size`}
              onClose={() => setFullSize(false)}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function FullSizeScreenshot({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  return (
    <Dialog
      aria-label="Form screenshot at original size"
      boxClassName="flex h-screen max-h-none w-screen max-w-none flex-col rounded-none p-0"
      onClose={onClose}
    >
      <div className="flex items-center justify-between gap-3 border-b border-base-300 px-4 py-2">
        <p className="text-sm font-semibold">Form screenshot at original size</p>
        <button data-autofocus="" type="button" className="btn btn-outline btn-sm" onClick={onClose}>
          Close full size view
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-base-200">
        <img src={src} alt={alt} className="block max-w-none" draggable={false} />
      </div>
    </Dialog>
  );
}
