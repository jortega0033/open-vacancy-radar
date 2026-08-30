import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl } from '../electron/external-url.js';

describe('isSafeExternalUrl', () => {
  it('allows the ordinary web links a vacancy actually carries', () => {
    for (const url of [
      'https://boards.greenhouse.io/acme/jobs/123',
      'http://example.invalid/jobs/1',
      'https://example.invalid/jobs/1?utm=x#apply',
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(true);
    }
  });

  it('refuses schemes the OS shell would act on, which a scraped posting can supply', () => {
    // Every one of these is a string a hostile third-party job feed could put in `vacancy.url`;
    // the Search page renders it as <a target="_blank">, and Electron routes that click to
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
    expect(isSafeExternalUrl('FILE:///C:/Windows/System32/cmd.exe')).toBe(false);
    expect(isSafeExternalUrl('  file:///C:/Windows/System32/cmd.exe')).toBe(false);
  });
});
