import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { requiredScanQuery } from '../electron/vacancy-scan-query.js';

const ELECTRON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron');

function source(file: string): string {
  return readFileSync(join(ELECTRON_DIR, file), 'utf8');
}

describe('requiredScanQuery', () => {
  it('rejects blank, whitespace-only, and non-string values', () => {
    for (const input of ['', '   ', null, undefined, 42, { query: 'frontend' }, ['frontend']]) {
      expect(() => requiredScanQuery(input)).toThrow('Add a role or keyword before starting a new worldwide scan.');
    }
  });

  it('trims valid queries before vacancy discovery receives them', () => {
    expect(requiredScanQuery('  frontend engineer  ')).toBe('frontend engineer');
  });

  it('guards the IPC argument before main process scan setup can initialize the engine', () => {
    expect(source('main.ts')).toContain(
      "guardedIpc.handle('vacancy:run-scan', (_event, query: unknown): Promise<GlobalRemoteReport> =>\n  runVacancyScan(requiredScanQuery(query)),\n);",
    );
  });
});
