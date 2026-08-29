import { describe, expect, it } from 'vitest';

import { createSearchName, createSponsorIdentity, normalizeLegalName } from '../../src/ind/normalize.js';

describe('IND legal-entity normalization', () => {
  it('normalizes formatting variants without discarding the imported legal name', () => {
    const variants = [' ACME  Nederland B.V.\u00a0', 'Acme Nederland BV', 'ACME Nederland B. V.'];
    expect(variants.map(normalizeLegalName)).toEqual([
      'acme nederland bv',
      'acme nederland bv',
      'acme nederland bv',
    ]);

    const identity = createSponsorIdentity(variants[0] ?? '', '01234567');
    expect(identity.legalName).toBe('ACME Nederland B.V.');
    expect(identity.kvkNumber).toBe('01234567');
  });

  it('keeps distinct legal entities distinct', () => {
    expect(normalizeLegalName('North Star Holding B.V.')).not.toBe(
      normalizeLegalName('North Star Technology B.V.'),
    );
  });

  it('uses accent folding only for the loose search key', () => {
    expect(normalizeLegalName('Müller B.V.')).not.toBe(normalizeLegalName('Muller B.V.'));
    expect(createSearchName('Müller B.V.')).toBe(createSearchName('Muller B.V.'));
  });

  it('retains missing and zero-prefixed KVK values correctly', () => {
    expect(createSponsorIdentity('247HAIR', '02076358').kvkNumber).toBe('02076358');
    expect(createSponsorIdentity('Autoriteit Consument en Markt', '').kvkNumber).toBeNull();
  });

  it('rejects malformed nonempty KVK values', () => {
    expect(() => createSponsorIdentity('Bad KVK B.V.', '1234')).toThrow('Invalid KVK number');
  });
});
