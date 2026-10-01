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
 * ## The four rules (ADI-16 tightened this from "http: or https:")
 *
 * A URL passes only if it is an **absolute** URL that:
 *
 *  1. uses `https:`. `http:` used to pass too, and no longer does. A cleartext link handed to the OS
 *     browser is a link whose destination any machine on the path can rewrite, and the value being
 *     handed over came from a scraped third-party page in the first place -- so the one case it
 *     buys (a job board that still serves plaintext) is exactly the case where the redirect chain is
 *     least worth trusting. Every real job board has served HTTPS for years; a posting that insists
 *     on `http:` is hostile input or dead, not a feature to support.
 *  2. has a **non-empty host**. `https:` cannot parse without one, but the check is written out
 *     rather than assumed, so that a future edit re-admitting another scheme cannot silently allow
 *     the host-less forms that scheme permits.
 *  3. carries **no embedded userinfo**. `https://www.trusted-jobs.example@attacker.invalid/` is a URL
 *     whose *host* is `attacker.invalid` and whose visible prefix is a brand the user recognizes:
 *     the browser will show the real host, but the decision to open it has already been made by
 *     then, and nothing in this app has any use for HTTP basic-auth credentials in a link.
 *  4. is **not a filesystem path**. UNC (`\\host\share`), a drive path (`C:\...`), a rooted path
 *     (`/etc/passwd`) and a protocol-relative reference (`//host/x`) are all rejected -- the first
 *     three because `new URL` refuses a string with no scheme, and the drive-letter form because
 *     `c:` is not `https:`. Rule 1 is what actually stops these; the test table pins each shape so a
 *     later loosening of the scheme check cannot quietly re-open them.
 *
 * Everything else (`file:`, `smb:`, `mailto:`, `ms-msdt:`, an unparseable string) is dropped
 * silently: there is no legitimate non-web link in this UI.
 */
export function isSafeExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    // No base argument, so this parses absolute URLs only: a bare path, a UNC path and a
    // protocol-relative reference all throw here rather than being resolved against something.
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname === '') return false;
  // Both halves, not just `username`: `https://:pass@host/` has an empty username and is still a
  // credential-carrying URL.
  if (parsed.username !== '' || parsed.password !== '') return false;
  return true;
}
