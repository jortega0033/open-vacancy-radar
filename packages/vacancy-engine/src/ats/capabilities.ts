import type { AtsProvider } from '../domain/models.js';

export type AtsCapability = {
  provider: AtsProvider;
  status: 'supported' | 'fallback' | 'experimental';
  productionAdapter: boolean;
  ingestionMode: 'linked_index' | 'disabled';
  retrieval: string;
  note: string;
};

/** Capability claims are explicit so experimental research is not mistaken for production support. */
export const ATS_CAPABILITIES: readonly AtsCapability[] = [
  {
    provider: 'ashby',
    status: 'supported',
    productionAdapter: true,
    ingestionMode: 'linked_index',
    retrieval: 'official public Job Postings JSON API',
    note: 'Compensation is requested with the public board listing when the employer exposes it.',
  },
  {
    provider: 'greenhouse',
    status: 'supported',
    productionAdapter: true,
    ingestionMode: 'linked_index',
    retrieval: 'official public Job Board JSON API',
    note: 'Full descriptions are requested in the board list.',
  },
  {
    provider: 'lever',
    status: 'supported',
    productionAdapter: true,
    ingestionMode: 'linked_index',
    retrieval: 'official public Postings JSON API',
    note: 'Global and EU API origins are preserved from the discovered board URL.',
  },
  {
    provider: 'teamtailor',
    status: 'supported',
    productionAdapter: true,
    ingestionMode: 'linked_index',
    retrieval: 'official careers-site RSS feed',
    note: 'Requires an exact discovered RSS feed URL.',
  },
  {
    provider: 'recruitee',
    status: 'supported',
    productionAdapter: true,
    ingestionMode: 'linked_index',
    retrieval: 'public careers-site XML offer feed',
    note: 'Avoids the Careers Site JSON token migration.',
  },
  {
    provider: 'smartrecruiters',
    status: 'supported',
    productionAdapter: true,
    ingestionMode: 'linked_index',
    retrieval: 'official public postings list and detail JSON API',
    note: 'Detail fan-out is bounded and sequential through the injected HTTP policy.',
  },
  {
    provider: 'json_ld',
    status: 'fallback',
    productionAdapter: true,
    ingestionMode: 'linked_index',
    retrieval: 'verified official careers page plus same-origin JobPosting detail HTML',
    note: 'One configured seed and detail-path prefix; one link level and 100 details maximum by default.',
  },
  {
    provider: 'personio',
    status: 'supported',
    productionAdapter: true,
    ingestionMode: 'linked_index',
    retrieval: 'official public careers XML feed',
    note: 'Linked-index mode. Use description text only for local matching; preserve the observed .de or .com tenant origin and canonical link.',
  },
  {
    provider: 'workable',
    status: 'supported',
    productionAdapter: true,
    ingestionMode: 'linked_index',
    retrieval: 'official public account jobs JSON API',
    note: 'Linked-index mode. Uses description text only for local matching and preserves Workable-hosted canonical application URLs.',
  },
  {
    provider: 'workday',
    status: 'supported',
    productionAdapter: true,
    ingestionMode: 'linked_index',
    retrieval: 'public Workday CXS listing and detail JSON endpoints',
    note: 'Sequential pagination is capped at 100 pages and detail hydration at 500 jobs; cap hits remain incomplete.',
  },
  {
    provider: 'successfactors',
    status: 'supported',
    productionAdapter: true,
    ingestionMode: 'linked_index',
    retrieval: 'public career-site job sitemap plus same-origin structured job details',
    note: 'Linked-index mode. Uses description text only for local matching; exact-origin hydration is sequential and bounded.',
  },
] as const;
