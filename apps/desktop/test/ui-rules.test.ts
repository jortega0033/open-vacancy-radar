import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, it } from 'vitest';

// UI rules for accessible component patterns. The scan walks every .tsx file under
// src/components with the TypeScript compiler API and looks for JSX patterns that
// violate accessibility guidelines.

const COMPONENTS_ROOT = join(__dirname, '..', 'src', 'components');

interface Finding {
  file: string;
  line: number;
  element: string;
  issue: string;
}

function listComponentFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listComponentFiles(full, out);
    else if (entry.endsWith('.tsx') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Find JSX elements that are disabled and have a title attribute that looks like
 * it's explaining why the element is disabled. A disabled control should never
 * rely on a hover tooltip to explain why it is disabled -- the explanation must
 * be visible to all users, especially keyboard and screen reader users.
 */
function findDisabledWithTitle(file: string, source: string): Finding[] {
  const kind = ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const findings: Finding[] = [];

  const visit = (node: ts.Node): void => {
    // Look for JSX self-closing elements and JSX opening elements
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tagName = node.tagName.getText(sf);
      const isDisabledControl = tagName === 'input' || tagName === 'button';

      if (!isDisabledControl) {
        ts.forEachChild(node, visit);
        return;
      }

      // Check if this element has a disabled attribute
      const hasDisabled = node.attributes.properties.some(
        (attr) =>
          (ts.isJsxAttribute(attr) || ts.isJsxSpreadAttribute(attr)) &&
          (ts.isJsxAttribute(attr) && attr.name.getText(sf) === 'disabled'),
      );

      if (!hasDisabled) {
        ts.forEachChild(node, visit);
        return;
      }

      // Check if this element has a title attribute
      const titleAttr = node.attributes.properties.find(
        (attr) => ts.isJsxAttribute(attr) && attr.name.getText(sf) === 'title',
      ) as ts.JsxAttribute | undefined;

      if (titleAttr) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        findings.push({
          file,
          line: line + 1,
          element: tagName,
          issue: `disabled ${tagName} has title attribute; explanation must be visible text with aria-describedby`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return findings;
}

const allFiles = listComponentFiles(COMPONENTS_ROOT);
const allFindings: Finding[] = allFiles.flatMap((f) =>
  findDisabledWithTitle(relative(join(COMPONENTS_ROOT, '..'), f).split(sep).join('/'), readFileSync(f, 'utf8')),
);

describe('UI rules: accessibility', () => {
  it('has no disabled button or input with a title attribute that explains why it is disabled', () => {
    if (allFindings.length === 0) return;
    const lines = allFindings.map(
      (f) => `  ${f.file}:${f.line}  ${f.element}: ${f.issue}`,
    );
    throw new Error([
      'Disabled controls must not rely on hover tooltips for their explanation.',
      'Use visible text with aria-describedby instead.',
      '',
      ...lines,
    ].join('\n'));
  });
});
