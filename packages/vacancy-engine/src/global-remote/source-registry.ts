import type { GlobalRemoteConfig, SourceRegistryEntry } from './models.js';

const active = (
  id: string,
  name: string,
  url: string,
  transport: SourceRegistryEntry['transport'],
  provider: NonNullable<SourceRegistryEntry['provider']>,
  ingestionMode: SourceRegistryEntry['ingestionMode'] = 'linked_index',
): SourceRegistryEntry => ({
  id,
  name,
  url,
  transport,
  state: 'active',
  ingestionMode,
  provider,
  adapter: 'active',
  reason: 'Enabled deterministic adapter using a public API, structured endpoint, RSS feed, or MCP endpoint.',
});

const entry = (
  value: Omit<SourceRegistryEntry, 'adapter' | 'ingestionMode'> & { adapter?: SourceRegistryEntry['adapter']; ingestionMode?: SourceRegistryEntry['ingestionMode'] },
): SourceRegistryEntry => ({ adapter: 'none', ingestionMode: 'disabled', ...value });

const gated = (
  id: string,
  name: string,
  url: string,
  provider: NonNullable<SourceRegistryEntry['provider']>,
  configuredReason: string,
): SourceRegistryEntry => ({
  id,
  name,
  url,
  transport: 'api',
  state: 'configuration_required',
  ingestionMode: 'disabled',
  provider,
  adapter: 'ready',
  reason: `Adapter is implemented but disabled until ${configuredReason} ${configuredReason.includes(' and ') ? 'are' : 'is'} explicitly configured for this project.`,
});

