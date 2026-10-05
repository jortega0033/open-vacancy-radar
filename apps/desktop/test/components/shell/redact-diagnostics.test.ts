import { describe, expect, it } from 'vitest';
import { redactDiagnosticsText } from '../../../src/components/shell/redact-diagnostics.js';

const LEAKS = ['Jane', 'Doe', 'jane', 'AppData', 'Documents', 'server', 'share'];

function expectNoLeak(output: string, fragments: string[] = LEAKS): void {
  for (const fragment of fragments) expect(output).not.toContain(fragment);
}

describe('redactDiagnosticsText paths', () => {
  it('redacts a Windows profile folder that contains a space', () => {
    const out = redactDiagnosticsText('C:\\Users\\Jane Doe\\AppData\\Roaming\\x');
    expect(out).toBe('[redacted-path]');
    expectNoLeak(out);
  });

  it('redacts a profile folder with a space at the end of the path', () => {
    expectNoLeak(redactDiagnosticsText('cwd C:\\Users\\Jane Doe'));
  });

  it('handles other drives, forward slashes and mixed case', () => {
    for (const input of ['D:\\users\\Jane Doe\\x', 'c:/USERS/Jane Doe/Documents/cv.pdf', 'E:\\Users/Jane Doe\\AppData\\x']) {
      const out = redactDiagnosticsText(input);
      expect(out).toBe('[redacted-path]');
    }
  });

  it('redacts deeper folders that contain spaces', () => {
    const out = redactDiagnosticsText('C:\\Work Files\\Jane Doe\\My Documents\\cv final.pdf');
    expect(out).not.toContain('Work');
    expect(out).not.toContain('Jane');
    expect(out).not.toContain('My Documents');
  });

  it('redacts UNC paths with spaces', () => {
    const out = redactDiagnosticsText('\\\\server\\share\\Jane Doe\\Documents\\x.txt');
    expect(out).toBe('[redacted-path]');
  });

  it('redacts ~ paths with spaces', () => {
    const out = redactDiagnosticsText('open ~/Jane Doe/Documents/x.txt now');
    expect(out).toBe('open [redacted-path] now');
    expect(redactDiagnosticsText('~\\My Stuff\\Jane Doe\\x.log')).toBe('[redacted-path]');
  });

  it('redacts POSIX home paths with spaces', () => {
    expect(redactDiagnosticsText('/Users/Jane Doe/Library/x.db')).toBe('[redacted-path]');
    expectNoLeak(redactDiagnosticsText('/home/jane doe/.config/app/x'));
    expectNoLeak(redactDiagnosticsText('failed in /home/jane doe'));
  });

  it('stops at quotes and parentheses', () => {
    const quoted = redactDiagnosticsText('cannot open "C:\\Users\\Jane Doe\\AppData\\x.json" for reading');
    expect(quoted).toBe('cannot open "[redacted-path]" for reading');
    const paren = redactDiagnosticsText("failed (C:\\Users\\Jane Doe\\AppData\\x.json) twice");
    expect(paren).toContain('failed (');
    expectNoLeak(paren);
    expect(redactDiagnosticsText("path '/Users/Jane Doe/x' missing")).toBe("path '[redacted-path]' missing");
  });

  it('keeps sentence text that follows the path', () => {
    const out = redactDiagnosticsText('Could not read C:\\Users\\Jane Doe\\AppData\\x.txt because access was denied');
    expect(out).toBe('Could not read [redacted-path] because access was denied');
  });

  it('redacts several paths on one line', () => {
    const out = redactDiagnosticsText(
      'copy C:\\Users\\Jane Doe\\a.txt; \\\\server\\share\\Jane Doe\\b.txt; ~/Jane Doe/c.txt; /home/jane doe/d.txt done',
    );
    expectNoLeak(out);
    expect(out).toContain('copy ');
    expect(out.match(/\[redacted-path\]/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('still redacts plain paths and leaves ordinary text alone', () => {
    expect(redactDiagnosticsText('C:\\Users\\jamie\\x.log')).toBe('[redacted-path]');
    expect(redactDiagnosticsText('/usr/local/bin/node')).toBe('[redacted-path]');
    expect(redactDiagnosticsText('Scan finished: 3 results (no errors)')).toBe('Scan finished: 3 results (no errors)');
  });

  it('stays fast on pathological input', () => {
    const input = `C:\\${'a b\\'.repeat(5000)}`;
    const start = Date.now();
    redactDiagnosticsText(input);
    redactDiagnosticsText('C:'.repeat(5000));
    redactDiagnosticsText('\\\\'.repeat(5000));
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
