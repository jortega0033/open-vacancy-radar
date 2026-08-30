import { agentEventEnvelopeSchema, type AgentEventEnvelope } from '@agent-dock/shared';
import { ValidationError } from './errors.js';

/**
 * Incrementally parses the daemon's SSE byte stream into validated `AgentEventEnvelope` objects.
 * The internal buffer holds only an in-progress frame that is not yet newline-terminated, not
 * the whole stream. A long-running session therefore cannot grow client-side memory without bound.
 *
 * A frame that isn't valid JSON, or is valid JSON that doesn't match the protocol v1 schema,
 * throws a `ValidationError` and ends the generator. A malformed daemon event is a contract
 * violation and is not skipped.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<AgentEventEnvelope, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);

  try {
    while (true) {
      if (signal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf('\n\n')) >= 0) {
        const rawFrame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const dataLine = rawFrame.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue; // comment/keepalive frame (e.g. the daemon's leading ":ok")

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(dataLine.slice('data: '.length));
        } catch (err) {
          throw new ValidationError(`Received a malformed SSE frame from the daemon: ${(err as Error).message}`);
        }

        const result = agentEventEnvelopeSchema.safeParse(parsedJson);
        if (!result.success) {
          throw new ValidationError(
            `Received an event that does not match the AgentEvent protocol: ${result.error.message}`,
          );
        }
        yield result.data;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
