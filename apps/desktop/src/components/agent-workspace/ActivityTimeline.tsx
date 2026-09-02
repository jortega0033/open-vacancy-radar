import type { ActivityEntry } from '../../window.js';
import { HISTORY_ONLY_EXPLANATION } from './refusal-copy.js';
import type { SessionEntry } from './workspace-reducer.js';
import { hasOnlyDigestHistory } from './workspace-reducer.js';

/**
 * One session's merged timeline (ADI-07).
 *
 * Every value rendered here has already crossed two independent sanitizing rebuilds (main's
 * `agent-activity-sanitize.ts`, then preload's own), so this component's job is presentation only.
 * It still never *constructs* a sentence out of daemon-supplied data: an `error` entry renders its
 * bounded `code` as a code, not as prose, and the surrounding words come from this file.
 *
 * ## What it deliberately shows rather than hides
 *
 * - **A digest instead of text.** A history entry genuinely has no prose (the daemon's durable
 *   store is content-free by design), so it says so and shows the byte count, rather than rendering
 *   an empty bubble that reads like the agent said nothing.
 * - **Truncation.** `textTruncated` and `textOmitted` are different facts with different causes
 *   (one entry too large vs. the session's whole text budget spent) and both are stated.
 * - **A trimmed head.** When the entry cap dropped the front of the timeline, the UI says the
 *   earlier activity is gone instead of presenting a partial log as a whole one.
 *
 * No em dashes: this is all user-facing copy.
 */

export interface ActivityTimelineProps {
  entry: SessionEntry;
}

function digestLine(bytes: number, label: string): string {
  return `${label} (${bytes.toLocaleString()} bytes, content not stored)`;
}

export function ActivityTimeline({ entry }: ActivityTimelineProps) {
  const { timeline, toolNamesByAlias } = entry;

  if (timeline.entries.length === 0) {
    return (
      <p className="text-sm text-base-content/60" data-testid="timeline-empty">
        No activity has been recorded for this session yet.
      </p>
    );
  }

  return (
    <div data-testid="activity-timeline">
      {timeline.truncatedBefore !== undefined && (
        <p className="mb-3 text-xs text-base-content/60">
          Earlier activity in this session is no longer held in the app, so the list starts partway
          through.
        </p>
      )}
      {hasOnlyDigestHistory(entry) && (
        <p className="mb-3 rounded-box border border-base-300 bg-base-200 p-3 text-xs leading-relaxed">
          {HISTORY_ONLY_EXPLANATION}
        </p>
      )}
      <ol className="flex flex-col gap-2">
        {timeline.entries.map((item) => (
          <li key={item.seq} className="rounded-box border border-base-300 bg-base-100 p-3">
            <TimelineRow item={item} toolNamesByAlias={toolNamesByAlias} />
          </li>
        ))}
      </ol>
    </div>
  );
}

interface RowProps {
  item: ActivityEntry;
  toolNamesByAlias: Readonly<Record<string, string>>;
}

function RowHeading({ label, at }: { label: string; at: string }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-3">
      <span className="text-[11px] font-semibold tracking-wide text-base-content/60 uppercase">
        {label}
      </span>
      {at.length > 0 && <span className="font-mono text-[10px] text-base-content/40">{at}</span>}
    </div>
  );
}

/** The prose bubble, and each of the three honest ways prose can be absent. */
function ProseBody({
  item,
  label,
}: {
  item: Extract<ActivityEntry, { kind: 'assistant.message' | 'thinking.delta' }>;
  label: string;
}) {
  return (
    <>
      <RowHeading label={label} at={item.at} />
      {item.text !== undefined ? (
        <p className="text-sm break-words whitespace-pre-wrap">{item.text}</p>
      ) : item.textOmitted === true ? (
        <p className="text-sm text-base-content/60">
          This message is not shown because the session has already produced more text than the app
          keeps.
        </p>
      ) : item.digest !== undefined ? (
        <p className="text-sm text-base-content/60">{digestLine(item.digest.bytes, 'Message recorded')}</p>
      ) : (
        <p className="text-sm text-base-content/60">No text was recorded for this message.</p>
      )}
      {item.textTruncated === true && (
        <p className="mt-1 text-xs text-base-content/50">
          This message was longer than the app shows, so it is cut off here.
        </p>
      )}
    </>
  );
}

