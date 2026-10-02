import { useEffect, useRef, useState } from 'react';

export interface CopyButtonProps {
  /** What lands on the clipboard. */
  text: string;
  /** The visible and accessible name. Pass a specific one ("Copy install command") when a page has several. */
  label?: string;
  className?: string;
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * A button that copies `text` and says what happened next to itself. `navigator.clipboard` can
 * reject (permission, no focus), so a failure is shown rather than swallowed.
 */
export function CopyButton({ text, label = 'Copy', className = 'btn btn-xs btn-outline' }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  };

  return (
    <>
      <button type="button" className={className} onClick={() => void copy()}>
        {label}
      </button>
      {state === 'copied' && (
        <span className="text-xs" role="status">
          Copied
        </span>
      )}
      {state === 'failed' && (
        <span className="text-xs text-error" role="alert">
          Could not copy to the clipboard
        </span>
      )}
    </>
  );
}
