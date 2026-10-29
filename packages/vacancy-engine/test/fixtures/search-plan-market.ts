import { AtsResponseError, type AtsHttpClient, type AtsHttpResponse } from '../../src/ats/http.js';

/**
 * SYNTHETIC labelled corpus for issue #686. Every company, title, URL and description below is made
 * up for this test. The `equivalent` label is the fixture author's own construction ("this row is a
 * frontend role in the family the plan asks for"), not a human relevance judgement and not a claim
 * about any real job site, its coverage or its ranking.
 */
export interface SyntheticJob {
  id: string;
  title: string;
  company: string;
  url: string;
  description: string;
  /** Fixture-author label: counts toward the labelled-equivalent total for the measurement. */
  equivalent: boolean;
  /** Which synthetic upstream serves it. */
  source: 'himalayas' | 'jobicy' | 'jobtech' | 'arbeitnow';
}

const GENERIC = 'Remote role. Collaborate with a small distributed team on our product.';

export const SYNTHETIC_CORPUS: readonly SyntheticJob[] = [
  { id: 'h1', source: 'himalayas', equivalent: true, title: 'React Developer', company: 'Acme Labs', url: 'https://job-boards.greenhouse.io/acmelabs/jobs/1001', description: GENERIC },
  { id: 'h2', source: 'himalayas', equivalent: true, title: 'Frontend Engineer', company: 'Beta Works', url: 'https://job-boards.greenhouse.io/betaworks/jobs/2001', description: GENERIC },
  { id: 'h3', source: 'himalayas', equivalent: true, title: 'UI Engineer', company: 'Gamma Studio', url: 'https://job-boards.greenhouse.io/gammastudio/jobs/3001', description: GENERIC },
  { id: 'h4', source: 'himalayas', equivalent: false, title: 'Backend Engineer', company: 'Delta Systems', url: 'https://job-boards.greenhouse.io/deltasystems/jobs/4001', description: GENERIC },
  {
    id: 'h5', source: 'himalayas', equivalent: true, title: 'Frontend ontwikkelaar', company: 'Eerste Software BV',
    url: 'https://job-boards.greenhouse.io/eerstesoftware/jobs/5001',
    // A Dutch advert that never states a language requirement.
    description: 'Wij zoeken een ontwikkelaar voor ons team. Je bouwt mee aan onze webapplicatie.',
  },
  {
    id: 'h6', source: 'himalayas', equivalent: true, title: 'Frontend Engineer (Dutch market)', company: 'Zesde Digitaal BV',
    url: 'https://job-boards.greenhouse.io/zesdedigitaal/jobs/6001',
    description: 'Requirements\nFluent Dutch is required. Je werkt dagelijks met klanten in het Nederlands.',
  },
  {
    // A Dutch advert for an English-titled role that states NO language requirement at all.
    id: 'h8', source: 'himalayas', equivalent: true, title: 'Frontend Engineer', company: 'Achtste Software BV',
    url: 'https://job-boards.greenhouse.io/achtstesoftware/jobs/8801',
    description: 'Wij zoeken een frontend engineer voor ons team. Je bouwt mee aan onze webapplicatie.',
  },
  { id: 'h7', source: 'himalayas', equivalent: false, title: 'UI Designer', company: 'Epsilon Design', url: 'https://job-boards.greenhouse.io/epsilondesign/jobs/7001', description: GENERIC },
  // The same underlying requisition as h2, listed again by another upstream below (j2): must merge.
  { id: 'j1', source: 'jobicy', equivalent: true, title: 'React Developer', company: 'Acme Labs', url: 'https://job-boards.greenhouse.io/acmelabs/jobs/1001', description: GENERIC },
  { id: 'j2', source: 'jobicy', equivalent: true, title: 'Frontend Engineer', company: 'Beta Works', url: 'https://job-boards.greenhouse.io/betaworks/jobs/2001', description: GENERIC },
  { id: 'j3', source: 'jobicy', equivalent: true, title: 'Senior UI Engineer', company: 'Zeta Interfaces', url: 'https://job-boards.greenhouse.io/zetainterfaces/jobs/8001', description: GENERIC },
  { id: 'j4', source: 'jobicy', equivalent: false, title: 'Data Engineer', company: 'Kappa Data', url: 'https://job-boards.greenhouse.io/kappadata/jobs/9001', description: GENERIC },
  { id: 'jt1', source: 'jobtech', equivalent: true, title: 'Frontend Engineer', company: 'Lambda Nordic', url: 'https://example.invalid/jobtech/lambda-frontend', description: GENERIC },
  // A feed with no role filter: it returns everything whatever the title, so only the shared local filter can pick from it.
  { id: 'a1', source: 'arbeitnow', equivalent: true, title: 'Frontend Engineer (Remote)', company: 'Eta Cloud', url: 'https://www.arbeitnow.com/jobs/eta-frontend', description: GENERIC },
  { id: 'a2', source: 'arbeitnow', equivalent: true, title: 'React Developer', company: 'Theta Apps', url: 'https://www.arbeitnow.com/jobs/theta-react', description: GENERIC },
  { id: 'a3', source: 'arbeitnow', equivalent: true, title: 'UI Engineer', company: 'Omicron Web', url: 'https://www.arbeitnow.com/jobs/omicron-ui', description: GENERIC },
  { id: 'a4', source: 'arbeitnow', equivalent: false, title: 'Sales Manager', company: 'Sigma Sales', url: 'https://www.arbeitnow.com/jobs/sigma-sales', description: GENERIC },
  // Two DIFFERENT requisitions: same company, same title, different ATS requisition ids.
  { id: 'a5', source: 'arbeitnow', equivalent: true, title: 'Frontend Engineer', company: 'Iota Platforms', url: 'https://job-boards.greenhouse.io/iotaplatforms/jobs/111', description: GENERIC },
  { id: 'a6', source: 'arbeitnow', equivalent: true, title: 'Frontend Engineer', company: 'Iota Platforms', url: 'https://job-boards.greenhouse.io/iotaplatforms/jobs/222', description: GENERIC },
];

