import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Text drawn at text-base-content/30..50 fails WCAG 1.4.3 (4.5:1) on the app surfaces (#455).
 * Use `text-base-content/60` or better. Border, background, fill and ring utilities are not text and
 * are not matched.
 */
const SRC = join(__dirname, '..', 'src');
const LOW_OPACITY_TEXT = /(?<![\w-])text-base-content\/(30|35|40|45|50)\b/;

/** Decorative, aria-hidden graphics that are not text. Each entry is `file :: line fragment`. */
const ALLOWLIST: ReadonlyArray<[file: string, fragment: string]> = [
  ['components/search/VacancyDetail.tsx', 'FileDashed'],
  ['components/shell/EmptyState.tsx', 'inline-block size-36'],
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(tsx?|css)$/.test(name) ? [full] : [];
  });
}

describe('text contrast classes', () => {
  it('has no text-base-content at /30 to /50 on text', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, index) => {
          if (!LOW_OPACITY_TEXT.test(line)) return;
          if (ALLOWLIST.some(([f, fragment]) => f === rel && line.includes(fragment))) return;
          offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps allowlist entries live so they cannot go stale', () => {
    for (const [file, fragment] of ALLOWLIST) {
      const lines = readFileSync(join(SRC, file), 'utf8').split(/\r?\n/);
      expect(lines.some((l) => LOW_OPACITY_TEXT.test(l) && l.includes(fragment))).toBe(true);
    }
  });
});
