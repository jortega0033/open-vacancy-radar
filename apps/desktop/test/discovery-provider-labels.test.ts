import { describe, expect, it } from 'vitest';
import { discoveryProviderLabel } from '../src/discovery-provider-labels.js';

describe('discoveryProviderLabel', () => {
  // UX audit finding: the Search results card, the "Vacancy source" detail card, and the Overview
  // "Source" field all rendered a raw snake_case `DiscoveryProvider` id (e.g. `devitjobs_uk`,
  // `we_work_remotely`) verbatim instead of a name a candidate would recognize.
  it.each([
    ['devitjobs_uk', 'DevITjobs UK'],
    ['we_work_remotely', 'We Work Remotely'],
    ['himalayas', 'Himalayas'],
    ['jobicy', 'Jobicy'],
    ['ai_dev_jobs', 'AI Dev Jobs'],
    ['nav_arbeidsplassen', 'NAV Arbeidsplassen'],
    ['ats_roster_greenhouse', 'Greenhouse (ATS roster)'],
    ['workable_global', 'Workable'],
    ['the_muse', 'The Muse'],
  ])('labels known provider id %j as %j', (provider, label) => {
    expect(discoveryProviderLabel(provider)).toBe(label);
  });

  it('falls back to a title-cased version of an unrecognized id rather than leaking the raw id or rendering nothing', () => {
    expect(discoveryProviderLabel('some_future_source')).toBe('Some Future Source');
  });

  it('never returns the raw underscored id for a recognized provider', () => {
    expect(discoveryProviderLabel('devitjobs_uk')).not.toBe('devitjobs_uk');
    expect(discoveryProviderLabel('devitjobs_uk')).not.toContain('_');
  });
});
