import type { DiscoveryProvider } from '@open-vacancy-radar/vacancy-engine';

/**
 * Display name for a worldwide-scan `DiscoveryProvider` feed id. Distinct from `PROVIDER_LABEL` in
 * `provider-labels.ts`: that map names the AI-CLI runtime (Claude Code, Codex) driving the app's own
 * agent features, an entirely different concept from which upstream job feed produced a vacancy row.
 *
 * A confirmed UX audit finding: the Search results card, the "Vacancy source" detail card, and the
 * Overview "Source" field all rendered this raw id verbatim -- `devitjobs_uk`, `we_work_remotely` --
 * instead of a name a candidate would recognize. This map is `Record<DiscoveryProvider, string>` so
 * TypeScript enforces a label for every id the engine currently knows about; adding a new provider to
 * `DiscoveryProvider` (`packages/vacancy-engine/src/global-remote/models.ts`) without adding it here
 * is a type error, not a silently-unlabelled row.
 */
const DISCOVERY_PROVIDER_LABEL: Record<DiscoveryProvider, string> = {
  himalayas: 'Himalayas',
  jobicy: 'Jobicy',
  remotive: 'Remotive',
  freehire: 'FreeHire',
  job_opportunities: 'Job Opportunities',
  remote_landers: 'Remote Landers',
  jobgether: 'Jobgether',
  we_work_remotely: 'We Work Remotely',
  remote_first_jobs: 'Remote First Jobs',
  job_remotely: 'Job Remotely',
  remote_ok: 'Remote OK',
  arbeitnow: 'Arbeitnow',
  startup_jobs: 'Startup Jobs',
  devitjobs_nl: 'DevITjobs NL',
  jobs_collider: 'Jobs Collider',
  working_nomads: 'Working Nomads',
  real_work_from_anywhere: 'Real Work From Anywhere',
  devitjobs_uk: 'DevITjobs UK',
  dice: 'Dice',
  remoote: 'Remoote',
  ai_dev_jobs: 'AI Dev Jobs',
  taiwan_jobs: 'Taiwan Jobs',
  the_muse: 'The Muse',
  jobspresso: 'Jobspresso',
  remote_frontend_jobs: 'Remote Frontend Jobs',
  un_careers: 'UN Careers',
  jobtech_sweden: 'JobTech Sweden',
  workable_global: 'Workable',
  adzuna: 'Adzuna',
  jooble: 'Jooble',
  reed: 'Reed',
  jobspipe: 'Jobspipe',
  ats_roster_greenhouse: 'Greenhouse (ATS roster)',
  ats_roster_lever: 'Lever (ATS roster)',
  ats_roster_ashby: 'Ashby (ATS roster)',
  ats_roster_recruitee: 'Recruitee (ATS roster)',
  ats_roster_personio: 'Personio (ATS roster)',
  nav_arbeidsplassen: 'NAV Arbeidsplassen',
};

/**
 * Human label for a raw discovery provider id, e.g. `devitjobs_uk` -> "DevITjobs UK". Takes a plain
 * `string`, not `DiscoveryProvider`, because `SearchResult.provider` (`components/search/results.ts`)
 * is typed as a plain string -- it also has to carry whatever a persisted report from an older engine
 * version wrote, which can predate a since-added `DiscoveryProvider` member. An id this map doesn't
 * recognize falls back to a readable-ized version of the raw id (snake_case -> Title Case) rather than
 * leaking the underscored id or rendering nothing.
 */
export function discoveryProviderLabel(provider: string): string {
  const known = (DISCOVERY_PROVIDER_LABEL as Record<string, string | undefined>)[provider];
  if (known) return known;
  return provider
    .split('_')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
