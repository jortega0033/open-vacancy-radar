import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Local SVG URL. Rendered as a mask so its `currentColor` artwork follows every app theme. */
  illustration?: string;
  /** Optional call to action, such as a button or link under the copy. */
  action?: ReactNode;
}

/**
 * The shared empty-state block for an empty table, an unrun search, or an unavailable feature.
 *
 * Its job is to say what the space is for, never to imply the app can do something it cannot.
 */
export function EmptyState({ title, description, illustration, action }: EmptyStateProps) {
  return (
    <div className="flex min-h-64 items-center justify-center p-8">
      <div className="max-w-md text-center">
        {illustration && (
          <span
            className="mb-5 inline-block size-36 max-w-full text-base-content/35"
            data-testid="empty-state-illustration"
            aria-hidden="true"
            style={{
              backgroundColor: 'currentColor',
              WebkitMask: `url("${illustration}") center / contain no-repeat`,
              mask: `url("${illustration}") center / contain no-repeat`,
            }}
          />
        )}
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="mt-1.5 text-sm text-base-content/60">{description}</p>}
        {action && <div className="mt-4 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}
