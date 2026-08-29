import { describe, expect, it } from 'vitest';

import {
  createStructuredDomainEvidence,
  type StructuredDomainEvidence,
} from '../../src/companies/structured-domain-evidence.js';
import { mergeStructuredDomainEvidence } from '../../src/companies/structured-domain-merge.js';

function evidence(
  source: 'roo' | 'iati',
  kvkNumber: string,
  officialUrl: string,
  recordId: string,
): StructuredDomainEvidence {
  const value = createStructuredDomainEvidence({
    source,
    sourceVersion: `${source}-v1`,
    sourceRecordId: recordId,
    sourceName: 'Acme Overheidsorganisatie',
    kvkNumber,
    officialUrl,
    evidenceUrl:
      source === 'roo'
        ? `https://identifier.overheid.nl/tooi/id/oorg/${recordId}`
        : `https://merged.dashboard.iatistandard.org/api/reporting-orgs/${recordId}/`,
  });
  if (value === null) throw new Error('invalid test evidence');
  return value;
}

const sponsors = [
  { id: 'sponsor-acme', legalName: 'Acme Overheidsorganisatie', kvkNumber: '01234567' },
  { id: 'sponsor-conflict', legalName: 'Conflicterende Organisatie', kvkNumber: '87654321' },
  { id: 'sponsor-missing', legalName: 'Niet Gevonden B.V.', kvkNumber: '33333333' },
  { id: 'sponsor-no-kvk', legalName: 'Zonder KVK', kvkNumber: null },
];

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected test value');
  return value;
}

describe('structured domain evidence merge', () => {
  it('merges exact KVK corroboration on one host and retains all provenance', () => {
    const roo = evidence('roo', '01234567', 'http://www.acme.nl/about/', 'roo-acme');
    const iati = evidence('iati', '01234567', 'https://acme.nl/', 'iati-acme');

    const result = mergeStructuredDomainEvidence(sponsors, [roo, iati, iati]);

    expect(result.candidates).toHaveLength(1);
    const candidate = requireValue(result.candidates[0]);
    expect(candidate).toMatchObject({
      sponsorId: 'sponsor-acme',
      kvkNumber: '01234567',
      officialUrl: 'https://acme.nl/',
      hostname: 'acme.nl',
      sources: ['iati', 'roo'],
    });
    expect(candidate.provenance.map(({ source, sourceRecordId }) => [source, sourceRecordId])).toEqual(
      [
        ['iati', 'iati-acme'],
        ['roo', 'roo-acme'],
      ],
    );
    expect(result.outcomes.map(({ status }) => status)).toEqual([
      'candidate',
      'not_found',
      'not_found',
      'missing_kvk',
    ]);
  });

  it('upgrades an HTTP-only candidate to HTTPS while retaining the observed URL', () => {
    const result = mergeStructuredDomainEvidence(
      [requireValue(sponsors[0])],
      [evidence('roo', '01234567', 'http://www.acme.nl/about/', 'roo-http-only')],
    );

    const candidate = requireValue(result.candidates[0]);
    expect(candidate.officialUrl).toBe('https://www.acme.nl/about');
    expect(candidate.provenance).toEqual([
      expect.objectContaining({ observedOfficialUrl: 'http://www.acme.nl/about' }),
    ]);
  });

  it('sends cross-source or within-source hostname conflicts to manual review', () => {
    const conflictSponsor = requireValue(sponsors[1]);
    const result = mergeStructuredDomainEvidence(
      [conflictSponsor],
      [
        evidence('roo', '87654321', 'https://one.nl/', 'roo-conflict'),
        evidence('iati', '87654321', 'https://two.nl/', 'iati-conflict'),
      ],
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.outcomes).toHaveLength(1);
    const outcome = requireValue(result.outcomes[0]);
    expect(outcome.status).toBe('manual_review');
    if (outcome.status !== 'manual_review') throw new Error('expected manual-review outcome');
    expect(outcome.reasonCode).toBe('conflicting_structured_hosts');
    expect(outcome.hostnames).toEqual(['one.nl', 'two.nl']);
    expect(outcome.provenance.map(({ source }) => source)).toEqual(['iati', 'roo']);
  });
});
