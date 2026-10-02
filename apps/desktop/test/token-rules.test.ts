import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Issue #501: design token guard rails for the renderer. Violations that existed when the rules
// landed are recorded as per-file counts in token-rules-allowlist.json. The allowlist can only
// shrink: a file with MORE hits than allowed is a new violation, and a file with FEWER hits than
// allowed is a stale entry that must be lowered or removed in the same change that fixed it.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..', 'src');

interface Rule {
  id: string;
  pattern: RegExp;
  message: string;
  /** Files (posix paths relative to src) the rule does not apply to. */
  exempt?: (file: string) => boolean;
}

const rules: Rule[] = [
  {
    id: 'arbitrary-px-font',
    pattern: /(?<![\w-])text-\[\d+(?:\.\d+)?px\]/g,
    message: 'Use a type scale class (text-xs, text-sm, ...) instead of an arbitrary px font size.',
  },
  {
    id: 'raw-alert',
    pattern: /(?<![\w-])alert-(?:error|warning)(?![\w-])/g,
    message: 'Use the shared shell alert component instead of a raw alert-error / alert-warning.',
    exempt: (file) => file.startsWith('components/shell/'),
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function countViolations(): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const abs of walk(srcRoot)) {
    const file = relative(srcRoot, abs).split(sep).join('/');
    const text = readFileSync(abs, 'utf8');
    for (const rule of rules) {
      if (rule.exempt?.(file)) continue;
      const hits = text.match(rule.pattern)?.length ?? 0;
      if (hits > 0) (counts[rule.id] ??= {})[file] = hits;
    }
  }
  return counts;
}

const allowlist = JSON.parse(readFileSync(join(here, 'token-rules-allowlist.json'), 'utf8')) as Record<
  string,
  Record<string, number>
>;
const actual = countViolations();

describe('design token rules (issue #501)', () => {
  for (const rule of rules) {
    const allowed = allowlist[rule.id] ?? {};
    const found = actual[rule.id] ?? {};

    it(`${rule.id}: no new violations`, () => {
      const added = Object.entries(found)
        .filter(([file, n]) => n > (allowed[file] ?? 0))
        .map(([file, n]) => `${file}: ${n} found, ${allowed[file] ?? 0} allowed`);
      expect(added, `${rule.message}\n${added.join('\n')}`).toEqual([]);
    });

    it(`${rule.id}: allowlist has no stale entries`, () => {
      const stale = Object.entries(allowed)
        .filter(([file, n]) => (found[file] ?? 0) < n)
        .map(([file, n]) => `${file}: ${found[file] ?? 0} found, ${n} allowed. Lower or remove the entry.`);
      expect(stale, stale.join('\n')).toEqual([]);
    });
  }
});
