import { agentEventEnvelopeSchema, utf8ByteLength, type AgentEventEnvelope } from '@agent-dock/shared';
import { ValidationError } from './errors.js';

/** Mirrors the daemon's own per-envelope ceiling (`session-manager.ts`'s
 * `MAX_EVENT_ENVELOPE_BYTES`, ADI-17): a well-behaved daemon never emits a frame this large, since
 * it fails the session itself first. This is defense in depth against one that doesn't -- without
 * it, a buggy or compromised daemon streaming one arbitrarily long line with no `\n\n` terminator
 * would grow this client's buffer without limit, exactly the class of bug ADI-17 closes server-side. */
const MAX_SSE_FRAME_BYTES = 1024 * 1024;

/**
 * Incrementally parses the daemon's SSE byte stream into validated `AgentEventEnvelope` objects.
 * The internal buffer only ever holds an in-progress (not yet newline-terminated) frame, never
 * the whole stream, so a long-running session can't grow unbounded client-side memory -- and that
 * in-progress frame is itself bounded by `MAX_SSE_FRAME_BYTES`, checked after every chunk read, so
 * even a frame that never terminates cannot grow the buffer past the same limit.
 *
 * A frame that isn't valid JSON, is valid JSON that doesn't match the protocol v1 schema, or simply
 * exceeds the byte ceiling, throws a `ValidationError` and ends the generator: any of these from
 * the daemon is a contract violation worth surfacing loudly, not silently skipping.
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

        if (utf8ByteLength(rawFrame) > MAX_SSE_FRAME_BYTES) {
          throw new ValidationError(`received an SSE frame from the daemon exceeding the ${MAX_SSE_FRAME_BYTES}-byte limit`);
        }

        const dataLine = rawFrame.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue; // comment/keepalive frame (e.g. the daemon's leading ":ok")

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(dataLine.slice('data: '.length));
        } catch (err) {
          throw new ValidationError(`received a malformed SSE frame from the daemon: ${(err as Error).message}`);
        }

        const result = agentEventEnvelopeSchema.safeParse(parsedJson);
        if (!result.success) {
          throw new ValidationError(
            `received an event that does not match the AgentEvent protocol: ${result.error.message}`,
          );
        }
        yield result.data;
      }

      // Whatever is left is an in-progress frame with no terminator yet -- bounded the same way a
      // completed frame is, so a daemon that never sends `\n\n` at all cannot grow this buffer
      // without limit across however many more reads follow.
      if (utf8ByteLength(buffer) > MAX_SSE_FRAME_BYTES) {
        throw new ValidationError(`received SSE data from the daemon with no frame terminator within the ${MAX_SSE_FRAME_BYTES}-byte limit`);
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
