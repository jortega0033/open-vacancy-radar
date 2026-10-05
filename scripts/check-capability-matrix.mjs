// Mechanical integrity check for docs/capability-matrix.md (issue #164, ADI-20). Run as
// `pnpm docs:check-capabilities`, and again as one step in .github/workflows/ci.yml.
//
// What it enforces, and what it deliberately does not:
//
//   1. Every markdown link resolves: the target file exists, and a `#heading` fragment matches a
//      heading in the target (GitHub's slug rules, including `-1` suffixes for duplicates).
//   2. Every required category (a `##` heading) and every required entry id is present, so a
//      row cannot be deleted quietly to make an uncomfortable limitation disappear.
//   3. Every row has a status from the fixed legend: Supported, Partial, Unsupported, Design-target.
//   4. Every `Supported` row cites at least one existing test file in its Tests cell.
//   5. Every file path quoted in backticks (optionally `path:line` or `path:from-to`) exists, and
//      the line is inside the file. This is what catches a claim whose code moved or was deleted.
//   6. Overclaiming words (sandboxed, verified, guaranteed, secure, safe, ...) are absent unless the
//      same line also cites a test file, or the word is negated ("not sandboxed").
//
// It does NOT infer runtime support from prose. Human-authored status is still the source of
// truth for deliberately deferred decisions; this script only checks that each claim points at
// something real and that nothing claims more certainty than it can back.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(scriptDir, '..');
export const MATRIX_PATH = resolve(REPO_ROOT, 'docs', 'capability-matrix.md');

export const STATUSES = ['Supported', 'Partial', 'Unsupported', 'Design-target'];

export const REQUIRED_CATEGORIES = [
  'Transports and fallback',
  'Workspace and trust',
  'Provider hardening',
  'MCP and sources',
  'Models',
  'Attachments',
  'Absent by design',
];

export const REQUIRED_ENTRIES = [
  'fallback-gate',
  'workspace-lease-mode',
  'account-evidence',
  'codex-sandbox-posture',
  'workspace-effects',
  'hardened-no-network',
  'codex-global-injection',
  'windows-sandbox-caveat',
  'mcp-product-policies',
  'mcp-generic-control',
  'model-catalog-codex',
  'model-catalog-claude',
  'attachments-outbound',
  'attachments-user-upload',
  'worktree-subagent-component',
];

const BANNED_WORDS_GLOBAL = /(?<!\b(?:not|never|without|no|nor|cannot|isn't)\s+)\b(sandboxed|verified|guaranteed?|secured?|safe|bulletproof|production-ready)\b/gi;
const TEST_PATH = /\.test\.(?:ts|tsx|mjs)$/;
const PATH_SPAN = /^([\w./@-]+\.(?:ts|tsx|mjs|js|md|json|yml|yaml|toml)):(\d+)(?:-(\d+))?$|^([\w./@-]+\.(?:ts|tsx|mjs|js|md|json|yml|yaml|toml))$/;

/** GitHub-style heading slug. */
export function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function stripFences(markdown) {
  const out = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push('');
      continue;
    }
    out.push(inFence ? '' : line);
  }
  return out;
}

