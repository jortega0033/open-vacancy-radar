/**
 * A small label for a part of the UI that offers less than it might appear to (issue #164).
 *
 * The status words match the legend in docs/capability-matrix.md, so a badge here and a row there
 * say the same thing. Today one surface uses it: the AI Workspace start panel, for the
 * `workspace-effects` row, because a granted folder is where the agent starts and not a limit on it.
 *
 * No em dashes: user-facing copy.
 */
export type CapabilityStatus = 'partial' | 'unsupported' | 'design-target';

const STATUS_CLASS: Readonly<Record<CapabilityStatus, string>> = {
  partial: 'badge-warning',
  unsupported: 'badge-error',
  'design-target': 'badge-ghost',
};

export interface CapabilityStatusBadgeProps {
  status: CapabilityStatus;
  /** Short plain words naming the limit, for example "Not limited to the folder". */
  label: string;
  /** What the limit means in one short sentence. Shown as the tooltip. */
  detail: string;
}

export function CapabilityStatusBadge({ status, label, detail }: CapabilityStatusBadgeProps) {
  return (
    <span
      className={`badge badge-sm badge-outline ${STATUS_CLASS[status]}`}
      title={detail}
      data-testid="capability-status-badge"
      data-status={status}
    >
      {label}
    </span>
  );
}