export interface MarketRequest {
  url: string;
  host: string;
}

function ok(url: string, body: unknown): AtsHttpResponse {
  return { status: 200, finalUrl: url, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function matchesUpstreamQuery(job: SyntheticJob, query: string | null): boolean {
  if (!query) return true;
  return `${job.title} ${job.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

/**
 * A fake upstream for the synthetic corpus. It answers only the sources that exist in the corpus
 * (every other source's request is a 404, as an unreachable source would be) and filters server-side
 * ONLY where the real source declares a role filter: Himalayas (`q`), Jobicy (`tag`) and JobTech (`q`).
 * Arbeitnow has no role filter, so it returns its whole feed whatever the request carries.
 */
export class SyntheticMarket implements AtsHttpClient {
  public readonly requests: MarketRequest[] = [];

  public constructor(private readonly corpus: readonly SyntheticJob[] = SYNTHETIC_CORPUS) {}

  public requestsTo(host: string): number {
    return this.requests.filter((request) => request.host === host).length;
  }

  public async get(url: string): Promise<AtsHttpResponse> {
    const parsed = new URL(url);
    this.requests.push({ url, host: parsed.hostname });
    if (parsed.hostname === 'himalayas.app') {
      const jobs = this.corpus.filter((job) => job.source === 'himalayas' && matchesUpstreamQuery(job, parsed.searchParams.get('q')));
      return ok(url, {
        totalCount: jobs.length,
        jobs: jobs.map((job) => ({
          guid: `himalayas-${job.id}`,
          title: job.title,
          companyName: job.company,
          applicationLink: job.url,
          description: job.description,
          locationRestrictions: ['Netherlands'],
          employmentType: 'Full Time',
        })),
      });
    }
    if (parsed.hostname === 'jobicy.com') {
      const jobs = this.corpus.filter((job) => job.source === 'jobicy' && matchesUpstreamQuery(job, parsed.searchParams.get('tag')));
      return ok(url, {
        jobs: jobs.map((job) => ({ id: job.id, jobTitle: job.title, companyName: job.company, url: job.url, jobGeo: 'Anywhere', jobType: ['full-time'] })),
      });
    }
    if (parsed.hostname === 'jobsearch.api.jobtechdev.se') {
      const jobs = this.corpus.filter((job) => job.source === 'jobtech' && matchesUpstreamQuery(job, parsed.searchParams.get('q')));
      return ok(url, {
        total: { value: jobs.length },
        hits: jobs.map((job) => ({
          id: job.id,
          headline: job.title,
          webpage_url: job.url,
          employer: { name: job.company },
          workplace_address: { country: 'Sweden' },
          employment_type: { label: 'Full-time' },
        })),
      });
    }
    if (parsed.hostname === 'www.arbeitnow.com') {
      const jobs = this.corpus.filter((job) => job.source === 'arbeitnow');
      return ok(url, {
        data: jobs.map((job) => ({
          slug: job.id,
          title: job.title,
          company_name: job.company,
          url: job.url,
          remote: true,
          location: 'Remote',
          description: job.description,
          job_types: ['full-time'],
          created_at: 1_790_000_000,
        })),
        links: {},
      });
    }
    throw new AtsResponseError('synthetic-market', 'no such upstream in the synthetic corpus', 404);
  }

  public async postJson(url: string): Promise<AtsHttpResponse> {
    this.requests.push({ url, host: new URL(url).hostname });
    throw new AtsResponseError('synthetic-market', 'no such upstream in the synthetic corpus', 404);
  }
}
