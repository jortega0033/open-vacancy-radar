import { canonicalizeVacancyUrl, normalizeVacancyText } from './hash.js';

/**
 * How a vacancy's canonical identity (issue #278) was established, ordered by trust, most
 * authoritative first:
 *  - `requisition`: an employer/ATS-tenant plus the ATS's own requisition/posting ID, extracted
 *    from a recognized direct-ATS URL shape (see `atsRequisitionFor`). The same requisition ID
 *    cannot exist twice at one tenant, and two different requisitions never share one -- the
 *    strongest signal this module has.
 *  - `canonical_url`: a normalized destination URL match, used when no requisition ID could be
 *    extracted but the URL still looks like one specific posting rather than a shared
 *    listing/search/careers-root page (see `isGenericListingUrl`) -- e.g. a Workable apply link, or
 *    a company's own custom-domain job page that isn't one of the ATS providers this module
 *    recognizes by URL shape.
 *  - `semantic`: company + normalized title + normalized location, the weakest signal, used only
 *    when neither of the above resolves (e.g. two rows both linking to the same generic careers
 *    page). Deliberately company-scoped and description-free -- see `semanticIdentityKey`'s doc
 *    comment for why, and for the one documented case it cannot distinguish.
 */
export type VacancyIdentityKind = 'requisition' | 'canonical_url' | 'semantic';

export type VacancyIdentity = {
  kind: VacancyIdentityKind;
  /** The exact string two rows must match on (case-sensitive) to be treated as the same vacancy. */
  key: string;
  /** Set only when `kind === 'requisition'`: the ATS provider + tenant slug the requisition ID is
   * scoped to (e.g. `greenhouse:stripe`). Null for every other kind. */
  employerKey: string | null;
  /** Set only when `kind === 'requisition'`: the ATS-native requisition/posting ID itself. Null for
   * every other kind. */
  requisitionId: string | null;
};

/**
 * Whether a vacancy's `applyUrl` has actually been confirmed to resolve to this exact role (issue
 * #278). Only ever `verified` when the identity behind it is `requisition` -- a generic careers
 * page, an aggregator listing page, or a search-result snippet can at most earn `unresolved`, never
 * `verified`, no matter how confident the discovering source's own label sounds (see
 * `resolveApplyUrl`). `blocked` is reserved for a later, live-verification layer (the official ATS
 * pipeline, `global-remote/official.ts`, which can observe an actual HTTP failure) -- pure
 * discovery-time resolution never produces it on its own.
 */
export type ApplyUrlStatus = 'verified' | 'unresolved' | 'blocked';

export type ApplyUrlEvidence = {
  status: ApplyUrlStatus;
  /** The best candidate application URL this row has, or null when nothing usable was found. */
  url: string | null;
  reasons: string[];
};

type AtsTenantProvider = 'greenhouse' | 'lever' | 'ashby' | 'personio' | 'recruitee' | 'rippling';

type TenantRequisition = { tenant: string; requisitionId: string };

function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter((segment) => segment.length > 0);
}

/** `https://job-boards.greenhouse.io/{tenant}/jobs/{id}`, the legacy `boards.greenhouse.io` widget
 * host, and the `boards-api.greenhouse.io/v1/boards/{tenant}/jobs/{id}` API host -- all three are
 * real `job.absolute_url`/board shapes this codebase's own `GreenhouseAdapter` and aggregator feeds
 * both produce. */
function greenhouseRequisition(url: URL): TenantRequisition | null {
  if (
    !['job-boards.greenhouse.io', 'boards.greenhouse.io', 'boards-api.greenhouse.io'].includes(
      url.hostname.toLowerCase(),
    )
  ) {
    return null;
  }
  const parts = pathSegments(url);
  const jobsIndex = parts.indexOf('jobs');
  const tenant = jobsIndex > 0 ? parts[jobsIndex - 1] : undefined;
  const requisitionId = jobsIndex >= 0 ? parts[jobsIndex + 1] : undefined;
  return tenant === undefined || requisitionId === undefined ? null : { tenant, requisitionId };
}

/** `https://jobs.lever.co/{tenant}/{postingId}` (and the `.eu.` variant), plus the
 * `api(.eu).lever.co/v0/postings/{tenant}/{postingId}` API shape. */
function leverRequisition(url: URL): TenantRequisition | null {
  const hostname = url.hostname.toLowerCase();
  if (!['jobs.lever.co', 'jobs.eu.lever.co', 'api.lever.co', 'api.eu.lever.co'].includes(hostname)) {
    return null;
  }
  const parts = pathSegments(url);
  const startIndex = hostname.startsWith('api.') ? parts.indexOf('postings') + 1 : 0;
  const tenant = startIndex >= 1 ? parts[startIndex] : parts[0];
  const requisitionId = startIndex >= 1 ? parts[startIndex + 1] : parts[1];
  return tenant === undefined || requisitionId === undefined ? null : { tenant, requisitionId };
}

