import { describe, expect, it } from 'vitest';

import {
  extractJsonLdVacancies,
  extractJsonLdVacanciesWithDiagnostics,
} from '../../src/ats/json-ld.js';
import { atsFixture } from './helpers.js';

describe('extractJsonLdVacancies', () => {
  it('supports object, array, @graph, and @type arrays while isolating malformed nodes and scripts', async () => {
    const vacancies = extractJsonLdVacancies(
      await atsFixture('json-ld/job-detail.html'),
      'https://careers.acme.example/rendered/job?tracking=1',
    );

    expect(vacancies).toHaveLength(2);
    expect(vacancies[0]).toMatchObject({
      externalId: 'jsonld-42',
      title: 'Platform Engineer',
      location: 'Netherlands',
      remote: true,
      workplaceMode: 'remote',
      url: 'https://careers.acme.example/careers/platform-engineer',
      postedAt: new Date('2026-08-18T00:00:00.000Z'),
      employmentType: 'FULL_TIME, PERMANENT',
      source: 'json_ld',
    });
    expect(vacancies[0]?.description).toContain('TypeScript & Kubernetes');
    expect(vacancies[1]).toMatchObject({
      externalId: 'jsonld-43',
      location: 'Amsterdam, Netherlands',
      remote: false,
      workplaceMode: 'onsite',
      postedAt: null,
      url: 'https://careers.acme.example/careers/platform-engineer',
    });
  });

  it('recognizes pages with no usable JobPosting data as empty', () => {
    expect(
      extractJsonLdVacancies(
        '<script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>',
        'https://acme.example/careers',
      ),
    ).toEqual([]);
  });

  it('reports malformed scripts and invalid JobPosting nodes without hiding valid jobs', async () => {
    const result = extractJsonLdVacanciesWithDiagnostics(
      await atsFixture('json-ld/job-detail.html'),
      'https://careers.acme.example/rendered/job?tracking=1',
    );

    expect(result).toMatchObject({
      jobPostingNodes: 3,
      invalidNodes: 1,
      duplicateNodes: 0,
      malformedScripts: 1,
    });
    expect(result.vacancies).toHaveLength(2);
  });

  it('resolves a relative JSON-LD @id against the selected vacancy URL', () => {
    const [vacancy] = extractJsonLdVacancies(
      `<script type="application/ld+json">{
        "@type":"JobPosting",
        "@id":"#job",
        "title":"Frontend Engineer",
        "description":"Build the interface"
      }</script>`,
      'https://careers.acme.example/careers/jobs/frontend-engineer',
    );

    expect(vacancy?.externalId).toBe(
      'https://careers.acme.example/careers/jobs/frontend-engineer#job',
    );
  });

  it('can prefer each node URL on multi-job pages while retaining page canonical fallback', async () => {
    const vacancies = extractJsonLdVacancies(
      await atsFixture('json-ld/job-detail.html'),
      'https://careers.acme.example/rendered/job?tracking=1',
      { preferNodeUrl: true },
    );

    expect(vacancies[0]?.url).toBe('https://tracking.example/jobs/jsonld-42');
    expect(vacancies[1]?.url).toBe(
      'https://careers.acme.example/careers/platform-engineer',
    );
  });
});
