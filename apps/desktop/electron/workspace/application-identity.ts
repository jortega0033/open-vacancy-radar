/**
 * Requisition identity for application attempts (#275).
 *
 * The concurrency guard #198 shipped dedups on `vacancyKey` (a discovery-report row key) with a
 * raw `canonicalUrl` fallback. Both are *source* identities: the same real requisition re-imported
 * from a second board, a spreadsheet, or the same board with different tracking parameters gets a
 * different `vacancyKey` and a different URL string, so neither can answer "have I already applied
 * to this job?". This module derives a *requisition* identity that survives those re-imports.
 *
 * Three derived values, all computed here and stored on the attempt row so a later lookup is a
 * plain indexed comparison rather than a re-parse:
 *
 *  - `employerKey` -- who the application goes to. For a recognised ATS apply URL this is
 *    `<provider>:<board>` taken from the URL itself, which is stable no matter how the company's
 *    name was spelled by whichever source supplied the row. Otherwise it falls back to a
 *    normalized company name.
 *  - `requisitionId` -- which opening at that employer, as the ATS itself identifies it. Null when
 *    nothing reliable can be derived, which is what makes the canonical-URL fallback necessary
 *    rather than optional.
 *  - `canonicalUrlKey` -- the apply URL reduced to the parts that identify the posting: no scheme,
 *    no `www.`, no fragment, no tracking parameters, remaining query sorted.
 *
 * Deliberately conservative in both directions. It never merges two openings at one company into a
 * single identity (#275 calls that out explicitly: `employerKey` is only ever used *together with*
 * a non-null `requisitionId`, never on its own), and it never invents a requisition id from a URL
 * shape it does not recognise -- a wrong match here suppresses a real application the user wanted
 * to send, which is a worse failure than the duplicate it would have prevented.
 *
 * Pure string work: no database, no Electron, no network, exhaustively unit-testable on its own.
 */

/** What `deriveApplicationIdentity` produces, and what the attempt row stores verbatim. */
export interface ApplicationIdentity {
  employerKey: string;
  requisitionId: string | null;
  canonicalUrlKey: string;
}

/** What a caller knows before an identity is derived. */
export interface ApplicationIdentityInput {
  company: string;
  canonicalUrl?: string;
  /**
   * An employer/ATS requisition id the caller already has from somewhere other than the URL (a
   * structured feed, a spreadsheet column). Used only when the URL itself yields nothing, and
   * scoped to the normalized company name rather than an ATS board, since a caller-supplied id is
   * only meaningful within whatever system the caller got it from.
   */
  requisitionId?: string | null;
}

/** Query parameters that describe how the user arrived, not which posting they arrived at. */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gh_src',
  'mc_cid',
  'mc_eid',
  'msclkid',
  'ref',
  'referrer',
  'source',
  'src',
  'trk',
  'trackingid',
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Lowercased host with a leading `www.` removed; the port is already dropped by `URL.hostname`. */
function hostKey(url: URL): string {
  const host = url.hostname.toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}

function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter((segment) => segment.length > 0);
}

/**
 * The apply URL reduced to what identifies the posting. Scheme is dropped (an `http` and an
 * `https` link to the same posting are the same posting), as is the fragment and every tracking
 * parameter; what survives is sorted so two orderings of the same query compare equal.
 *
 * A value that is not a parseable http(s) URL is lowercased and trimmed but otherwise returned
 * as-is: it is still a usable equality key, and silently rewriting something this function does
 * not understand would be worse than leaving it alone.
 */
export function normalizeCanonicalUrlKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const url = parseHttpUrl(trimmed);
  if (!url) return trimmed.toLowerCase();

  const path = pathSegments(url)
    .map((segment) => decodeSegment(segment))
    .join('/');
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !isTrackingParam(name))
    .map(([name, paramValue]) => [name.toLowerCase(), paramValue] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([name, paramValue]) => `${name}=${paramValue}`)
    .join('&');

  const base = path === '' ? hostKey(url) : `${hostKey(url)}/${path}`;
  return params === '' ? base : `${base}?${params}`;
}

/** Percent-decodes one path segment when that is lossless, and leaves it alone when it is not. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A company name reduced to an equality key: diacritics folded, punctuation and case dropped.
 *
 * Deliberately does NOT strip legal-form suffixes (`B.V.`, `GmbH`, `Inc`). Stripping them merges
 * genuinely distinct legal entities that share a trading name, and this key is never the whole
 * identity anyway -- it only ever narrows an already-specific requisition id.
 */
