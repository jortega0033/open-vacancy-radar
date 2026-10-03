import { useState } from 'react';
import { parseTailoringSummary, formatRemovalSummary } from './tailoring-summary-parser.js';

export interface TailoringSummaryProps {
  detail: string;
}

export function TailoringSummary({ detail }: TailoringSummaryProps) {
  const [showDetails, setShowDetails] = useState(false);
  const parsed = parseTailoringSummary(detail);

  if (!parsed.hasRemovals) {
    return <p className="mt-1 text-xs text-base-content/70">{parsed.base}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-base-content/70">{parsed.base} {formatRemovalSummary(parsed.removedGroups)}, so they were left out.</p>
      <details
        className="group"
        open={showDetails}
        onToggle={(e) => setShowDetails((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-xs text-primary hover:underline">
          Show which {formatItemLabels(parsed.removedGroups)}
        </summary>
        <div className="mt-2 flex flex-col gap-2 rounded-box border border-base-300 bg-base-200 p-2 text-xs">
          {parsed.removedGroups.map((group) => (
            <div key={group.kind}>
              <p className="font-medium text-base-content/80">
                {group.count} {group.label}
              </p>
              <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-base-content/60">
                {group.items.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
          <p className="mt-1 text-xs text-base-content/60">
            Add these to your CV if they are true.
          </p>
        </div>
      </details>
    </div>
  );
}

function formatItemLabels(groups: ReturnType<typeof parseTailoringSummary>['removedGroups']): string {
  const labels = groups.map((g) => g.label);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return labels.slice(0, -1).join(', ') + `, and ${labels[labels.length - 1]}`;
}
