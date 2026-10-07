import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Copy rules for app-authored UI strings. The scan walks every .ts and .tsx file under src with the
// TypeScript compiler API and inspects string literals, template literal text and JSX text. Comments
// are never inspected, and regular expression literals are not strings, so parsers that match a dash
// in external data stay legal.

const SRC_ROOT = join(__dirname, '..', 'src');
const EM_DASH = '—';

interface Piece {
  file: string;
  line: number;
  text: string;
  /** The literal as written in source, escapes untouched. */
  raw: string;
  /** True when the piece sits inside a JSX tree and is not an attribute that never renders. */
  visible: boolean;
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const NON_RENDERED_ATTRIBUTES = new Set([
  'className',
  'id',
  'key',
  'type',
  'role',
  'href',
  'htmlFor',
  'name',
  'value',
  'data-testid',
  'data-state',
  'data-slot',
  'data-tab',
  'data-kind',
  'data-status',
  'data-variant',
  'data-ovr-surface',
  'viewBox',
  'd',
  'fill',
  'stroke',
  'xmlns',
  'target',
  'rel',
  'autoComplete',
  'inputMode',
  'form',
  'accept',
]);

function insideRenderedJsx(node: ts.Node): boolean {
  let inJsx = false;
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isJsxAttribute(cur)) {
      const attr = cur.name.getText();
      if (NON_RENDERED_ATTRIBUTES.has(attr) || attr.startsWith('data-')) return false;
    }
    if (ts.isJsxElement(cur) || ts.isJsxSelfClosingElement(cur) || ts.isJsxFragment(cur)) inJsx = true;
  }
  return inJsx;
}

export function collectPieces(file: string, source: string): Piece[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const pieces: Piece[] = [];
  const push = (node: ts.Node, text: string, visible: boolean) => {
    const raw = node.getText(sf);
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    pieces.push({ file, line: line + 1, text, raw, visible });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node, node.text, insideRenderedJsx(node));
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      push(node, node.text, insideRenderedJsx(node));
    } else if (ts.isJsxText(node)) {
      if (node.text.trim() !== '') push(node, node.text, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return pieces;
}

const allFiles = listSourceFiles(SRC_ROOT);
const allPieces: Piece[] = allFiles.flatMap((f) =>
  collectPieces(relative(join(SRC_ROOT, '..'), f).split(sep).join('/'), readFileSync(f, 'utf8')),
);

function expectNone(rule: string, hits: Piece[]): void {
  if (hits.length === 0) return;
  const lines = hits.map((h) => `  ${h.file}:${h.line}  ${JSON.stringify(h.text.trim().slice(0, 80))}`);
  throw new Error([`${rule}:`, ...lines].join('\n'));
}

/** An em dash written in source is banned in every string (an escaped one only in rendered strings, since regex source may use it). A spaced double hyphen is banned in rendered strings only, since LLM prompt text is never shown. */
function hasDash(p: Piece): boolean {
  return p.raw.includes(EM_DASH) || (p.visible && (p.text.includes(' -- ') || /\\u2014|\\u\{2014\}/i.test(p.raw)));
}

/** LLM prompt builders hold instructions for the model, not text a person reads. */
const PROMPT_FILE = /(?:^|\/)[\w-]*prompts?\.ts$/;

/** Rendered copy: JSX text plus app-authored label strings in plain modules (nav, results, helpers). */
function isAppCopy(p: Piece): boolean {
  return p.visible || !PROMPT_FILE.test(p.file);
}

interface AllowEntry {
  file: string;
  /** Substring of the piece text that is allowed. */
  includes: string;
  why: string;
}

function allowed(list: AllowEntry[], p: Piece): boolean {
  return list.some((a) => a.file === p.file && p.text.includes(a.includes));
}

function scan(pieces: Piece[], matcher: (piece: Piece) => boolean): Piece[] {
  return pieces.filter(matcher);
}

describe('copy rules: dashes', () => {
  it('has no em dash or spaced double hyphen in any string literal, template text or JSX text', () => {
    const hits = scan(allPieces, hasDash);
    expectNone('Use a colon, a period or the NotSet component instead of a dash', hits);
  });

  it('catches a deliberately inserted em dash and double hyphen (self check)', () => {
    const sample = [
      "const a = 'Saved — later';",
      'const b = <p>{`Run ${x} -- done`}</p>;',
      'const c = <p>Hello — there</p>;',
      "const d = 'fine'; // a comment — ignored",
    ].join('\n');
    const hits = scan(collectPieces('sample.tsx', sample), hasDash);
    expect(hits.map((h) => h.line)).toEqual([1, 2, 3]);
  });
});

// Terms that belong to the pipeline, not to a person reading the screen. Applied to rendered copy: JSX text
// plus label and message strings in plain modules (LLM prompt files are skipped). Add an entry to JARGON_ALLOWLIST (with a reason) when a term is truly user facing.
const BANNED_JARGON: Array<{ label: string; pattern: RegExp }> = [
  { label: 'daemon', pattern: /\bdaemon\b/i },
  { label: 'rebase', pattern: /\brebas(?:e|ed|es|ing)\b/i },
  { label: 'digest', pattern: /\bdigest\b/i },
  { label: 'deduplicated', pattern: /\bdeduplicated\b/i },
  { label: 'raw rows', pattern: /\braw rows?\b/i },
  { label: 'snapshot', pattern: /\bsnapshots?\b/i },
];

/** Pieces that may keep a banned term. Every entry needs a reason. */
const JARGON_ALLOWLIST: AllowEntry[] = [
  // Empty on purpose: add an entry only with a reason a user would accept.
];

describe('copy rules: pipeline jargon', () => {
  it('keeps banned pipeline terms out of rendered copy', () => {
    const hits: Piece[] = [];
    for (const p of allPieces) {
      if (!isAppCopy(p)) continue;
      const banned = BANNED_JARGON.find((b) => b.pattern.test(p.text));
      if (banned && !allowed(JARGON_ALLOWLIST, p)) hits.push({ ...p, text: `[${banned.label}] ${p.text}` });
    }
    expectNone('Replace the jargon with plain wording from the glossary', hits);
  });
});

// Glossary of user-facing terms. Sentence case for labels.
//  #495: vacancy (the posting), role (job title), CV, letter, tailoring.
//  #639 part 1 (one name per concept):
//    CV                        the candidate document. A CV the person types in is "Type your CV".
//    What you are looking for  the ranking input (roles, skills, country). Banned variants: "search profile",
//                              "manual profile", "Add manual profile", "Fill search profile", "your profile".
//  Internal names (CvProfile, getSearchProfile, the 'search-profile' focus section) stay as they are.
const BANNED_VARIANTS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Saved Jobs', pattern: /\bSaved Jobs\b/ },
  { label: 'AI Runtime', pattern: /\bAI Runtime\b/ },
  { label: 'Generate Letter', pattern: /\bGenerate Letter\b/ },
  { label: 'Search Jobs', pattern: /\bSearch Jobs\b/ },
  { label: 'Resume audit', pattern: /\bresume audit\b/i },
  // "resume" as a verb (resume a session) is fine. Only the document noun is banned.
  { label: 'resume (use CV)', pattern: /\b(?:your|a|an|the|this|that|uploaded|my|saved) resumes?\b/i },
  { label: 'Analyse (use US spelling)', pattern: /\b[Aa]nalys(?:e|ed|es|ing)\b/ },
  { label: 'Title Case "Cover Letter"', pattern: /\bCover Letter\b/ },
  { label: 'search profile (use "What you are looking for")', pattern: /\bsearch profile\b/i },
  { label: 'manual profile (use "Type your CV")', pattern: /\bmanual (?:CV )?profile\b/i },
  { label: 'your profile (use "what you are looking for")', pattern: /\b(?:your|my|the) profile\b/i },
  { label: 'fill in a profile (use "what you are looking for")', pattern: /\bfill (?:in )?(?:your |the |a )?profile\b/i },
];

