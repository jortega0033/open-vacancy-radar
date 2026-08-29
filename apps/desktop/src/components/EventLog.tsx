import type { AgentEvent } from '@agent-dock/shared';

/**
 * Renders the normalized AgentEvent stream. Every branch here is keyed on `event.type`, never
 * on which provider produced it — that's the whole point of the normalized protocol.
 */
function formatEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'session.started':
      return `session started (${event.provider})`;
    case 'status':
      return `status: ${event.status}${event.detail ? ` — ${event.detail}` : ''}`;
    case 'assistant.message':
      return event.text;
    case 'thinking.delta':
      return `(thinking) ${event.text}`;
    case 'tool.started':
      return `tool started: ${event.toolName}`;
    case 'tool.completed':
      return `tool ${event.isError ? 'failed' : 'completed'}: ${event.toolName ?? 'unknown'}`;
    case 'usage':
      return `usage — in: ${event.inputTokens ?? '?'} out: ${event.outputTokens ?? '?'}${
        event.cost !== undefined ? ` cost: $${event.cost.toFixed(4)}` : ''
      }`;
    case 'error':
      return `error: ${event.message}`;
    case 'session.completed':
      return 'session completed';
    case 'session.failed':
      return `session failed: ${event.message}`;
    case 'session.cancelled':
      return 'session cancelled';
    default:
      return JSON.stringify(event);
  }
}

// Monochrome event styling: errors get weight plus a heavy left border, success gets
// weight, cancelled fades out — hue is never used to signal state (see DESIGN-TOKENS.md).
const LINE_BASE_CLASS = 'flex gap-2 border-b border-base-200 px-1 py-0.5 last:border-b-0';

function cssClassFor(event: AgentEvent): string {
  if (event.type === 'error' || event.type === 'session.failed')
    return `${LINE_BASE_CLASS} border-l-2 border-l-base-content pl-2 font-semibold`;
  if (event.type === 'session.completed') return `${LINE_BASE_CLASS} font-semibold`;
  if (event.type === 'session.cancelled') return `${LINE_BASE_CLASS} opacity-50`;
  return LINE_BASE_CLASS;
}

export function EventLog({ events }: { events: AgentEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-box mt-3 border border-base-300 p-4 font-mono text-sm text-base-content/60">
        No events yet.
      </div>
    );
  }
  return (
    <div
      className="rounded-box mt-3 max-h-80 overflow-y-auto border border-base-300 p-2 font-mono text-xs"
      role="log"
      aria-label="session events"
    >
      {events.map((event, index) => (
        <div key={index} className={cssClassFor(event)}>
          <span className="w-36 shrink-0 text-base-content/50">{event.type}</span>
          <span className="min-w-0 break-words whitespace-pre-wrap">{formatEvent(event)}</span>
        </div>
      ))}
    </div>
  );
}
