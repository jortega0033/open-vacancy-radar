import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl } from '../electron/external-url.js';

describe('isSafeExternalUrl', () => {
  it('allows the ordinary web links a vacancy actually carries', () => {
    for (const url of [
      'https://boards.greenhouse.io/acme/jobs/123',
      'https://example.invalid/jobs/1',
      'https://example.invalid/jobs/1?utm=x#apply',
      'https://example.invalid:8443/jobs/1',
      // A colon in the *path* is not userinfo, and an `@` after the host is not either. Both are
      // ordinary characters a real applicant-tracking-system URL contains.
      'https://example.invalid/jobs/1/apply?ref=a:b',
      'https://example.invalid/jobs/1#section@2',
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(true);
    }
  });

  it('refuses cleartext http:, which used to pass (ADI-16)', () => {
    for (const url of [
      'http://example.invalid/jobs/1',
      'HTTP://example.invalid/jobs/1',
      'http://example.invalid:80/jobs/1',
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });

  it('refuses embedded userinfo, which makes a hostile host wear a trusted name', () => {
    for (const url of [
      'https://user:pass@attacker.invalid/path',
      // The shape that actually fools a reader: everything before the `@` is not the host.
      'https://www.boards.greenhouse.io@attacker.invalid/acme/jobs/123',
      'https://user@attacker.invalid/path',
      // An empty username with a password is still a credential-carrying URL.
      'https://:pass@attacker.invalid/path',
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });

  it('refuses filesystem-path forms: UNC, drive-letter, rooted and protocol-relative', () => {
    for (const url of [
      '\\\\attacker.invalid\\share',
      '\\\\attacker.invalid\\share\\payload.lnk',
      '\\\\?\\C:\\Windows\\System32\\cmd.exe',
      'C:\\Windows\\System32\\cmd.exe',
      '/etc/passwd',
      '//attacker.invalid/share',
    ]) {
      expect(() => isSafeExternalUrl(url), url).not.toThrow();
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });

  it('refuses an https: URL with no host', () => {
    for (const url of ['https://', 'https://:443/', 'https://:@/']) {
      expect(() => isSafeExternalUrl(url), url).not.toThrow();
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
    // Pinned rather than assumed: WHATWG parsing folds extra slashes after a special scheme away,
    // so this is not a host-less URL at all -- it is `https://path/`, an ordinary (unresolvable)
    // host. Allowed, and worth stating so a reader does not mistake the shape for the empty-host
    // case above.
    expect(new URL('https:///path').hostname).toBe('path');
    expect(isSafeExternalUrl('https:///path')).toBe(true);
  });

  it('refuses schemes the OS shell would act on, which a scraped posting can supply', () => {
    // Every one of these is a string a hostile third-party job feed could put in `vacancy.url`;
    // the Vacancy Leads card renders it as <a target="_blank">, and Electron routes that click to
    // setWindowOpenHandler -> shell.openExternal -> ShellExecute.
    for (const url of [
      'file:///C:/Windows/System32/cmd.exe',
      'file://attacker.invalid/share/payload.lnk',
      'smb://attacker.invalid/share',
      'ms-msdt:/id PCWDiagnostic',
      'javascript:fetch("http://attacker.invalid")',
      'data:text/html,<script>1</script>',
      'mailto:someone@example.invalid',
      'vscode://file/C:/secrets',
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });

  it('refuses anything that is not a parseable absolute URL rather than throwing', () => {
    for (const url of ['', '   ', 'not a url', '/relative/path', '//protocol-relative.invalid']) {
      expect(() => isSafeExternalUrl(url)).not.toThrow();
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });

  it('is not fooled by casing or leading whitespace in the scheme', () => {
    expect(isSafeExternalUrl('HTTPS://example.invalid/jobs/1')).toBe(true);
    expect(isSafeExternalUrl('  https://example.invalid/jobs/1  ')).toBe(true);
    expect(isSafeExternalUrl('FILE:///C:/Windows/System32/cmd.exe')).toBe(false);
    expect(isSafeExternalUrl('  file:///C:/Windows/System32/cmd.exe')).toBe(false);
    // The tightening, restated at the one place a reader is looking for scheme edge cases.
    expect(isSafeExternalUrl('  HtTp://example.invalid/jobs/1')).toBe(false);
  });
});