/** Pieces that may keep a banned variant. Every entry needs a reason. */
const VARIANT_ALLOWLIST: AllowEntry[] = [];

describe('copy rules: glossary and spelling', () => {
  it('uses the glossary terms, sentence case and US spelling in rendered copy', () => {
    const hits: Piece[] = [];
    for (const p of allPieces) {
      if (!isAppCopy(p)) continue;
      const banned = BANNED_VARIANTS.find((b) => b.pattern.test(p.text));
      if (banned && !allowed(VARIANT_ALLOWLIST, p)) hits.push({ ...p, text: `[${banned.label}] ${p.text}` });
    }
    expectNone('Use the glossary term, sentence case or US spelling', hits);
  });
});

// "X, not Y" antithesis reads as a stock phrase. State the point directly. Short status labels that
// carry a real distinction can be listed here with the reason.
const ANTITHESIS = /,\s+not\s+(?:a|an|the|your|just|only|about|to|for|on|in|\w+)\b/i;

/** Short status labels where "not X" is the actual state. Every entry needs a reason. */
const ANTITHESIS_ALLOWLIST: AllowEntry[] = [
  { file: 'src/components/cv/EvidenceReview.tsx', includes: 'Draft, not approved', why: 'Status label: the approval gate is the point' },
  { file: 'src/components/cv/CvArtifactPanel.tsx', includes: 'Exported by an earlier version, not verified', why: 'Status label for an export that has no file check' },
  { file: 'src/components/cv/CvPdfPageReview.tsx', includes: ', not shown yet', why: 'Status suffix on a page that has not loaded' },
  { file: 'src/components/applications/ApplicationReviewSwipeCard.tsx', includes: ', not filled automatically', why: 'Status label: the field was found but left for the person' },
];

describe('copy rules: antithesis phrasing', () => {
  it('has no ", not X" antithesis in rendered copy', () => {
    const hits = allPieces.filter((p) => isAppCopy(p) && ANTITHESIS.test(p.text) && !allowed(ANTITHESIS_ALLOWLIST, p));
    expectNone('State the point directly instead of "X, not Y"', hits);
  });
});

describe('copy rules: profile terms (#639)', () => {
  it('flags the banned profile variants (self check)', () => {
    const sample = [
      "const a = 'Add manual profile';",
      'const b = <button>Fill search profile</button>;',
      "const c = 'Could not check your profile.';",
      "const d = 'What you are looking for';",
      "const e = 'Type your CV';",
    ].join('\n');
    const hits = collectPieces('sample.tsx', sample).filter((p) => BANNED_VARIANTS.some((b) => b.pattern.test(p.text)));
    expect(hits.map((h) => h.line)).toEqual([1, 2, 3]);
  });
});