/** `https://jobs.ashbyhq.com/{tenant}/{jobId}`, matching `job.jobUrl` from Ashby's public API. */
function ashbyRequisition(url: URL): TenantRequisition | null {
  if (url.hostname.toLowerCase() !== 'jobs.ashbyhq.com') return null;
  const [tenant, requisitionId] = pathSegments(url);
  return tenant === undefined || requisitionId === undefined ? null : { tenant, requisitionId };
}

const PERSONIO_HOSTNAME = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.jobs\.personio\.(?:de|com)$/iu;

/** `https://{tenant}.jobs.personio.(de|com)/job/{id}`, matching the URL `PersonioAdapter` builds
 * from the XML feed's numeric `<id>`. */
function personioRequisition(url: URL): TenantRequisition | null {
  const tenant = PERSONIO_HOSTNAME.exec(url.hostname.toLowerCase())?.[1];
  const parts = pathSegments(url);
  const requisitionId = parts[0] === 'job' ? parts[1] : undefined;
  return tenant === undefined || requisitionId === undefined ? null : { tenant, requisitionId };
}

/** `https://{tenant}.recruitee.com/o/{offer-slug}`, matching the feed's own `careers-url`. The
 * offer slug (not a separate numeric ID) is what the public URL exposes, but it is stable per
 * posting within one tenant, which is what this tier needs. */
function recruiteeRequisition(url: URL): TenantRequisition | null {
  const suffix = '.recruitee.com';
  const hostname = url.hostname.toLowerCase();
  if (!hostname.endsWith(suffix)) return null;
  const tenant = hostname.slice(0, -suffix.length);
  const parts = pathSegments(url);
  const requisitionId = parts[0] === 'o' ? parts[1] : undefined;
  return tenant.length === 0 || requisitionId === undefined ? null : { tenant, requisitionId };
}

/** `https://ats.rippling.com/{tenant}/jobs/{uuid}`, the per-posting extension of the board URL
 * shape `ats/detection.ts#detectRipplingSource` already recognizes. */
function ripplingRequisition(url: URL): TenantRequisition | null {
  if (url.hostname.toLowerCase() !== 'ats.rippling.com') return null;
  const [tenant, jobsMarker, requisitionId] = pathSegments(url);
  return tenant === undefined || jobsMarker?.toLowerCase() !== 'jobs' || requisitionId === undefined
    ? null
    : { tenant, requisitionId };
}

const REQUISITION_EXTRACTORS: readonly [AtsTenantProvider, (url: URL) => TenantRequisition | null][] = [
  ['greenhouse', greenhouseRequisition],
  ['lever', leverRequisition],
  ['ashby', ashbyRequisition],
  ['personio', personioRequisition],
  ['recruitee', recruiteeRequisition],
  ['rippling', ripplingRequisition],
];

/**
 * Extracts an employer/ATS-tenant + requisition ID from a URL that matches one of this module's
 * recognized direct-ATS detail-page shapes -- issue #278's first-priority identity tier. Covers
 * exactly the providers `global-remote/ats-roster-discovery.ts` already scans directly (greenhouse,
 * lever, ashby, personio, recruitee) plus rippling (`ats/rippling.ts`), so an aggregator that
 * preserves the real destination URL (issues #6/#257) and this repo's own official/roster adapters
 * for the same job converge on one identity regardless of which one discovered it first.
 *
 * Deliberately narrower than `ats/detection.ts#detectAtsSource`, which only resolves a *board*, not
 * a specific posting: a requisition ID needs the job-detail path segment board-level detection never
 * reads. Workday and SuccessFactors are not covered here -- neither exposes a stable,
 * generically-parseable requisition ID in its public URL shape -- so both fall through to the
 * `canonical_url` tier below, same as any other ATS this module does not special-case.
 */
export function atsRequisitionFor(
  rawUrl: string,
): { provider: AtsTenantProvider; tenant: string; requisitionId: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  for (const [provider, extractor] of REQUISITION_EXTRACTORS) {
    const found = extractor(url);
    if (found !== null && found.tenant.length > 0 && found.requisitionId.length > 0) {
      return { provider, tenant: found.tenant, requisitionId: found.requisitionId };
    }
  }
  return null;
}

const GENERIC_LISTING_LAST_SEGMENTS = new Set([
  'careers', 'career', 'jobs', 'job', 'job-openings', 'openings', 'open-positions', 'open-roles',
  'positions', 'vacancies', 'vacancy', 'search', 'job-search', 'find-jobs', 'browse',
  'opportunities', 'apply', 'work-with-us', 'join-us', 'hiring', 'talent', 'jobboard', 'job-board',
]);

/** Query keys that, when present, mark a URL as pointing at one specific posting even if its path
 * otherwise looks generic (e.g. `/careers?jobId=4821`). */
const SPECIFIC_QUERY_KEYS =
  /^(?:job|jobs?id|job_id|gh_jid|posting|postingid|req|reqid|requisition|requisitionid|id)$/iu;

/**
 * True when a URL looks like a shared listing/search/careers-root page rather than one specific
 * posting -- exactly the shape issue #278's acceptance checks say can never earn a verified
 * application URL, and (just as importantly, to avoid an over-merge) can never anchor a
 * `canonical_url` identity match either: two different roles posted at the same employer very often
 * share one "apply here" landing page, so treating that shared URL as a merge key would silently
 * collapse two genuinely different vacancies into one (see `pipeline/global-remote.ts#uniqueDiscovery`
 * and acceptance check 2 on issue #278).
 */
