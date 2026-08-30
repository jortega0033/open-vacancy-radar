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
 * This matters here specifically because the Vacancy Leads screen renders `vacancy.url` (a value
 * that originates in a *scraped third-party job posting*) as an `<a target="_blank">`, and Electron
 * routes that click through `setWindowOpenHandler`, i.e. straight into `openExternal`. SECURITY.md's
 * Electron-hardening section described those handlers as defense in depth "for forks of this
 * boilerplate that later add [untrusted content or links]"; this fork now is one.
 *
 * Only `http:`/`https:` pass. Everything else (`file:`, `smb:`, `mailto:`, `ms-msdt:`, an unparseable
 * string) is dropped silently: there is no legitimate non-web link in this UI, and a job posting
 * that ships one is hostile input, not a feature to support.
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
