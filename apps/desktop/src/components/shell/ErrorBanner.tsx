import type { ReactNode } from 'react';

export interface ErrorBannerProps {
  /** The error message itself. */
  children: ReactNode;
  /** Extra classes for spacing (e.g. `mt-4`), so each call site keeps its own layout rhythm. */
  className?: string;
  /** Optional inline action rendered after the message, e.g. a "Retry" button. */
  action?: ReactNode;
}

/**
 * The shared error banner: `alert alert-error alert-soft` with `role="alert"` always baked in.
 *
 * Before this, the same failure state rendered two different ways across pages -- a soft, muted
 * treatment on some, a plain (harsher) `alert-error` on others -- and `role="alert"` was present on
 * some and silently missing on others, which is an accessibility gap, not just a visual one: a
 * screen reader user gets no announcement at all from the sites missing it. This component makes
 * both of those impossible to get wrong at a call site.
 */
export function ErrorBanner({ children, className, action }: ErrorBannerProps) {
  return (
    <div className={['alert', 'alert-error', 'alert-soft', 'text-sm', className].filter(Boolean).join(' ')} role="alert">
      <span>{children}</span>
      {action}
    </div>
  );
}