export function isGenericListingUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  const hasSpecificQuery = [...url.searchParams.keys()].some((key) => SPECIFIC_QUERY_KEYS.test(key));
  if (hasSpecificQuery) return false;
  // Workable's board-root URL (`apply.workable.com/{company}`) is a listing page, not a posting --
  // only its `/j/{code}` job-detail shape counts as specific. Called out explicitly because this is
  // the one provider issue #278 names by name for preserved canonical-URL behavior.
  if (url.hostname.toLowerCase() === 'apply.workable.com' && !/^\/j\//u.test(url.pathname)) return true;
  const parts = pathSegments(url);
  const last = parts.at(-1)?.toLowerCase() ?? '';
  return parts.length === 0 || GENERIC_LISTING_LAST_SEGMENTS.has(last);
}

/**
 * Company-scoped, description-free semantic key -- issue #278's last-resort identity tier.
 * Deliberately not `vacancies/hash.ts#createVacancySemanticFingerprint`, which folds in the full
 * description text and omits company: a discovery row's description completeness varies hugely by
 * source (a full JD versus a one-line snippet), so requiring exact description equality would make
 * this tier fire almost never even for genuine duplicates -- while company is essential here
 * specifically because this tier has no ATS or URL evidence left to keep two different employers
 * apart. Two different requisitions that happen to share an identical title, location and generic
 * URL at the very same employer are the one case this tier cannot distinguish -- a narrow, documented
 * limitation in the same spirit as `reporting/cross-company-duplicates.ts`'s own residual gap (issue
 * #183), not a silent one. Real-world identity resolution should reach this tier rarely: it only
 * applies once neither a requisition ID nor a specific-looking URL could be found.
 */
export function semanticIdentityKey(company: string, title: string, location: string): string {
  return [normalizeVacancyText(company), normalizeVacancyText(title), normalizeVacancyText(location)].join(
    ' :: ',
  );
}

/**
 * Resolves one discovery row's canonical job identity (issue #278), trying each tier in order: a
 * direct ATS employer/tenant + requisition ID first, then a normalized canonical URL for a URL that
 * looks like a specific posting rather than a shared listing page, and finally a company-scoped
 * semantic fingerprint. Pure and URL/text-only -- no network call, matching every other
 * identity-adjacent helper in this package (`vacancies/hash.ts`, `reporting/cross-company-duplicates.ts`).
 */
export function vacancyIdentityFor(input: {
  url: string;
  company: string;
  title: string;
  location: string;
}): VacancyIdentity {
  const requisition = atsRequisitionFor(input.url);
  if (requisition !== null) {
    const employerKey = `${requisition.provider}:${requisition.tenant.toLowerCase()}`;
    return {
      kind: 'requisition',
      key: `${employerKey}:${requisition.requisitionId}`,
      employerKey,
      requisitionId: requisition.requisitionId,
    };
  }
  if (!isGenericListingUrl(input.url)) {
    try {
      return {
        kind: 'canonical_url',
        key: canonicalizeVacancyUrl(input.url),
        employerKey: null,
        requisitionId: null,
      };
    } catch {
      // Malformed URL: every discovery source already validates its own URL through `httpUrl`/
      // `stringValue` before this ever runs (`isGenericListingUrl` above already parsed it once
      // successfully too), so this only guards a future caller that skips that validation --
      // falling through to the semantic tier below rather than throwing out of a pure resolver.
    }
  }
  return {
    kind: 'semantic',
    key: semanticIdentityKey(input.company, input.title, input.location),
    employerKey: null,
    requisitionId: null,
  };
}

/**
 * Resolves whether a row's discovered URL is an actually-verified application target (issue #278).
 * Only a `requisition` identity -- direct evidence the URL resolves to one exact ATS posting --
 * ever earns `verified`. Everything else (a specific-looking but unrecognized direct URL, a generic
 * careers/listing/search page) stays `unresolved`: still stored, still shown, just not claimed as
 * confirmed. This function never drops or excludes a row for being unresolved -- see
 * `pipeline/global-remote.ts#uniqueDiscovery`'s own doc comment on why an unresolved apply URL must
 * never remove a vacancy from the report.
 */
export function resolveApplyUrl(identity: VacancyIdentity, url: string): ApplyUrlEvidence {
  if (identity.kind === 'requisition') {
    return {
      status: 'verified',
      url,
      reasons: [
        `Resolved to ${identity.employerKey ?? 'an ATS'} requisition ${identity.requisitionId ?? '(unknown)'}.`,
      ],
    };
  }
  if (identity.kind === 'canonical_url') {
    return {
      status: 'unresolved',
      url,
      reasons: [
        'No ATS requisition ID could be extracted from this URL; treated as an unresolved application target pending review.',
      ],
    };
  }
  return {
    status: 'unresolved',
    url,
    reasons: [
      'No requisition ID or specific-posting URL was found; this row is grouped by company, title and location similarity only, which does not verify an application target.',
    ],
  };
}
