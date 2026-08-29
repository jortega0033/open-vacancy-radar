import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseOfficialSponsorRegister } from '../../src/ind/source.js';

const fixturePath = path.resolve(process.cwd(), 'test/fixtures/ind-work-register.html');

describe('official IND work register parser', () => {
  it('parses, validates, and exactly deduplicates sponsor rows', async () => {
    const snapshot = parseOfficialSponsorRegister(await readFile(fixturePath, 'utf8'), { minimumRows: 1 });

    expect(snapshot.sourceLastUpdated.toISOString()).toBe('2026-08-03T00:00:00.000Z');
    expect(snapshot.rawRowCount).toBe(7);
    expect(snapshot.records).toHaveLength(6);
    expect(snapshot.duplicateRowCount).toBe(1);
    expect(snapshot.membershipHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ legalName: 'Alexia Kliniek Echt B.V.', kvkNumber: '17214152' }),
        expect.objectContaining({
          legalName: '""Aa-Dee"" Machinefabriek en Staalbouw Nederland B.V.',
          kvkNumber: '16051874',
        }),
        expect.objectContaining({ legalName: '247HAIR', kvkNumber: '02076358' }),
        expect.objectContaining({ legalName: 'Zon & Zo - ERD B.V.', kvkNumber: '80305342' }),
        expect.objectContaining({ legalName: 'Autoriteit Consument en Markt', kvkNumber: null }),
      ]),
    );
  });

  it('rejects a response whose expected table is absent', () => {
    expect(() =>
      parseOfficialSponsorRegister('<p>The overview was last updated on 3 August 2026.</p>', {
        minimumRows: 1,
      }),
    ).toThrow('expected headers');
  });

  it('rejects an implausibly truncated response', async () => {
    const html = await readFile(fixturePath, 'utf8');
    expect(() => parseOfficialSponsorRegister(html, { minimumRows: 10 })).toThrow('expected at least 10');
  });
});