/** Heading text and slugs of a markdown source, duplicates suffixed `-1`, `-2` like GitHub does. */
export function collectHeadings(markdown) {
  const seen = new Map();
  const headings = [];
  for (const line of stripFences(markdown)) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[2];
    const base = slugify(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({ level: match[1].length, text: text.replace(/`/g, ''), slug: count === 0 ? base : `${base}-${count}` });
  }
  return headings;
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** Backtick spans of a string. */
function spans(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** Rows of every table that has a Status column, with the category (`##` heading) they sit under. */
export function collectRows(markdown) {
  const lines = stripFences(markdown);
  const rows = [];
  let category = '';
  let columns;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      category = heading[1].replace(/`/g, '');
      columns = undefined;
      continue;
    }
    if (!line.trim().startsWith('|')) {
      columns = undefined;
      continue;
    }
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (columns === undefined) {
      const lowered = cells.map((c) => c.toLowerCase());
      columns = lowered.includes('status') && lowered.includes('id') ? lowered : null;
      continue;
    }
    if (columns === null) continue;
    const row = { line: i + 1, category, raw: line };
    columns.forEach((name, index) => {
      row[name] = cells[index] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

function checkLinks(markdown, matrixFile, errors) {
  const lines = stripFences(markdown);
  const ownHeadings = new Set(collectHeadings(markdown).map((h) => h.slug));
  const headingCache = new Map();
  const headingsOf = (file) => {
    if (!headingCache.has(file)) {
      headingCache.set(file, new Set(collectHeadings(readFileSync(file, 'utf8')).map((h) => h.slug)));
    }
    return headingCache.get(file);
  };
  lines.forEach((line, index) => {
    const withoutCode = line.replace(/`[^`]*`/g, '');
    for (const match of withoutCode.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(target)) continue;
      const [filePart, fragment] = target.split('#');
      const where = `line ${index + 1}`;
      if (filePart === '') {
        if (fragment && !ownHeadings.has(fragment)) errors.push(`${where}: anchor #${fragment} does not match any heading`);
        continue;
      }
      const file = resolve(dirname(matrixFile), filePart);
      if (!existsSync(file)) {
        errors.push(`${where}: link target ${filePart} does not exist`);
        continue;
      }
      if (fragment && file.endsWith('.md') && !headingsOf(file).has(fragment)) {
        errors.push(`${where}: anchor #${fragment} does not exist in ${filePart}`);
      }
    }
  });
}

function checkPathSpans(text, lineNumber, repoRoot, errors) {
  const resolved = [];
  for (const span of spans(text)) {
    const match = PATH_SPAN.exec(span);
    if (!match) continue;
    const path = match[1] ?? match[4];
    const file = resolve(repoRoot, path);
    if (!existsSync(file)) {
      errors.push(`line ${lineNumber}: referenced file ${path} does not exist`);
      continue;
    }
    resolved.push(path);
    if (match[2] !== undefined) {
      const total = readFileSync(file, 'utf8').split(/\r?\n/).length;
      const last = Number(match[3] ?? match[2]);
      if (Number(match[2]) < 1 || last > total || last < Number(match[2])) {
        errors.push(`line ${lineNumber}: ${span} points outside the file (${total} lines)`);
      }
    }
  }
  return resolved;
}

/**
 * Checks one matrix document. Pure apart from reading files the document links or quotes, so tests
 * can aim it at fixture matrices. Returns the list of problems; empty means it passed.
 */
export function checkMatrix(markdown, options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const matrixFile = options.matrixFile ?? MATRIX_PATH;
  const requiredCategories = options.requiredCategories ?? REQUIRED_CATEGORIES;
  const requiredEntries = options.requiredEntries ?? REQUIRED_ENTRIES;
  const errors = [];

  checkLinks(markdown, matrixFile, errors);

  const headings = collectHeadings(markdown).filter((h) => h.level === 2).map((h) => h.text);
  for (const category of requiredCategories) {
    if (!headings.includes(category)) errors.push(`required category "${category}" is missing`);
  }

  const rows = collectRows(markdown);
  const ids = new Set();
  for (const row of rows) {
    const id = spans(row.id ?? '')[0] ?? (row.id ?? '').trim();
    if (id) ids.add(id);
    const label = id || `row at line ${row.line}`;
    const status = (row.status ?? '').replace(/\*\*/g, '').trim();
    if (!STATUSES.includes(status)) {
      errors.push(`line ${row.line}: ${label} has status "${status}", expected one of ${STATUSES.join(', ')}`);
    }
    const evidenceFiles = checkPathSpans(row.evidence ?? '', row.line, repoRoot, errors);
    const testFiles = checkPathSpans(row.tests ?? '', row.line, repoRoot, errors);
    if (status === 'Supported' && !testFiles.some((f) => TEST_PATH.test(f))) {
      errors.push(`line ${row.line}: ${label} is Supported but cites no existing test file in its Tests cell`);
    }
    if (status !== 'Supported' && evidenceFiles.length === 0 && !/#\d+/.test(row.owner ?? '')) {
      errors.push(`line ${row.line}: ${label} cites neither a code path nor an owning issue`);
    }
  }
  for (const entry of requiredEntries) {
    if (!ids.has(entry)) errors.push(`required entry "${entry}" is missing`);
  }

  stripFences(markdown).forEach((line, index) => {
    const found = [...line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').matchAll(BANNED_WORDS_GLOBAL)];
    if (found.length === 0) return;
    const hasTest = spans(line).some((span) => {
      const match = PATH_SPAN.exec(span);
      return match && TEST_PATH.test(match[1] ?? match[4]);
    });
    if (!hasTest) {
      for (const word of new Set(found.map((m) => m[0].toLowerCase()))) {
        errors.push(`line ${index + 1}: "${word}" claims more than the matrix can back; cite a test file on the same line or reword`);
      }
    }
  });

  return errors;
}

function main() {
  const file = process.argv[2] ? resolve(process.argv[2]) : MATRIX_PATH;
  if (!existsSync(file)) {
    console.error(`capability matrix not found: ${file}`);
    process.exit(1);
  }
  const errors = checkMatrix(readFileSync(file, 'utf8'), { matrixFile: file });
  if (errors.length > 0) {
    console.error(`capability matrix check failed (${errors.length}):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log('capability matrix check passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