export function globalRemoteSourceRegistry(config: GlobalRemoteConfig): SourceRegistryEntry[] {
  const muse = config.discovery.museEnabled
    ? active(
        'the_muse',
        'The Muse Public Jobs API',
        'https://www.themuse.com/developers/api/v2',
        'api',
        'the_muse',
      )
    : entry({
        id: 'the_muse',
        name: 'The Muse Public Jobs API',
        url: 'https://www.themuse.com/developers/api/v2',
        transport: 'api',
        state: 'configuration_required',
        provider: 'the_muse',
        adapter: 'ready',
        reason: 'Adapter is implemented but disabled until project-specific API registration/terms approval is explicitly confirmed.',
      });
  const adzuna = config.discovery.adzunaAppId.trim().length > 0 && config.discovery.adzunaAppKey.trim().length > 0
    ? active('adzuna', 'Adzuna Search API', 'https://developer.adzuna.com/docs/search', 'api', 'adzuna')
    : gated('adzuna', 'Adzuna Search API', 'https://developer.adzuna.com/docs/search', 'adzuna', 'ADZUNA_APP_ID and ADZUNA_APP_KEY');
  const jooble = config.discovery.joobleApiKey.trim().length > 0
    ? active('jooble', 'Jooble REST API', 'https://help.jooble.org/en/support/solutions/articles/60001448238-rest-api-documentation', 'api', 'jooble')
    : gated('jooble', 'Jooble REST API', 'https://help.jooble.org/en/support/solutions/articles/60001448238-rest-api-documentation', 'jooble', 'JOOBLE_API_KEY');
  const reed = config.discovery.reedApiKey.trim().length > 0
    ? active('reed', 'Reed Jobseeker API', 'https://www.reed.co.uk/developers/jobseeker', 'api', 'reed')
    : gated('reed', 'Reed Jobseeker API', 'https://www.reed.co.uk/developers/jobseeker', 'reed', 'REED_API_KEY');
  const jobspipe = config.discovery.jobspipeApiKey.trim().length > 0
    ? active('jobspipe', 'JobsPipe Search API', 'https://docs.jobspipe.dev/api-reference/jobs-search', 'api', 'jobspipe')
    : gated('jobspipe', 'JobsPipe Search API', 'https://docs.jobspipe.dev/api-reference/jobs-search', 'jobspipe', 'JOBSPIPE_API_KEY (credit-metered)');

  return [
    active('himalayas', 'Himalayas Remote Jobs API', 'https://himalayas.app/docs/remote-jobs-api', 'api', 'himalayas', 'full_ingestion'),
    active('jobicy', 'Jobicy Remote Jobs API', 'https://jobicy.com/jobs-rss-feed', 'api', 'jobicy', 'full_ingestion'),
    active('remotive', 'Remotive Remote Jobs RSS Feed', 'https://remotive.com/remote-jobs/feed', 'rss', 'remotive', 'full_ingestion'),
    active('freehire', 'Freehire API', 'https://freehire.me/docs/api', 'api', 'freehire'),
    active('job_opportunities', 'Job Opportunities API', 'https://jobopportunitiesapi.org/docs/endpoints/public', 'api', 'job_opportunities'),
    active('remote_landers', 'Remote Landers API', 'https://remotelanders.com/api', 'api', 'remote_landers'),
    active('jobgether', 'Jobgether Job Search API', 'https://jobgether.com/developers', 'api', 'jobgether'),
    active('we_work_remotely', 'We Work Remotely RSS', 'https://weworkremotely.com/remote-job-rss-feed', 'rss', 'we_work_remotely', 'full_ingestion'),
    active('remote_first_jobs', 'Remote First Jobs API', 'https://remotefirstjobs.com/jobs-api', 'api', 'remote_first_jobs'),
    active('job_remotely', 'JobRemotely API', 'https://jobremotely.io/developers', 'api', 'job_remotely'),
    active('remote_ok', 'Remote OK API', 'https://remoteok.com/api', 'api', 'remote_ok', 'full_ingestion'),
    active('arbeitnow', 'Arbeitnow Job Board API', 'https://www.arbeitnow.com/blog/job-board-api', 'api', 'arbeitnow'),
    active('startup_jobs', 'Startup Jobs RSS', 'https://startup.jobs/api', 'rss', 'startup_jobs'),
    active('devitjobs_nl', 'DevITJobs Netherlands RSS', 'https://devitjobs.nl/rss', 'rss', 'devitjobs_nl'),
    active('jobs_collider', 'JobsCollider RSS', 'https://github.com/JobsCollider/remote-jobs-rss', 'rss', 'jobs_collider'),
    active('working_nomads', 'Working Nomads Public Jobs Feed', 'https://www.workingnomads.com/jobsapi', 'api', 'working_nomads'),
    active('real_work_from_anywhere', 'Real Work From Anywhere Frontend RSS', 'https://www.realworkfromanywhere.com/rss-feeds', 'rss', 'real_work_from_anywhere'),
    active('devitjobs_uk', 'DevITJobs United Kingdom RSS', 'https://devitjobs.uk/rss', 'rss', 'devitjobs_uk'),
    active('dice', 'Dice MCP Job Search', 'https://www.dice.com/career-advice/how-to-connect-the-dice-mcp-server-to-your-ai-assistant', 'mcp', 'dice'),
    active('jobspresso', 'Jobspresso Job Feed', 'https://jobspresso.co/?feed=job_feed', 'rss', 'jobspresso'),
    active('remote_frontend_jobs', 'Remote Frontend Jobs RSS', 'https://www.remotefrontendjobs.com/feed.xml', 'rss', 'remote_frontend_jobs'),
    active('un_careers', 'United Nations Careers RSS', 'https://careers.un.org/jobfeed?language=en', 'rss', 'un_careers'),
    active('jobtech_sweden', 'Arbetsförmedlingen JobSearch API', 'https://jobsearch.api.jobtechdev.se/', 'api', 'jobtech_sweden', 'full_ingestion'),
    active('workable_global', 'Workable all-customer XML feed', 'https://www.workable.com/boards/workable.xml', 'structured', 'workable_global', 'full_ingestion'),
    muse,
    adzuna,
    jooble,
    reed,
    jobspipe,
    entry({ id: 'careeronestop', name: 'CareerOneStop Jobs API', url: 'https://api.careeronestop.org/api-explorer/home/index/JobSearchV2_GetJobsByKeywordAndOnetCode', transport: 'api', state: 'configuration_required', provider: null, reason: 'Requires an approved user id and bearer token; no adapter implemented yet pending live-verified contract.' }),
    entry({ id: 'usajobs', name: 'USAJOBS Search API', url: 'https://developer.usajobs.gov/api-reference/get-api-search', transport: 'api', state: 'configuration_required', provider: null, reason: 'Requires a registered email and API key; most federal roles are unlikely to meet outside-US eligibility, so no adapter has been implemented yet.' }),
    entry({ id: 'careerjet', name: 'Careerjet Publisher API', url: 'https://www.careerjet.com/partners/api/', transport: 'api', state: 'partner_required', provider: null, reason: 'Publisher approval and partner credentials are required.' }),
    entry({ id: 'talent', name: 'Talent.com Publisher Feed/API', url: 'https://employers.talent.com/publishers', transport: 'api', state: 'partner_required', provider: null, reason: 'Publisher approval and partner feed/API access are required.' }),
    entry({ id: 'glassdoor_partner', name: 'Glassdoor Partner API', url: 'https://www.glassdoor.com/developer/index.htm', transport: 'api', state: 'partner_required', provider: null, reason: 'No general public vacancy API; an approved partner agreement is required.' }),
    entry({ id: 'talroo', name: 'Talroo Publisher API', url: 'https://www.talroo.com/publishers/', transport: 'api', state: 'partner_required', provider: null, reason: 'Publisher approval and partner credentials are required.' }),
    entry({ id: 'ziprecruiter', name: 'ZipRecruiter MCP', url: 'https://api.ziprecruiter.com/mcp/docs', transport: 'mcp', state: 'blocked', provider: null, reason: 'Direct deterministic requests currently receive HTTP 403 from Cloudflare; recorded without bypass attempts.' }),
    entry({ id: 'eures', name: 'EURES / European Job Days', url: 'https://eures.europa.eu/data-protection-statements/data-protection-statement-and-specific-terms-and-conditions-use-eures-portal-services_en', transport: 'none', state: 'prohibited', provider: null, reason: 'EURES job-search terms prohibit automated or manual extraction for further processing or republication; do not ingest without recognized partner access.' }),
    entry({ id: 'wellfound', name: 'Wellfound', url: 'https://wellfound.com/jobs', transport: 'none', state: 'manual_only', provider: null, reason: 'No verified public job-search API/feed suitable for deterministic production retrieval.' }),
    entry({ id: 'welcome_to_the_jungle', name: 'Welcome to the Jungle', url: 'https://www.welcometothejungle.com/en/jobs', transport: 'none', state: 'manual_only', provider: null, reason: 'No verified public job-search API/feed suitable for deterministic production retrieval.' }),
    entry({ id: 'built_in', name: 'Built In', url: 'https://builtin.com/jobs', transport: 'none', state: 'manual_only', provider: null, reason: 'No verified public job-search API/feed suitable for deterministic production retrieval.' }),
    entry({ id: 'flexjobs', name: 'FlexJobs', url: 'https://www.flexjobs.com/remote-jobs/computer-it', transport: 'none', state: 'manual_only', provider: null, reason: 'Paid/login-gated portal; not crawled.' }),
    entry({ id: 'monster', name: 'Monster', url: 'https://www.monster.com/jobs/', transport: 'none', state: 'manual_only', provider: null, reason: 'No verified public job-search API/feed suitable for deterministic production retrieval.' }),
    entry({ id: 'simplyhired', name: 'SimplyHired', url: 'https://www.simplyhired.com/search', transport: 'none', state: 'manual_only', provider: null, reason: 'No verified public job-search API/feed suitable for deterministic production retrieval.' }),
    entry({ id: 'remote_co', name: 'Remote.co', url: 'https://remote.co/remote-jobs/developer/', transport: 'none', state: 'manual_only', provider: null, reason: 'No verified public API/feed; HTML portal remains a documented coverage gap.' }),
    entry({ id: 'nodesk', name: 'NoDesk', url: 'https://nodesk.co/remote-jobs/developer/', transport: 'none', state: 'manual_only', provider: null, reason: 'No verified public API/feed; HTML portal remains a documented coverage gap.' }),
    entry({ id: 'justremote', name: 'JustRemote', url: 'https://justremote.co/remote-developer-jobs', transport: 'none', state: 'manual_only', provider: null, reason: 'No verified public API/feed; HTML portal remains a documented coverage gap.' }),
    entry({ id: 'dailyremote', name: 'DailyRemote', url: 'https://dailyremote.com/remote-software-development-jobs', transport: 'none', state: 'manual_only', provider: null, reason: 'No verified public API/feed; HTML portal remains a documented coverage gap.' }),
    entry({ id: 'linkedin', name: 'LinkedIn Jobs', url: 'https://www.linkedin.com/jobs/', transport: 'none', state: 'prohibited', provider: null, reason: 'Direct LinkedIn scraping is explicitly prohibited by project policy.' }),
    entry({ id: 'indeed', name: 'Indeed', url: 'https://www.indeed.com/', transport: 'none', state: 'prohibited', provider: null, reason: 'Direct portal scraping is not implemented; only a sanctioned partner/API integration would be eligible.' }),
    entry({ id: 'glassdoor_direct', name: 'Glassdoor Direct', url: 'https://www.glassdoor.com/Job/index.htm', transport: 'none', state: 'prohibited', provider: null, reason: 'Direct portal scraping is not implemented; only the separately listed partner API is eligible.' }),
    entry({ id: 'google_jobs', name: 'Google Jobs', url: 'https://www.google.com/search?q=frontend+developer+jobs', transport: 'none', state: 'prohibited', provider: null, reason: 'Automated Google result-page/browser scraping is not part of the production architecture.' }),
  ];
}
