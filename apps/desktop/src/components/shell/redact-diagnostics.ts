const DIAGNOSTIC_TEXT_LIMIT = 4000;

/**
 * Strips what must not leave the machine in a pasted diagnostic or sit in a default banner: emails,
 * file paths, URLs (the helper's loopback address), bearer tokens, key=value secrets and long
 * token-looking strings. Shared by the About section's "Copy diagnostics" and the AI helper notice.
 */
export function redactDiagnosticsText(value: string): string {
  const redacted = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[redacted-email]')
    .replace(/[A-Z]:\\[^\s"'<>`]+/giu, '[redacted-path]')
    .replace(/\/(?:Users|home|usr|opt|var|tmp|etc|root)\/[^\s"'<>`]+/gu, '[redacted-path]')
    .replace(/https?:\/\/[^\s"'<>`]+/giu, '[redacted-url]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [redacted-token]')
    .replace(/\b(token|api[_-]?key|authorization|password|secret)=([^\s&]+)/giu, '$1=[redacted-secret]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, '[redacted-token]');
  return redacted.length > DIAGNOSTIC_TEXT_LIMIT
    ? `${redacted.slice(0, DIAGNOSTIC_TEXT_LIMIT)}\n[truncated]`
    : redacted;
}