export function normalizeEmployerName(company: string): string {
  return company
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/** One recognised ATS apply URL, as the ATS itself identifies the employer and the opening. */
interface AtsRequisition {
  provider: string;
  board: string;
  requisitionId: string;
}

/** A board or requisition token worth trusting: short, and free of separators we use ourselves. */
function token(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = decodeSegment(value).trim();
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u.test(trimmed) ? trimmed : null;
}

function requisition(provider: string, board: string | null, requisitionId: string | null): AtsRequisition | null {
  return board === null || requisitionId === null ? null : { provider, board, requisitionId };
}

/** `<sub>.<suffix>` -> `<sub>`, for the ATS providers that put the board in the hostname. */
function subdomainBoard(host: string, suffix: string): string | null {
  return host.endsWith(suffix) ? token(host.slice(0, -suffix.length)) : null;
}

/**
 * Recognises the job-detail URL of the ATS providers this app already has discovery adapters for
 * (`packages/vacancy-engine/src/ats/`). Returns null for anything else -- including a careers page
 * on the employer's own domain, where no requisition id is inferable without guessing.
 */
function parseAtsRequisition(url: URL): AtsRequisition | null {
  const host = hostKey(url);
  const segments = pathSegments(url);
  const at = (index: number): string | null => token(segments[index]);
  const after = (marker: string): string | null => {
    const index = segments.indexOf(marker);
    return index < 0 ? null : token(segments[index + 1]);
  };

  // Greenhouse: boards[.eu].greenhouse.io/<board>/jobs/<id>, job-boards[.eu].greenhouse.io/... and
  // the embedded form, which carries both parts in the query string instead of the path.
  if (/(^|\.)greenhouse\.io$/u.test(host)) {
    const embedBoard = token(url.searchParams.get('for') ?? undefined);
    const embedJob = token(url.searchParams.get('token') ?? undefined);
    return requisition('greenhouse', at(0), after('jobs')) ?? requisition('greenhouse', embedBoard, embedJob);
  }
  // Lever: jobs[.eu].lever.co/<org>/<postingId>
  if (/(^|\.)lever\.co$/u.test(host)) {
    return requisition('lever', at(0), at(1));
  }
  // Ashby: jobs.ashbyhq.com/<org>/<uuid>
  if (/(^|\.)ashbyhq\.com$/u.test(host)) {
    return requisition('ashby', at(0), at(1));
  }
  // Rippling: ats.rippling.com/<org>/jobs/<uuid>
  if (/(^|\.)rippling\.com$/u.test(host)) {
    return requisition('rippling', at(0), after('jobs'));
  }
  // SmartRecruiters: jobs.smartrecruiters.com/<org>/<id>-<slug>, where the leading run of digits
  // is the requisition and the rest is a display slug that can change without the job changing.
  if (/(^|\.)smartrecruiters\.com$/u.test(host)) {
    const posting = at(1);
    const id = posting === null ? null : (/^(\d+)/u.exec(posting)?.[1] ?? posting);
    return requisition('smartrecruiters', at(0), id);
  }
  // Workable: apply.workable.com/<org>/j/<code>
  if (/(^|\.)workable\.com$/u.test(host)) {
    return requisition('workable', at(0), after('j') ?? after('jobs'));
  }
  // Recruitee: <org>.recruitee.com/o/<slug>
  if (/(^|\.)recruitee\.com$/u.test(host)) {
    return requisition('recruitee', subdomainBoard(host, '.recruitee.com'), after('o'));
  }
  // Personio: <org>.jobs.personio.<tld>/job/<id>
  if (/(^|\.)personio\.(?:com|de)$/u.test(host)) {
    const board = host.split('.')[0];
    return requisition('personio', token(board), after('job'));
  }
  // Teamtailor: <org>.teamtailor.com/jobs/<id>-<slug>
  if (/(^|\.)teamtailor\.com$/u.test(host)) {
    return requisition('teamtailor', subdomainBoard(host, '.teamtailor.com'), after('jobs'));
  }
  // Workday: <tenant>.wd<n>.myworkdayjobs.com/.../job/.../<slug>_<REQID>. The requisition id is
  // the underscore-suffixed tail the tenant assigns; the slug in front of it is display text.
  if (/^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/u.test(host)) {
    const tail = segments[segments.length - 1];
    const underscore = tail === undefined ? -1 : tail.lastIndexOf('_');
    const id = underscore < 0 ? null : token(tail?.slice(underscore + 1));
    return requisition('workday', token(host.split('.')[0]), id);
  }
  return null;
}

/**
 * Derives the identity a completed-application lookup compares on.
 *
 * A recognised ATS apply URL wins: it names the employer and the opening the way the receiving
 * system does, so it is the one form that survives the same posting arriving from two different
 * sources. Failing that, a caller-supplied requisition id scoped to the normalized company name is
 * used. Failing both, `requisitionId` stays null and the canonical-URL key is the only identity
 * available -- which is exactly why the lookup treats it as a fallback rather than an equal.
 */
export function deriveApplicationIdentity(input: ApplicationIdentityInput): ApplicationIdentity {
  const canonicalUrlKey = normalizeCanonicalUrlKey(input.canonicalUrl ?? '');
  const url = parseHttpUrl((input.canonicalUrl ?? '').trim());
  const ats = url ? parseAtsRequisition(url) : null;
  if (ats) {
    return {
      employerKey: `${ats.provider}:${ats.board.toLowerCase()}`,
      requisitionId: ats.requisitionId,
      canonicalUrlKey,
    };
  }

  const supplied = (input.requisitionId ?? '').trim();
  return {
    employerKey: normalizeEmployerName(input.company),
    requisitionId: supplied === '' ? null : supplied,
    canonicalUrlKey,
  };
}
