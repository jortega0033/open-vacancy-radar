/**
 * Scheme policy for `shell.openExternal`, kept in its own module (like resolve-daemon-entry.ts and
 * send-to-renderer.ts) so the decision is unit-testable without an Electron runtime.
 *
 * `shell.openExternal` hands a URL to the OS shell (`ShellExecute` on Windows, `open` on macOS),
 * which acts on far more than web links: `file:` can launch a local executable or reach a UNC path
 * (leaking an SMB credential handshake to an attacker-named host), and any protocol handler an
 * installed application has registered is reachable by name. So the URL passed to it must be
 * checked, never assumed.
 *
 * This matters here specifically because the Search page renders `vacancy.url`, a value
 * that originates in a *scraped third-party job posting*, as an `<a target="_blank">`. Electron
 * routes the click through `setWindowOpenHandler` and into `openExternal`. SECURITY.md's
 * Electron security section described those handlers as defense in depth for forks that later add
 * untrusted content or links. This application now displays such links.
 *
 * Only `http:` and `https:` pass. Other schemes (`file:`, `smb:`, `mailto:`, and `ms-msdt:`) and
 * unparseable strings are dropped silently. This UI does not support non-web links from job
 * postings.
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
