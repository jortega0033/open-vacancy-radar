// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The #694 prototype is research. These checks stop it becoming production by accident: nothing that ships
 * (electron main, preload, renderer, or the vacancy engine package) may import it or name its comparator, and the
 * research modules may not call a writer, a model, a network API, a scheduler, or read the wall clock.
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..', '..');
const engineSrc = join(desktop, '..', '..', 'packages', 'vacancy-engine', 'src');

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'dist-electron') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, ext, out);
    else if (ext.test(name)) out.push(path);
  }
  return out;
}

const RESEARCH_MARKERS = /role-scope-research|role-family-comparator|compareRoleFamily|role-family-explanation/u;

describe('the role-scope prototype stays non-production', () => {
  it('is imported or named by nothing under electron/, src/ or the vacancy engine source', () => {
    const shipped = [
      ...files(join(desktop, 'electron'), /\.(ts|tsx)$/u),
      ...files(join(desktop, 'src'), /\.(ts|tsx)$/u),
      ...files(engineSrc, /\.ts$/u),
    ];
    expect(shipped.length).toBeGreaterThan(100);
    const offenders = shipped.filter((path) => RESEARCH_MARKERS.test(readFileSync(path, 'utf8')));
    expect(offenders.map((path) => relative(desktop, path))).toEqual([]);
  });

  it('keeps the research modules free of writers, models, network, timers and the wall clock', () => {
    // evaluation.test.ts is excluded: it is the one place allowed to write the regenerated file and time calls.
    for (const name of ['fixtures.ts', 'plans.ts', 'comparator.ts', 'evaluate.ts']) {
      const text = readFileSync(join(here, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/^\s*\/\/.*$/gmu, '');
      expect(text, name).not.toMatch(/\b(writeFile\w*|appendFile\w*|mkdir\w*|rm\w*Sync|createWriteStream)\b/u);
      expect(text, name).not.toMatch(/\b(saveSearchProfile|writeSearchPlan|createSearchPlanStore|workspace\.\w+)\b/u);
      expect(text, name).not.toMatch(/\b(fetch|XMLHttpRequest|setInterval|setTimeout|child_process|spawn|exec)\b/u);
      expect(text, name).not.toMatch(/\b(runAgentPrompt|anthropic|openai|claude|typesafe|laya|jev)\b/iu);
      expect(text, name).not.toMatch(/\bMath\.random\b|\bDate\.now\(|new Date\(\)/u);
    }
  });

  it('adds no dependency for itself', () => {
    const manifest = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(names.filter((name) => /typesafe|laya|transformers|onnx|ml-|tensorflow/iu.test(name))).toEqual([]);
  });
});
