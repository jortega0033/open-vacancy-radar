/**
 * A closed, reviewed set of reasons the Codex app-server JSON-RPC peer (`rpc.ts`) or the process
 * that owns it (`managed-process.ts`) can fail. Ported from upstream AgentDock's
 * `providers/codex/app-server/errors.ts` -- the reason-code union and constructor shape are
 * unchanged; only the `boundedUtf8`/`safeDisplay` helpers below differ from upstream, which
 * re-exports them from a shared `providers/common/safe-display.ts` module. That module does not
 * exist in this repo (verified: no other provider adapter here has an analogous need for it yet),
 * so the two helpers are defined locally instead of speculatively creating a new shared module with
 * a single caller -- promote them to `providers/common/` if a second real caller ever needs them.
 */
export class CodexAppServerProtocolError extends Error {
  constructor(
    readonly code:
      | 'closed'
      | 'forbidden_method'
      | 'frame_invalid'
      | 'frame_too_large'
      | 'interaction_invalid'
      | 'process_failed'
      | 'response_invalid'
      | 'state_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'CodexAppServerProtocolError';
  }
}

/** Truncates `value` to at most `maximumBytes` UTF-8 bytes without splitting a multi-byte
 * character in half (walks back over any UTF-8 continuation bytes at the cut point). */
export function boundedUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString('utf8');
}

/**
 * Renders an untrusted, provider-controlled value safely for a log line or an error message: not a
 * string (or empty) becomes `fallback`; control and format characters (which could otherwise forge
 * a fake log line or hide content) are replaced with a space; the result is byte-bounded via
 * `boundedUtf8`. Never pass raw process stderr or a provider's free-text field to a logger without
 * this -- see `managed-process.ts`'s `redactStderr`, which relies on never doing so.
 */
export function safeDisplay(value: unknown, maximumBytes: number, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const printable = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(character) ? ' ' : character;
  }).join('');
  return boundedUtf8(printable, maximumBytes);
}
