import type { ReactNode } from 'react';

export interface WarningBannerProps {
  /** The warning message itself. */
  children: ReactNode;
  /** Extra classes for spacing (e.g. `mt-4`). */
  className?: string;
  /** Optional inline action rendered after the message. */
  action?: ReactNode;
  /** Defaults to `alert`; use `status` for a polite, non-blocking notice. */
  role?: 'alert' | 'status';
  'aria-label'?: string;
}

/** The shared warning banner: `alert alert-warning alert-soft` with `role="alert"` baked in. */
export function WarningBanner({ children, className, action, role = 'alert', 'aria-label': ariaLabel }: WarningBannerProps) {
  return (
    <div className={['alert', 'alert-warning', 'alert-soft', 'text-sm', className].filter(Boolean).join(' ')} role={role} aria-label={ariaLabel}>
      <span>{children}</span>
      {action}
    </div>
  );
}
