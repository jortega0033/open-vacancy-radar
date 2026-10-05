const DIAGNOSTIC_TEXT_LIMIT = 4000;

/**
 * Rest of a path after its root. Folder names may contain spaces, so every segment that is followed
 * by another separator runs to that separator; the last segment stops at whitespace so sentence text
 * after the path survives. Each piece excludes the separators, so the pattern stays linear.
 */
const PATH_TAIL = String.raw`(?:[\\/][^\\/\r\n"'<>\x60:;]*(?=[\\/]))*(?:[\\/][^\s\\/"'<>\x60)]*)?`;

/** Windows profile folder, any drive: the name runs to the next separator even when it has spaces. */
const WINDOWS_PROFILE_PATH = new RegExp(String.raw`\b[A-Z]:[\\/]+Users[\\/]+[^\\/\r\n"'<>\x60]+${PATH_TAIL}`, 'giu');
const WINDOWS_PATH = new RegExp(String.raw`\b[A-Z]:(?=[\\/])${PATH_TAIL}`, 'giu');
const UNC_PATH = new RegExp(String.raw`\\\\[^\s\\/"'<>\x60]+${PATH_TAIL}`, 'gu');
const POSIX_PROFILE_PATH = new RegExp(String.raw`/(?:Users|home)/[^/\r\n"'<>\x60]+${PATH_TAIL}`, 'gu');
const TILDE_PATH = new RegExp(String.raw`(?<![\w~])~(?=[\\/])${PATH_TAIL}`, 'gu');

/**
 * Strips what must not leave the machine in a pasted diagnostic or sit in a default banner: emails,
 * file paths, URLs (the helper's loopback address), bearer tokens, key=value secrets and long
 * token-looking strings. Shared by the About section's "Copy diagnostics" and the AI helper notice.
 */
export function redactDiagnosticsText(value: string): string {
  const redacted = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[redacted-email]')
    .replace(WINDOWS_PROFILE_PATH, '[redacted-path]')
    .replace(WINDOWS_PATH, '[redacted-path]')
    .replace(UNC_PATH, '[redacted-path]')
    .replace(POSIX_PROFILE_PATH, '[redacted-path]')
    .replace(TILDE_PATH, '[redacted-path]')
    .replace(/\/(?:Users|home|usr|opt|var|tmp|etc|root)\/[^\s"'<>`]+/gu, '[redacted-path]')
    .replace(/https?:\/\/[^\s"'<>`]+/giu, '[redacted-url]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [redacted-token]')
    .replace(/\b(token|api[_-]?key|authorization|password|secret)=([^\s&]+)/giu, '$1=[redacted-secret]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, '[redacted-token]');
  return redacted.length > DIAGNOSTIC_TEXT_LIMIT
    ? `${redacted.slice(0, DIAGNOSTIC_TEXT_LIMIT)}\n[truncated]`
    : redacted;
}
