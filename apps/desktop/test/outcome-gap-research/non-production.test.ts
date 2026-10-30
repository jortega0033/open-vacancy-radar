// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The #693 prototype is research. These checks stop it becoming production by accident: nothing that ships
 * (electron main, preload, renderer) may import it, and the read-only modules may not call a workspace writer,
 * a model, a network API or a scheduler.
 */

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..', '..');

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'dist-electron') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, ext, out);
    else if (ext.test(name)) out.push(path);
  }
  return out;
}

describe('the outcome/gap prototype stays non-production', () => {
  it('is imported by nothing under electron/ or src/', () => {
    const shipped = [...files(join(desktop, 'electron'), /\.(ts|tsx)$/u), ...files(join(desktop, 'src'), /\.(ts|tsx)$/u)];
    expect(shipped.length).toBeGreaterThan(50);
    const offenders = shipped.filter((path) => /outcome-gap-research/u.test(readFileSync(path, 'utf8')));
    expect(offenders.map((path) => relative(desktop, path))).toEqual([]);
  });

  it('adds no migration, table, IPC channel or UI for itself', () => {
    const schema = readFileSync(join(desktop, 'electron', 'workspace', 'schema.ts'), 'utf8');
    expect(schema).not.toMatch(/outcome_gap|outcome_event|status_event|suggestion_dismiss/iu);
    const ipc = files(join(desktop, 'electron'), /\.ts$/u).filter((path) => /outcome-gap|outcome_gap/iu.test(readFileSync(path, 'utf8')));
    expect(ipc).toEqual([]);
  });

  it('keeps the read-only modules free of writers, models, network and timers', () => {
    const readOnly = ['observations.ts', 'funnel.ts', 'requirements.ts', 'suggestions.ts', 'requisition.ts', 'contract.ts'].filter((name) => {
      try {
        statSync(join(here, name));
        return true;
      } catch {
        return false;
      }
    });
    expect(readOnly).toEqual(expect.arrayContaining(['observations.ts', 'funnel.ts', 'requisition.ts', 'contract.ts']));
    for (const name of readOnly) {
      const text = readFileSync(join(here, name), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
      expect(text, name).not.toMatch(/workspace\.(create|update|delete|record|set|reset|save|append|pin)\w*\(/u);
      expect(text, name).not.toMatch(/\b(fetch|XMLHttpRequest|setInterval|setTimeout|child_process|spawn|exec)\b/u);
      expect(text, name).not.toMatch(/\b(generate|runAgentPrompt|anthropic|openai|claude)\b/iu);
      expect(text, name).not.toMatch(/\bMath\.random\b|\bDate\.now\(|new Date\(\)/u);
    }
  });
});