function TimelineRow({ item, toolNamesByAlias }: RowProps) {
  switch (item.kind) {
    case 'session.started':
      return (
        <>
          <RowHeading label="Session started" at={item.at} />
          <p className="text-sm">Running through {item.provider}.</p>
        </>
      );

    case 'status':
      return (
        <>
          <RowHeading label="Status" at={item.at} />
          <p className="text-sm">{item.status}</p>
        </>
      );

    case 'assistant.message':
      return <ProseBody item={item} label="Agent" />;

    case 'thinking.delta':
      return <ProseBody item={item} label="Thinking" />;

    case 'tool.started':
      return (
        <>
          <RowHeading label="Tool started" at={item.at} />
          <p className="text-sm">
            <span className="font-mono">{item.toolName}</span>
            {item.toolAlias !== undefined && (
              <span className="ml-2 text-xs text-base-content/50">call {item.toolAlias}</span>
            )}
          </p>
          {item.input !== undefined && (
            <p className="mt-1 text-xs text-base-content/50">{digestLine(item.input.bytes, 'Input recorded')}</p>
          )}
        </>
      );

    case 'tool.completed': {
      // A completion may legitimately carry no name of its own: the CLI already said it on the
      // matching `tool.started`, and the alias index is how the UI recovers it.
      const name =
        item.toolName ?? (item.toolAlias === undefined ? undefined : toolNamesByAlias[item.toolAlias]);
      return (
        <>
          <RowHeading label={item.isError === true ? 'Tool failed' : 'Tool finished'} at={item.at} />
          <p className="text-sm">
            <span className="font-mono">{name ?? 'Unnamed tool'}</span>
            {item.toolAlias !== undefined && (
              <span className="ml-2 text-xs text-base-content/50">call {item.toolAlias}</span>
            )}
          </p>
          {item.result !== undefined && (
            <p className="mt-1 text-xs text-base-content/50">{digestLine(item.result.bytes, 'Result recorded')}</p>
          )}
        </>
      );
    }

    case 'usage':
      return (
        <>
          <RowHeading label="Usage" at={item.at} />
          <p className="text-sm text-base-content/70">
            {[
              item.inputTokens === undefined ? undefined : `${item.inputTokens.toLocaleString()} in`,
              item.outputTokens === undefined ? undefined : `${item.outputTokens.toLocaleString()} out`,
              item.cachedInputTokens === undefined
                ? undefined
                : `${item.cachedInputTokens.toLocaleString()} cached`,
            ]
              .filter((part): part is string => part !== undefined)
              .join(' · ') || 'No token counts were reported.'}
          </p>
        </>
      );

    case 'error':
      return (
        <>
          <RowHeading label="Error" at={item.at} />
          {/* The daemon's own message never crosses the sanitizer, so there is nothing to quote.
              The bounded `code` is rendered as a code, which is what it is. */}
          <p className="text-sm">
            The agent reported an error
            {item.code === undefined ? '.' : <> (<span className="font-mono">{item.code}</span>).</>}
          </p>
          <p className="mt-1 text-xs text-base-content/50">
            {item.recoverable
              ? 'The session continued after this.'
              : 'The session could not continue after this.'}
          </p>
        </>
      );

    case 'session.completed':
      return (
        <>
          <RowHeading label="Session finished" at={item.at} />
          <p className="text-sm">The agent completed its work.</p>
        </>
      );

    case 'session.failed':
      return (
        <>
          <RowHeading label="Session failed" at={item.at} />
          <p className="text-sm">The agent stopped because of an error.</p>
        </>
      );

    case 'session.cancelled':
      return (
        <>
          <RowHeading label="Session stopped" at={item.at} />
          <p className="text-sm">This session was stopped.</p>
        </>
      );

    case 'session.interrupted':
      return (
        <>
          <RowHeading label="Session interrupted" at={item.at} />
          <p className="text-sm">
            The local runtime restarted while this session was running, so it was cut off.
          </p>
        </>
      );

    default: {
      // Exhaustive: a variant added to `ActivityBody` without a branch here is a compile error.
      const unhandled: never = item;
      void unhandled;
      return null;
    }
  }
}
