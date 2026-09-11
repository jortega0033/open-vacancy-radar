import type { AgentDockClient, FieldMapGenerationRequest } from '@agent-dock/client';
import type { AgentSession } from '@agent-dock/shared';

/**
 * Headless counterpart of `src/components/cv/useAgentRun.ts`, for the one caller that has no
 * renderer to run a React hook in: the application executor's own orchestration, driving the
 * Domain A field-map generation session (#196 §2, issue #201) directly from Electron main.
 *
 * Reimplements that hook's three failure disciplines rather than importing it (a renderer hook
 * can't run outside a component tree, and this runner has no `window.agentDock` IPC bridge to call
 * through -- it talks to the daemon over the same `AgentDockClient` main.ts already holds):
 *
 * - A session that never reaches a terminal event is converted into an explicit failure by
 *   `FIELD_MAP_GENERATION_TIMEOUT_MS`, matching `useAgentRun.ts`'s `RUN_TIMEOUT_MS` value.
 * - `session.completed` with no accumulated text is reported as a failure, not an empty success.
 * - Chunks are joined with `''`, never `'\n\n'`: the field-map generation prompt asks for one JSON
 *   object, which can legitimately arrive across more than one `assistant.message` event (see
 *   `useAgentRun.ts`'s own `chunkSeparator` doc comment for why inserting anything between them
 *   would corrupt the result).
 */
export const FIELD_MAP_GENERATION_TIMEOUT_MS = 240_000;

export interface FieldMapGenerationResult {
  ok: boolean;
  /** Everything the assistant returned, concatenated with no separator. Present even on failure,
   * in case a caller wants to log or inspect a partial/malformed response. */
  text: string;
  error?: string;
}

export type TextGenerationResult = FieldMapGenerationResult;

async function drainGenerationSession(
  client: AgentDockClient,
  sessionPromise: Promise<AgentSession>,
  failureLabel: string,
): Promise<TextGenerationResult> {
  const session = await sessionPromise;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FIELD_MAP_GENERATION_TIMEOUT_MS);
  let text = '';
  let fallbackError: string | undefined;
  let terminalError: string | undefined;

  try {
    for await (const event of client.sessions.events(session.id, { signal: controller.signal })) {
      switch (event.type) {
        case 'assistant.message':
          text += event.text;
          break;
        case 'error':
          if (event.recoverable) fallbackError ??= event.message;
          else terminalError = event.message;
          break;
        case 'session.failed':
          terminalError = event.message || `${failureLabel} failed`;
          break;
        case 'session.cancelled':
          terminalError = `${failureLabel} was cancelled`;
          break;
        default:
          break;
      }
      if (terminalError !== undefined) break;
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
    terminalError = `no response after ${Math.round(FIELD_MAP_GENERATION_TIMEOUT_MS / 1000)}s: the session was stopped`;
    await client.sessions.cancel(session.id).catch(() => {});
  } finally {
    clearTimeout(timeout);
  }

  if (terminalError === undefined && text.trim().length === 0) {
    terminalError = fallbackError ?? 'the agent finished without returning any text';
  }
  return { ok: terminalError === undefined, text, error: terminalError };
}

/**
 * Creates the field-map generation session and drains its event stream to completion (or failure,
 * or timeout). Never throws for an ordinary session failure -- those are reported via the returned
 * `ok`/`error` fields, matching `useAgentRun.ts`'s own convention of surfacing failures as state
 * rather than exceptions. A genuinely unexpected error (a network failure the client itself did not
 * turn into an `error` event) still propagates.
 */
export async function runFieldMapGeneration(
  client: AgentDockClient,
  input: FieldMapGenerationRequest,
): Promise<FieldMapGenerationResult> {
  return drainGenerationSession(client, client.sessions.createFieldMapGeneration(input), 'the field-map generation session');
}

export function runTextGeneration(
  client: AgentDockClient,
  input: FieldMapGenerationRequest,
): Promise<TextGenerationResult> {
  // This client capability selects the daemon's closed-tool, no-network application-generation
  // profile. Its historical name mentions field maps, but the hardening contract is generic.
  return drainGenerationSession(client, client.sessions.createFieldMapGeneration(input), 'the document generation session');
}
