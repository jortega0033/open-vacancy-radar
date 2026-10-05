import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MATRIX_PATH,
  REPO_ROOT,
  REQUIRED_CATEGORIES,
  REQUIRED_ENTRIES,
  checkMatrix,
  collectHeadings,
  slugify,
} from '../../../scripts/check-capability-matrix.mjs';

/**
 * Issue #164. The checker is only worth having if each failure mode really fails, so every
 * deliberately broken fixture below is asserted to produce its specific error, and the one valid
 * fixture and the real matrix are asserted to produce none.
 */

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/capability-matrix/', import.meta.url));
const FIXTURE_OPTIONS = {
  repoRoot: REPO_ROOT,
  requiredCategories: ['Cat A', 'Cat B'],
  requiredEntries: ['alpha'],
};

function runFixture(name, overrides = {}) {
  const file = `${FIXTURE_DIR}${name}`;
  return checkMatrix(readFileSync(file, 'utf8'), { ...FIXTURE_OPTIONS, matrixFile: file, ...overrides });
}

describe('slugify and collectHeadings', () => {
  it('follows GitHub slug rules', () => {
    expect(slugify("Limitation: `accountEvidence: 'cli_owned'` is not an account fingerprint")).toBe(
      'limitation-accountevidence-cli_owned-is-not-an-account-fingerprint',
    );
  });

  it('suffixes duplicate headings', () => {
    const slugs = collectHeadings('# A\n## Same\n## Same\n').map((h) => h.slug);
    expect(slugs).toEqual(['a', 'same', 'same-1']);
  });

  it('ignores headings inside code fences', () => {
    expect(collectHeadings('# A\n```\n## Hidden\n```\n').map((h) => h.slug)).toEqual(['a']);
  });
});

describe('the real matrix', () => {
  it('passes every check', () => {
    expect(checkMatrix(readFileSync(MATRIX_PATH, 'utf8'))).toEqual([]);
  });

  it('keeps every required category and entry id', () => {
    const text = readFileSync(MATRIX_PATH, 'utf8');
    for (const category of REQUIRED_CATEGORIES) expect(text).toContain(`## ${category}`);
    for (const entry of REQUIRED_ENTRIES) expect(text).toContain(`\`${entry}\``);
  });
});

describe('checkMatrix against fixtures', () => {
  it('accepts the valid fixture', () => {
    expect(runFixture('valid.md')).toEqual([]);
  });

  it('catches a heading anchor that does not resolve, in this file and in another', () => {
    const errors = runFixture('bad-anchor.md');
    expect(errors.some((e) => e.includes('#no-such-heading') && e.includes('does not match any heading'))).toBe(true);
    expect(errors.some((e) => e.includes('#no-such-section') && e.includes('does not exist in'))).toBe(true);
  });

  it('catches a link to a file that does not exist', () => {
    const errors = runFixture('bad-link.md');
    expect(errors.some((e) => e.includes('does-not-exist.md') && e.includes('does not exist'))).toBe(true);
  });

  it('catches a banned overclaiming phrase with no test on the line', () => {
    const errors = runFixture('banned-phrase.md');
    expect(errors.some((e) => e.includes('"sandboxed"'))).toBe(true);
    expect(errors.some((e) => e.includes('"guaranteed"'))).toBe(true);
  });

  it('allows a banned word when the same line cites a test file, and when it is negated', () => {
    expect(runFixture('banned-phrase-backed.md')).toEqual([]);
  });

  it('catches a missing required category', () => {
    const errors = runFixture('missing-category.md');
    expect(errors).toContain('required category "Cat B" is missing');
  });

  it('catches a missing required entry id', () => {
    const errors = runFixture('valid.md', { requiredEntries: ['alpha', 'beta'] });
    expect(errors).toContain('required entry "beta" is missing');
  });

  it('catches a Supported row with no test file', () => {
    const errors = runFixture('supported-no-test.md');
    expect(errors.some((e) => e.includes('is Supported but cites no existing test file'))).toBe(true);
  });

  it('catches a Supported row whose test file does not exist', () => {
    const errors = runFixture('supported-missing-test-file.md');
    expect(errors.some((e) => e.includes('apps/daemon/test/nope.test.ts does not exist'))).toBe(true);
    expect(errors.some((e) => e.includes('is Supported but cites no existing test file'))).toBe(true);
  });

  it('catches a status outside the legend', () => {
    const errors = runFixture('bad-status.md');
    expect(errors.some((e) => e.includes('has status "Mostly"'))).toBe(true);
  });

  it('catches a line reference that points past the end of the file', () => {
    const errors = runFixture('bad-line.md');
    expect(errors.some((e) => e.includes('points outside the file'))).toBe(true);
  });
});
