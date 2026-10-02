import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Screen readers often skip a `role="status"` element that is mounted together with its text, so
 * the region has to exist first (issue #456). Deliberately narrow: it guards only the files that
 * carry the app-level announcer, not the older conditionally mounted regions elsewhere.
 *
 * A region counts as conditionally mounted when the opening tag carrying `role="status"` is
 * preceded, on its own line or the line before, by `&&` (optionally with an opening paren).
 */
function findConditionalStatusRegions(source: string): number[] {
  const lines = source.split('\n');
  const hits: number[] = [];
  lines.forEach((line, index) => {
    if (!line.includes('role="status"')) return;
    const sameLine = /&&\s*\(?\s*<[^>]*role="status"/.test(line);
    const previous = lines[index - 1] ?? '';
    const afterAndAnd = /&&\s*\(\s*$/.test(previous) && /^\s*<[^>]*role="status"|^\s*<\w+\s*$/.test(line);
    if (sameLine || afterAndAnd) hits.push(index + 1);
  });
  return hits;
}

const GUARDED_FILES = ['src/components/shell/LiveAnnouncer.tsx', 'src/App.tsx'];

describe('role="status" mounting', () => {
  it('detects a status region mounted behind &&', () => {
    expect(findConditionalStatusRegions('{open && (\n  <div role="status">x</div>\n)}')).toEqual([2]);
    expect(findConditionalStatusRegions('{open && <p role="status">x</p>}')).toEqual([1]);
    expect(findConditionalStatusRegions('<div role="status">{open && text}</div>')).toEqual([]);
  });

  it.each(GUARDED_FILES)('%s has no conditionally mounted role="status"', (file) => {
    const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
    expect(findConditionalStatusRegions(source)).toEqual([]);
  });

  it('keeps the announcer region in the provider output', () => {
    const source = readFileSync(resolve(__dirname, '..', 'src/components/shell/LiveAnnouncer.tsx'), 'utf8');
    expect(source).toContain('role="status"');
  });
});
