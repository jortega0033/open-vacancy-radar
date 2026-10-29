// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDockClient } from '@agent-dock/client';
import { CrawlerHttpError, type AtsHttpClient } from '@open-vacancy-radar/vacancy-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_FACT_TTL_MS,
  ROLE_FACT_TTL_MS,
  classifyFact,
  deriveCompanyIdentity,
  identityFromConfirmedDomain,
  selectProseEvidence,
  type CompanyEvidenceFactData,
  type CompanyEvidenceView,
} from '../electron/company-evidence.js';
import { createCompanyEvidenceHandlers } from '../electron/company-evidence-ipc.js';
import {
  buildCompanyResearchPrompt,
  parseCompanyResearchResponse,
  runCompanyResearchSession,
} from '../electron/company-evidence-research.js';
import {
  CompanyEvidenceRuns,
  addFact,
  confirmDomain,
  confirmFact,
  correctFact,
  decideLink,
  deleteRecordFor,
  getView,
  proseEvidence,
  refreshEvidence,
  researchCompany,
  resolveContradiction,
  withdrawFact,
  type CompanyEvidenceDeps,
  type EvidenceTarget,
} from '../electron/company-evidence-service.js';
import { ApplicationDataResetBusyError, ApplicationDataResetGate } from '../electron/application-data-reset-gate.js';
import {
  buildApplicationCoverLetterPrompt,
  generateApplicationCoverLetterWithEvidence,
} from '../electron/application-cover-letter.js';
import { buildApplicationTailoringPrompt } from '../electron/application-tailoring.js';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import * as store from '../electron/workspace/company-evidence-store.js';
import * as schema from '../electron/workspace/schema.js';
import type { CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import { buildInterviewPrepPrompt, type InterviewPrepContext } from '../src/components/applications/interview-prep-prompt.js';

/**
 * #689. Everything here runs the REAL store (migrated SQLite), service, IPC handlers, research
 * session driver, cover-letter path and interview prompt builder. Only the world is faked: public
 * web pages are an in-memory map behind the same `AtsHttpClient` seam the safe client implements,
 * and the daemon's web-only session is a scripted event stream. All employers, people and pages
 * are synthetic; no network, no provider, no real posting is touched.
 */

const T0 = new Date('2026-10-01T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const NORTHWIND = 'https://job-boards.greenhouse.io/northwind/jobs/1001';
const NORTHWIND_DATA = 'https://job-boards.greenhouse.io/northwind/jobs/1002';
const ABOUT = 'https://northwind.example/about';
const NEWS = 'https://news.example/northwind-size';
const PLATFORM_QUOTE = 'Northwind Freight operates 14 depots across the Netherlands and Belgium';
const DATA_QUOTE = 'The Data Engineer role works on the depot forecasting pipeline';
const VISA_QUOTE = 'Visa sponsorship is available for this role';

class FakeWeb {
  pages = new Map<string, { status: number; body: string } | Error>();
  calls: string[] = [];
  client: AtsHttpClient = {
    get: async (url, options) => {
      this.calls.push(url);
      if (options?.signal?.aborted) throw new Error('aborted');
      const page = this.pages.get(url);
      if (!page) {
        throw new CrawlerHttpError({ category: 'http_error', code: 'http_status', url, detail: 'not found', status: 404 });
      }
      if (page instanceof Error) throw page;
      return { status: page.status, finalUrl: url, headers: {}, body: page.body };
    },
    postJson: async () => {
      throw new Error('postJson is never used for evidence');
    },
  };
  page(url: string, text: string): void {
    this.pages.set(url, { status: 200, body: `<html><head><style>x{}</style></head><body><p>${text}.</p></body></html>` });
  }
}

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let clock: Date;
let web: FakeWeb;
let runs: CompanyEvidenceRuns;
let deps: CompanyEvidenceDeps;
let research: ReturnType<typeof vi.fn>;

function makeAttempt(company: string, role: string, url: string, extra: { applicationId?: string } = {}) {
  return workspace.createApplicationAttempt(db, {
    company,
    role,
    canonicalUrl: url,
    sourceCvContentHash: 'hash',
    jdSnapshot: 'Synthetic public job description.',
    jdSnapshotHash: 'jd-hash',
    force: true,
    ...extra,
  });
}

const target = (attemptId: string): EvidenceTarget => ({ attemptId });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-evidence-test-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  clock = new Date(T0);
  web = new FakeWeb();
  runs = new CompanyEvidenceRuns();
  research = vi.fn();
  deps = {
    db,
    now: () => new Date(clock),
    getHttp: async () => web.client,
    runResearch: research as unknown as CompanyEvidenceDeps['runResearch'],
  };
  web.page(ABOUT, `${PLATFORM_QUOTE}. It was founded in 2009`);
  web.page(NORTHWIND, `Platform Engineer. ${VISA_QUOTE}. Apply now`);
  web.page(NORTHWIND_DATA, `Data Engineer. ${DATA_QUOTE}`);
  web.page(NEWS, 'Northwind Freight employs about 450 people');
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function addSized(t: EvidenceTarget, claim: string, url: string, quote: string, extra: Record<string, unknown> = {}) {
  const result = await addFact(deps, t, { claim, sourceUrl: url, quote, scope: 'company', topic: 'general', ...extra });
  if (!result.ok) throw new Error(`addFact refused: ${result.code}`);
  return result;
}

function factIdOf(view: CompanyEvidenceView, claim: string): string {
  const fact = view.facts.find((row) => row.claim === claim);
  if (!fact) throw new Error(`no fact "${claim}" in view`);
  return fact.id;
}

/* ============================================================================ identity + policy ===== */

describe('verified identity (never a bare name)', () => {
  it('derives the ATS tenant from the apply URL, the employer host from its own posting, and nothing from a name or an aggregator', () => {
    expect(deriveCompanyIdentity({ company: 'Northwind Freight', canonicalUrl: NORTHWIND, employerKey: 'greenhouse:northwind' })).toMatchObject({
      verifiedKey: 'ats:greenhouse:northwind',
      keyKind: 'ats_tenant',
    });
    expect(
      deriveCompanyIdentity({
        company: 'Northwind Freight Group',
        canonicalUrl: 'https://careers.northwind-freight-group.example/jobs/9',
        employerKey: 'northwind-freight-group',
      }),
    ).toMatchObject({ verifiedKey: 'host:northwind-freight-group.example', keyKind: 'posting_host' });
    expect(
      deriveCompanyIdentity({ company: 'Harbor Systems', canonicalUrl: 'https://www.jobgether.com/offer/abc', employerKey: 'harbor-systems' }).verifiedKey,
    ).toBeNull();
    expect(deriveCompanyIdentity({ company: 'Harbor Systems', canonicalUrl: '', employerKey: 'harbor-systems' }).verifiedKey).toBeNull();
    // A host that merely resembles nothing about the named company is not its identity.
    expect(
      deriveCompanyIdentity({ company: 'Harbor Systems', canonicalUrl: 'https://acme-widgets.example/jobs/1', employerKey: 'harbor-systems' }).verifiedKey,
    ).toBeNull();
    expect(identityFromConfirmedDomain('Harbor Systems', 'jobgether.com')).toBeNull();
    expect(identityFromConfirmedDomain('Harbor Systems', 'harbor-systems.example')).toMatchObject({ verifiedKey: 'domain:harbor-systems.example' });
  });

  it('classifies a fact as supported only with every condition, and names the reason otherwise', () => {
    const identity = deriveCompanyIdentity({ company: 'Northwind Freight', canonicalUrl: NORTHWIND, employerKey: 'greenhouse:northwind' });
    const ctx = { roleKey: 'req:1001', identityVerified: true, identity, employerNames: ['Northwind Freight'] };
    const base: CompanyEvidenceFactData = {
      id: 'f1',
      recordId: 'r1',
      scope: 'company',
      roleKey: '',
      roleLabel: '',
      topic: 'general',
      claim: `${PLATFORM_QUOTE}.`,
      sourceUrl: ABOUT,
      sourceKind: 'public_web',
      quote: PLATFORM_QUOTE,
      retrievedAt: T0.toISOString(),
      observedAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + COMPANY_FACT_TTL_MS).toISOString(),
      verification: 'source_confirmed',
      origin: 'user',
      status: 'active',
      lastRefreshAt: null,
      lastRefreshOutcome: null,
      lastRefreshReason: null,
      correction: null,
      contradictedBy: [],
      viaLink: null,
    };
    const now = new Date(T0.getTime() + DAY);
    expect(classifyFact(base, ctx, now)).toMatchObject({ support: 'supported', reasons: [] });
    expect(classifyFact({ ...base, verification: 'unverified' }, ctx, now).reasons).toEqual(['unverified']);
    expect(classifyFact(base, ctx, new Date(T0.getTime() + COMPANY_FACT_TTL_MS + 1)).reasons).toEqual(['expired']);
    expect(classifyFact({ ...base, contradictedBy: ['f2'] }, ctx, now).reasons).toEqual(['contradicted']);
    expect(classifyFact({ ...base, scope: 'role', roleKey: 'req:1002' }, ctx, now).reasons).toEqual(['other_role']);
    expect(classifyFact({ ...base, scope: 'role', roleKey: 'req:1001' }, ctx, now).support).toBe('supported');
    expect(classifyFact({ ...base, sourceUrl: 'http://northwind.example/about' }, ctx, now).reasons).toContain('source_not_https');
    expect(classifyFact({ ...base, sourceKind: 'ind_register' }, ctx, now).reasons).toEqual(['ind_name_match_only']);
    expect(classifyFact(base, { ...ctx, identityVerified: false }, now).reasons).toEqual(['identity_not_verified']);
    // Sponsorship: never a company-wide claim, never from a third party, never from a register.
    expect(classifyFact({ ...base, topic: 'sponsorship' }, ctx, now).reasons).toContain('sponsorship_needs_role_source');
    const sponsorship = { ...base, topic: 'sponsorship' as const, scope: 'role' as const, roleKey: 'req:1001', sourceUrl: NORTHWIND, sourceKind: 'ats_posting' as const };
    expect(classifyFact(sponsorship, ctx, now).support).toBe('supported');
    expect(classifyFact({ ...sponsorship, sourceUrl: NEWS, sourceKind: 'public_web' }, ctx, now).reasons).toContain('sponsorship_needs_role_source');
    expect(ROLE_FACT_TTL_MS).toBeLessThan(COMPANY_FACT_TTL_MS);
  });

  it('re-checks expiry when selecting prose evidence, so a held list cannot outlive its facts', () => {
    const identity = deriveCompanyIdentity({ company: 'Northwind Freight', canonicalUrl: NORTHWIND, employerKey: 'greenhouse:northwind' });
    const fact = {
      id: 'f1',
      recordId: 'r1',
      scope: 'company' as const,
      roleKey: '',
      roleLabel: '',
      topic: 'general' as const,
      claim: `${PLATFORM_QUOTE}.`,
      sourceUrl: ABOUT,
      sourceKind: 'public_web' as const,
      quote: PLATFORM_QUOTE,
      retrievedAt: T0.toISOString(),
      observedAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + DAY).toISOString(),
      verification: 'source_confirmed' as const,
      origin: 'user' as const,
      status: 'active' as const,
      lastRefreshAt: null,
      lastRefreshOutcome: null,
      lastRefreshReason: null,
      correction: null,
      contradictedBy: [],
      viaLink: null,
    };
    const ctx = { roleKey: null, identityVerified: true, identity, employerNames: ['Northwind Freight'] };
    expect(selectProseEvidence([fact], ctx, T0, 5)).toHaveLength(1);
    expect(selectProseEvidence([fact], ctx, new Date(T0.getTime() + 2 * DAY), 5)).toHaveLength(0);
  });
});

/* ============================================================== employer across two roles ========= */

describe('one verified employer across two roles', () => {
  it('shares company facts between roles while a role-only fact stays with its own role', async () => {
    const platform = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const data = makeAttempt('Northwind Freight', 'Data Engineer', NORTHWIND_DATA);
    expect(platform.employerKey).toBe('greenhouse:northwind');

    await addSized(target(platform.id), 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', ABOUT, PLATFORM_QUOTE);
    await addSized(target(platform.id), 'Visa sponsorship is available for this role.', NORTHWIND, VISA_QUOTE, { scope: 'role', topic: 'sponsorship' });
    await addSized(target(data.id), 'The Data Engineer role works on the depot forecasting pipeline.', NORTHWIND_DATA, DATA_QUOTE, { scope: 'role' });

    const platformView = getView(deps, target(platform.id));
    const dataView = getView(deps, target(data.id));
    expect(platformView.recordId).toBe(dataView.recordId);
    expect(platformView.identity.verifiedKey).toBe('ats:greenhouse:northwind');

    const used = (view: CompanyEvidenceView) => view.facts.filter((fact) => fact.support === 'supported').map((fact) => fact.claim);
    expect(used(platformView)).toEqual(
      expect.arrayContaining(['Northwind Freight operates 14 depots across the Netherlands and Belgium.', 'Visa sponsorship is available for this role.']),
    );
    expect(used(platformView)).not.toContain('The Data Engineer role works on the depot forecasting pipeline.');
    expect(used(dataView)).toEqual(
      expect.arrayContaining(['Northwind Freight operates 14 depots across the Netherlands and Belgium.', 'The Data Engineer role works on the depot forecasting pipeline.']),
    );
    expect(used(dataView)).not.toContain('Visa sponsorship is available for this role.');
    const leaked = dataView.facts.find((fact) => fact.claim === 'Visa sponsorship is available for this role.');
    expect(leaked).toMatchObject({ support: 'lead', reasons: expect.arrayContaining(['other_role']) });
    // The role-only claim is not a lead the second role must worry about either.
    expect(dataView.leadCount).toBe(0);

    // What a letter or interview may carry is exactly the supported, role-matching set.
    const letterClaims = (id: string) => proseEvidence(deps, target(id), 'letter').map((fact) => fact.claim);
    expect(letterClaims(data.id)).not.toContain('Visa sponsorship is available for this role.');
    expect(letterClaims(platform.id)).toContain('Visa sponsorship is available for this role.');
  });

  it('resolves the same record from an application through its latest attempt', async () => {
    const application = workspace.createApplication(db, {
      role: 'Platform Engineer',
      company: 'Northwind Freight',
      location: 'Utrecht',
      status: 'recruiter_screen',
      notes: 'PRIVATE-NOTE-SENTINEL call with Dana about salary',
    });
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND, { applicationId: application.id });
    await addSized(target(attempt.id), 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', ABOUT, PLATFORM_QUOTE);
    const viaApplication = getView(deps, { applicationId: application.id });
    expect(viaApplication.recordId).toBe(getView(deps, target(attempt.id)).recordId);
    expect(viaApplication.supportedCount).toBe(1);
    expect(proseEvidence(deps, { applicationId: application.id }, 'interview')).toHaveLength(1);
    expect(JSON.stringify(viaApplication)).not.toContain('PRIVATE-NOTE-SENTINEL');
  });
});

/* ============================================================= near names, reviewable link ========= */

describe('similar names and different domains', () => {
  it('keeps look-alike employers apart until the person reviews and confirms a link', async () => {
    const northwind = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const group = makeAttempt('Northwind Freight Group', 'Dispatcher', 'https://careers.northwind-freight-group.example/jobs/9');
    await addSized(target(northwind.id), 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', ABOUT, PLATFORM_QUOTE);
    await addSized(target(northwind.id), 'Visa sponsorship is available for this role.', NORTHWIND, VISA_QUOTE, { scope: 'role', topic: 'sponsorship' });

    // The other employer has a different verified key and starts with nothing.
    const before = getView(deps, target(group.id));
    expect(before.identity.verifiedKey).toBe('host:northwind-freight-group.example');
    expect(before.facts).toEqual([]);
    expect(proseEvidence(deps, target(group.id), 'letter')).toEqual([]);

    // Creating its record proposes (never confirms) a link, visible from both sides.
    web.page('https://northwind-freight-group.example/about', 'Northwind Freight Group runs a dispatch centre in Rotterdam for its own fleet');
    await addSized(target(group.id), 'Northwind Freight Group runs a dispatch centre in Rotterdam.', 'https://northwind-freight-group.example/about', 'Northwind Freight Group runs a dispatch centre in Rotterdam for its own fleet');
    const proposed = getView(deps, target(group.id));
    expect(proposed.links).toMatchObject([{ status: 'proposed', otherName: 'Northwind Freight' }]);
    expect(getView(deps, target(northwind.id)).links).toMatchObject([{ status: 'proposed', otherName: 'Northwind Freight Group' }]);
    expect(proposed.facts.map((fact) => fact.claim)).toEqual(['Northwind Freight Group runs a dispatch centre in Rotterdam.']);

    // Confirming shares COMPANY facts only, labelled with where they came from.
    const link = proposed.links[0]!;
    expect(decideLink(deps, target(group.id), link.id, 'confirmed').ok).toBe(true);
    const shared = getView(deps, target(group.id));
    const viaLink = shared.facts.filter((fact) => fact.viaLink === 'Northwind Freight');
    expect(viaLink.map((fact) => fact.claim)).toEqual(['Northwind Freight operates 14 depots across the Netherlands and Belgium.']);
    expect(shared.facts.some((fact) => fact.claim === 'Visa sponsorship is available for this role.')).toBe(false);
    // A linked fact may be read but not edited from the other company's screen.
    const linkedId = viaLink[0]!.id;
    expect(withdrawFact(deps, target(group.id), linkedId)).toMatchObject({ ok: false, code: 'fact_not_found' });

    // Un-sharing takes it away again.
    expect(decideLink(deps, target(group.id), link.id, 'rejected').ok).toBe(true);
    expect(getView(deps, target(group.id)).facts.some((fact) => fact.viaLink !== null)).toBe(false);
  });

  it('never treats a bare name, an aggregator or a register name match as an identity', async () => {
    const harbor = makeAttempt('Harbor Systems', 'Support Engineer', 'https://www.jobgether.com/offer/abc123');
    const view = getView(deps, target(harbor.id));
    expect(view.state).toBe('no_identity');
    expect(await addFact(deps, target(harbor.id), { claim: 'Harbor Systems has 80 staff.', sourceUrl: ABOUT, quote: '', scope: 'company', topic: 'size' })).toMatchObject({
      ok: false,
      code: 'identity_not_verified',
    });
    expect(confirmDomain(deps, target(harbor.id), { domain: 'jobgether.com' })).toMatchObject({ ok: false, code: 'job_board_domain' });
    expect(store.findRecord(db, 'domain:jobgether.com')).toBeNull();

    // The person names the employer's own site: that, and only that, makes a record.
    const confirmed = confirmDomain(deps, target(harbor.id), { domain: 'https://harbor-systems.example' });
    expect(confirmed.ok).toBe(true);
    expect(getView(deps, target(harbor.id)).identity).toMatchObject({ verifiedKey: 'domain:harbor-systems.example', keyKind: 'user_domain' });

    // An IND-register style source can be recorded but is never support, however it is confirmed.
    web.page('https://ind.nl/en/recognised-sponsors', 'Harbor Systems appears in the list of recognised sponsors');
    await addSized(target(harbor.id), 'Harbor Systems is a recognised sponsor.', 'https://ind.nl/en/recognised-sponsors', 'Harbor Systems appears in the list of recognised sponsors', { topic: 'sponsorship' });
    const ind = getView(deps, target(harbor.id)).facts[0]!;
    expect(ind).toMatchObject({ sourceKind: 'ind_register', support: 'lead' });
    expect(ind.reasons).toEqual(expect.arrayContaining(['ind_name_match_only']));
    expect(confirmFact(deps, target(harbor.id), ind.id)).toMatchObject({ ok: false, code: 'ind_name_match_only' });
    expect(proseEvidence(deps, target(harbor.id), 'interview')).toEqual([]);
  });

  it('treats a vacancy bound to two different domains as ambiguous instead of picking one', () => {
    const one = makeAttempt('Harbor Systems', 'Support Engineer', 'https://www.jobgether.com/offer/1');
    expect(confirmDomain(deps, target(one.id), { domain: 'harbor-systems.example' }).ok).toBe(true);
    expect(getView(deps, target(one.id)).state).toBe('ready');
    const second = store.ensureRecord(db, identityFromConfirmedDomain('Harbor Systems', 'harbor-systems.io')!, T0);
    store.addConfirmedTargets(db, second.record.id, [`posting:${one.canonicalUrlKey}`], T0);
    expect(getView(deps, target(one.id)).state).toBe('no_identity');
  });
});

/* ============================================================ cache, expiry, failed refresh ======== */

describe('retrieval time, expiry and refresh', () => {
  async function seedPlatform() {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const added = await addSized(target(attempt.id), 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', ABOUT, PLATFORM_QUOTE, { topic: 'general' });
    expect(added.stats?.requests).toBe(1);
    return attempt;
  }

  it('records the real fetch time and an expiry at write time', async () => {
    const attempt = await seedPlatform();
    const fact = getView(deps, target(attempt.id)).facts[0]!;
    expect(fact).toMatchObject({ verification: 'source_confirmed', retrievedAt: T0.toISOString(), support: 'supported' });
    expect(Date.parse(fact.expiresAt)).toBe(T0.getTime() + COMPANY_FACT_TTL_MS);
  });

  it('serves a current fact from the record: no session, no request, original retrieval time kept', async () => {
    const attempt = await seedPlatform();
    web.calls.length = 0;
    clock = new Date(T0.getTime() + 10 * DAY);

    const researched = await researchCompany(deps, target(attempt.id), { topics: ['general'] }, runs);
    expect(researched).toMatchObject({ ok: true, stats: { cacheHit: true, avoidedSessions: 1, sessions: 0, requests: 0 } });
    expect(research).not.toHaveBeenCalled();

    const refreshed = await refreshEvidence(deps, target(attempt.id), runs);
    expect(refreshed).toMatchObject({ ok: true, stats: { cacheHit: true, requests: 0, avoidedFetches: 1 } });
    expect(web.calls).toEqual([]);
    expect(getView(deps, target(attempt.id)).facts[0]!.retrievedAt).toBe(T0.toISOString());
  });

  it('turns a fact into a lead at expiry and never renews it on a failed, blocked or timed-out refresh', async () => {
    const attempt = await seedPlatform();
    const before = getView(deps, target(attempt.id)).facts[0]!;
    clock = new Date(T0.getTime() + COMPANY_FACT_TTL_MS + DAY);
    expect(getView(deps, target(attempt.id)).facts[0]).toMatchObject({ support: 'lead', reasons: ['expired'] });
    expect(proseEvidence(deps, target(attempt.id), 'letter')).toEqual([]);

    const failures: [string, Error | { status: number; body: string }][] = [
      ['timeout', new CrawlerHttpError({ category: 'timeout', code: 'request_timeout', url: ABOUT, detail: 'slow' })],
      ['blocked', new CrawlerHttpError({ category: 'blocked', code: 'blocked_status', url: ABOUT, detail: 'no', status: 403 })],
      ['fetch_failed', { status: 503, body: 'down' }],
      ['not_found', { status: 404, body: '' }],
    ];
    for (const [reason, page] of failures) {
      web.pages.set(ABOUT, page instanceof Error ? page : page);
      const result = await refreshEvidence(deps, target(attempt.id), runs);
      expect(result).toMatchObject({ ok: true, stats: { requests: 1, failed: 1, renewed: 0 } });
      const after = getView(deps, target(attempt.id)).facts[0]!;
      expect(after).toMatchObject({ support: 'lead', lastRefreshOutcome: 'failed', lastRefreshReason: reason });
      expect(after.retrievedAt).toBe(before.retrievedAt);
      expect(after.expiresAt).toBe(before.expiresAt);
      expect(after.observedAt).toBe(before.observedAt);
      expect(proseEvidence(deps, target(attempt.id), 'letter')).toEqual([]);
    }
  });

  it('demotes a fact whose source no longer says it, and renews only when the quote is found again', async () => {
    const attempt = await seedPlatform();
    clock = new Date(T0.getTime() + COMPANY_FACT_TTL_MS + DAY);
    web.page(ABOUT, 'Northwind Freight now operates 9 depots');
    const changed = await refreshEvidence(deps, target(attempt.id), runs);
    expect(changed).toMatchObject({ ok: true, stats: { demoted: 1, renewed: 0 } });
    expect(getView(deps, target(attempt.id)).facts[0]).toMatchObject({ verification: 'unverified', lastRefreshOutcome: 'source_changed', retrievedAt: T0.toISOString() });

    web.page(ABOUT, `${PLATFORM_QUOTE}. Updated this month`);
    const renewed = await refreshEvidence(deps, target(attempt.id), runs);
    expect(renewed).toMatchObject({ ok: true, stats: { renewed: 1 } });
    const fact = getView(deps, target(attempt.id)).facts[0]!;
    expect(fact).toMatchObject({ support: 'supported', retrievedAt: clock.toISOString() });
    expect(Date.parse(fact.expiresAt)).toBe(clock.getTime() + COMPANY_FACT_TTL_MS);
  });

  it('does not duplicate a claim when the same company is researched again from another role', async () => {
    const platform = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const data = makeAttempt('Northwind Freight', 'Data Engineer', NORTHWIND_DATA);
    research.mockResolvedValue({
      status: 'completed',
      reason: 'completed',
      queries: ['q'],
      searches: 1,
      fetches: 1,
      candidates: [
        { claim: 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', topic: 'general', scope: 'company', sourceUrl: ABOUT, quote: PLATFORM_QUOTE },
        { claim: 'Northwind Freight has a rail division in Antwerp.', topic: 'products', scope: 'company', sourceUrl: ABOUT, quote: 'Northwind Freight has a rail division in Antwerp' },
      ],
    });
    // The second topic never verifies, so the second role cannot be a cache hit and researches again.
    await researchCompany(deps, target(platform.id), { topics: ['general', 'products'] }, runs);
    await researchCompany(deps, target(data.id), { topics: ['general', 'products'] }, runs);
    expect(research).toHaveBeenCalledTimes(2);
    expect(db.select().from(schema.companyEvidenceFacts).all()).toHaveLength(2);
    expect(db.select().from(schema.companyEvidenceRecords).all()).toHaveLength(1);
  });

  it('keeps a user-supplied claim a lead when the page cannot be fetched or does not contain the quote', async () => {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const noQuote = await addFact(deps, target(attempt.id), { claim: 'Northwind Freight is growing fast.', sourceUrl: ABOUT, quote: '', scope: 'company', topic: 'general' });
    expect(noQuote).toMatchObject({ ok: true, stats: { requests: 0 } });
    const wrongQuote = await addFact(deps, target(attempt.id), { claim: 'Northwind Freight has a rail division in Antwerp.', sourceUrl: ABOUT, quote: 'Northwind Freight has a rail division in Antwerp', scope: 'company', topic: 'general' });
    expect(wrongQuote.ok && wrongQuote.notice).toContain('not on the source page');
    const view = getView(deps, target(attempt.id));
    expect(view.facts.every((fact) => fact.support === 'lead' && fact.retrievedAt === null)).toBe(true);
    expect(proseEvidence(deps, target(attempt.id), 'letter')).toEqual([]);
    expect(await addFact(deps, target(attempt.id), { claim: 'Northwind Freight is open.', sourceUrl: 'http://insecure.example/x', quote: '', scope: 'company', topic: 'general' })).toMatchObject({ ok: false, code: 'source_not_https' });
  });
});

/* ================================================== contradictions, corrections, unsupported claims == */

describe('contradictions and user corrections', () => {
  it('keeps both disagreeing sources as leads until the person chooses, and keeps the loser as provenance', async () => {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    web.page(ABOUT, 'Northwind Freight has 200 employees');
    await addSized(target(attempt.id), 'Northwind Freight has 200 employees.', ABOUT, 'Northwind Freight has 200 employees', { topic: 'size' });
    expect(proseEvidence(deps, target(attempt.id), 'letter')).toHaveLength(1);
    await addSized(target(attempt.id), 'Northwind Freight employs about 450 people.', NEWS, 'Northwind Freight employs about 450 people', { topic: 'size' });

    const disputed = getView(deps, target(attempt.id));
    expect(disputed.contradictions).toHaveLength(1);
    expect(disputed.facts.map((fact) => [fact.support, fact.reasons])).toEqual([
      ['lead', ['contradicted']],
      ['lead', ['contradicted']],
    ]);
    expect(proseEvidence(deps, target(attempt.id), 'letter')).toEqual([]);
    expect(proseEvidence(deps, target(attempt.id), 'interview')).toEqual([]);

    const keep = factIdOf(disputed, 'Northwind Freight has 200 employees.');
    const resolved = resolveContradiction(deps, target(attempt.id), disputed.contradictions[0]!.id, keep);
    expect(resolved.ok).toBe(true);
    const after = getView(deps, target(attempt.id));
    expect(after.contradictions).toEqual([]);
    expect(after.facts.find((fact) => fact.id === keep)).toMatchObject({ support: 'supported' });
    expect(after.facts.find((fact) => fact.claim === 'Northwind Freight employs about 450 people.')).toMatchObject({ status: 'superseded', support: 'lead' });
    expect(proseEvidence(deps, target(attempt.id), 'letter').map((fact) => fact.claim)).toEqual(['Northwind Freight has 200 employees.']);
  });

  it('keeps the original wording when a person corrects a claim and withdraws support until it is confirmed again', async () => {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    await addSized(target(attempt.id), 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', ABOUT, PLATFORM_QUOTE);
    const original = getView(deps, target(attempt.id)).facts[0]!;

    clock = new Date(T0.getTime() + 3 * DAY);
    expect((await correctFact(deps, target(attempt.id), original.id, 'Northwind Freight operates 15 depots.')).ok).toBe(true);
    const corrected = getView(deps, target(attempt.id)).facts[0]!;
    expect(corrected).toMatchObject({
      claim: 'Northwind Freight operates 15 depots.',
      verification: 'unverified',
      support: 'lead',
      // The passage the first wording rested on is provenance now, not support.
      quote: '',
      correction: {
        originalClaim: 'Northwind Freight operates 14 depots across the Netherlands and Belgium.',
        correctedAt: clock.toISOString(),
        originalQuote: PLATFORM_QUOTE,
      },
    });
    expect(corrected.reasons).toEqual(expect.arrayContaining(['unverified', 'quote_missing']));
    // Correcting did not move the source's expiry or retrieval time.
    expect(corrected.expiresAt).toBe(original.expiresAt);
    expect(corrected.retrievedAt).toBe(original.retrievedAt);
    expect(proseEvidence(deps, target(attempt.id), 'letter')).toEqual([]);

    // A second correction keeps the FIRST wording as provenance.
    await correctFact(deps, target(attempt.id), original.id, 'Northwind Freight operates 16 depots.');
    expect(getView(deps, target(attempt.id)).facts[0]!.correction?.originalClaim).toBe('Northwind Freight operates 14 depots across the Netherlands and Belgium.');

    expect(confirmFact(deps, target(attempt.id), original.id).ok).toBe(true);
    const confirmed = getView(deps, target(attempt.id)).facts[0]!;
    expect(confirmed).toMatchObject({ verification: 'user_confirmed', support: 'supported', claim: 'Northwind Freight operates 16 depots.' });
    expect(confirmed.correction).not.toBeNull();
  });
});

describe('unsupported claims never reach a letter or interview prep', () => {
  async function seedMixed() {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const t = target(attempt.id);
    await addSized(t, 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', ABOUT, PLATFORM_QUOTE);
    // Leads of every kind.
    await addFact(deps, t, { claim: 'LEAD-UNVERIFIED Northwind is acquiring Rival Logistics.', sourceUrl: 'https://rumours.example/x', quote: '', scope: 'company', topic: 'other' });
    await addFact(deps, t, { claim: 'LEAD-COMPANYWIDE-SPONSORSHIP Northwind sponsors every visa.', sourceUrl: ABOUT, quote: PLATFORM_QUOTE, scope: 'company', topic: 'sponsorship' });
    web.page('https://ind.nl/en/recognised-sponsors', 'Northwind Freight appears in the list of recognised sponsors');
    await addFact(deps, t, { claim: 'LEAD-IND Northwind is a recognised sponsor.', sourceUrl: 'https://ind.nl/en/recognised-sponsors', quote: 'Northwind Freight appears in the list of recognised sponsors', scope: 'company', topic: 'general' });
    const attemptData = makeAttempt('Northwind Freight', 'Data Engineer', NORTHWIND_DATA);
    await addFact(deps, target(attemptData.id), { claim: 'LEAD-OTHER-ROLE-2 The Data Engineer owns forecasting.', sourceUrl: NORTHWIND_DATA, quote: DATA_QUOTE, scope: 'role', topic: 'general' });
    return attempt;
  }

  const cv = (source: CvSourceDocument | null) =>
    ({
      id: 'cv1',
      name: 'Main CV',
      kind: 'manual',
      text: 'CV-SENTINEL Jamie Rivera, Senior Engineer at Redwood Software.',
      profile: { title: 'Senior Engineer', location: 'Amsterdam', skills: ['TypeScript'], summary: 'Synthetic.' },
      source,
      isDefault: true,
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
    }) as unknown as Parameters<typeof buildApplicationCoverLetterPrompt>[1];

  const SOURCE: CvSourceDocument = {
    contact: { name: 'Jamie Rivera', title: 'Senior Engineer', location: 'Amsterdam', email: 'jamie@example.invalid', phone: '+31 6 1234 5678', links: [] },
    summary: 'Synthetic summary for a synthetic candidate.',
    experience: [
      { id: 'experience-1', company: 'Redwood Software', title: 'Senior Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: ['Built things.'] },
    ],
    education: [],
    projects: [],
    maxProjects: 0,
    complete: true,
    incompleteReason: '',
    coveredChars: 100,
    sourceChars: 100,
    reviewedAt: '2026-01-01T00:00:00.000Z',
  };

  it('puts only supported, role-matching facts into the cover letter prompt and the finished letter', async () => {
    const attempt = await seedMixed();
    const record = workspace.getApplicationAttempt(db, attempt.id);
    const evidence = proseEvidence(deps, target(attempt.id), 'letter');
    expect(evidence.map((fact) => fact.claim)).toEqual(['Northwind Freight operates 14 depots across the Netherlands and Belgium.']);

    const prompt = buildApplicationCoverLetterPrompt(record, cv(SOURCE), evidence);
    expect(prompt).toContain('company-1');
    expect(prompt).toContain('Northwind Freight operates 14 depots');
    expect(prompt).not.toContain('LEAD-');

    const generate = vi.fn(async () => ({ ok: true, text: '{"factIds":["summary","company-1"]}' }));
    const revalidate = () => proseEvidence(deps, target(attempt.id), 'letter');
    const letter = await generateApplicationCoverLetterWithEvidence(record, cv(SOURCE), generate, evidence, { revalidate, now: () => clock });
    expect(letter.body).toContain('Something I noted about Northwind Freight from public sources: Northwind Freight operates 14 depots across the Netherlands and Belgium.');
    expect(letter.usedCompanyEvidence.map((fact) => fact.claim)).toEqual(['Northwind Freight operates 14 depots across the Netherlands and Belgium.']);
    expect(letter.body).not.toContain('LEAD-');

    // A model that names a lead (or any id outside the offered list) fails the letter instead of using it.
    for (const text of ['{"factIds":["summary","company-2"]}', '{"factIds":["summary","LEAD-UNVERIFIED"]}']) {
      await expect(generateApplicationCoverLetterWithEvidence(record, cv(SOURCE), async () => ({ ok: true, text }), evidence)).rejects.toThrow(
        /unsupported source facts/,
      );
    }
    // A letter made only of company facts, with none of the candidate's reviewed facts, is refused.
    await expect(
      generateApplicationCoverLetterWithEvidence(record, cv(SOURCE), async () => ({ ok: true, text: '{"factIds":["company-1"]}' }), evidence),
    ).rejects.toThrow(/only company facts/);
  });

  it('fix 2: a borrowed-figure claim and a cut-off role-sponsorship claim reach neither the letter nor the interview prompt', async () => {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const t = target(attempt.id);
    const competitor = 'Northwind Freight is a logistics firm. Our competitor Acme Haulage employs 12,000 people worldwide.';
    web.page(NEWS, competitor);
    web.pages.set(NORTHWIND, { status: 200, body: '<html><body><h1>Platform Engineer</h1><p>Northwind Freight offers visa sponsorship for some roles, but not for this one.</p></body></html>' });
    const borrowed = await addFact(deps, t, { claim: 'Northwind Freight employs 12,000 people.', sourceUrl: NEWS, quote: competitor, scope: 'company', topic: 'size' });
    const cut = await addFact(deps, t, { claim: 'Northwind Freight offers visa sponsorship.', sourceUrl: NORTHWIND, quote: 'Northwind Freight offers visa sponsorship', scope: 'role', topic: 'general' });
    await addSized(t, 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', ABOUT, PLATFORM_QUOTE);
    // The floor failure cost no request; the cut quote cost the one request that showed its page sentence.
    expect(borrowed).toMatchObject({ ok: true, stats: { requests: 0 } });
    expect(cut).toMatchObject({ ok: true, stats: { requests: 1 } });
    expect(web.calls).toEqual([NORTHWIND, ABOUT]);

    const record = workspace.getApplicationAttempt(db, attempt.id);
    const letterEvidence = proseEvidence(deps, t, 'letter');
    expect(letterEvidence.map((fact) => fact.claim)).toEqual(['Northwind Freight operates 14 depots across the Netherlands and Belgium.']);
    const letter = await generateApplicationCoverLetterWithEvidence(
      record,
      cv(SOURCE),
      async () => ({ ok: true, text: '{"factIds":["summary","company-1"]}' }),
      letterEvidence,
      { revalidate: () => proseEvidence(deps, t, 'letter'), now: () => clock },
    );
    expect(letter.body).not.toContain('12,000');
    expect(letter.body).not.toContain('visa sponsorship');
    expect(letter.usedCompanyEvidence.map((fact) => fact.claim)).toEqual(['Northwind Freight operates 14 depots across the Netherlands and Belgium.']);

    const prompt = buildInterviewPrepPrompt(
      {
        role: 'Platform Engineer',
        company: 'Northwind Freight',
        location: '',
        status: 'interview',
        nextStep: '',
        contact: '',
        notes: '',
        savedJob: null,
        jdSnapshot: null,
        cv: { name: 'Main CV', text: 'CV-SENTINEL' },
        letter: null,
        companyEvidence: proseEvidence(deps, t, 'interview'),
      },
      new Date(T0.getTime() + DAY),
    );
    const block = prompt.slice(prompt.indexOf('=== SOURCED COMPANY EVIDENCE'), prompt.indexOf('=== YOUR CURRENT LINKED CV'));
    expect(block).toContain('Northwind Freight operates 14 depots across the Netherlands and Belgium.');
    expect(block).not.toContain('12,000');
    expect(block).not.toContain('visa sponsorship');
  });

  it('builds the identical prompt and letter when there is no evidence (no behaviour change)', async () => {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const record = workspace.getApplicationAttempt(db, attempt.id);
    expect(buildApplicationCoverLetterPrompt(record, cv(SOURCE), [])).toBe(buildApplicationCoverLetterPrompt(record, cv(SOURCE)));
    expect(buildApplicationCoverLetterPrompt(record, cv(SOURCE))).not.toContain('company-');
    const none = await generateApplicationCoverLetterWithEvidence(record, cv(SOURCE), async () => ({ ok: true, text: '{"factIds":["summary"]}' }), []);
    expect(none.usedCompanyEvidence).toEqual([]);
    expect(none.body).not.toContain('public sources');
  });

  it('never lets company evidence into the CV tailoring prompt (separate from candidate facts)', async () => {
    const attempt = await seedMixed();
    const record = workspace.getApplicationAttempt(db, attempt.id);
    const tailoring = buildApplicationTailoringPrompt(record, cv(SOURCE));
    expect(tailoring).not.toContain('Northwind Freight operates 14 depots');
    expect(tailoring).not.toContain('LEAD-');
    expect(tailoring).not.toContain('company-1');
  });

  it('puts only current supported facts, with source and scope, into the interview prompt, apart from the CV', async () => {
    const attempt = await seedMixed();
    const facts = proseEvidence(deps, target(attempt.id), 'interview');
    const context: InterviewPrepContext = {
      role: 'Platform Engineer',
      company: 'Northwind Freight',
      location: '',
      status: 'interview',
      nextStep: '',
      contact: '',
      notes: '',
      savedJob: null,
      jdSnapshot: null,
      cv: { name: 'Main CV', text: 'CV-SENTINEL Jamie Rivera built a routing service.' },
      letter: null,
      companyEvidence: facts,
    };
    const prompt = buildInterviewPrepPrompt(context, new Date(T0.getTime() + DAY));
    expect(prompt).toContain('=== SOURCED COMPANY EVIDENCE');
    expect(prompt).toContain('[E1] (the company) Northwind Freight operates 14 depots across the Netherlands and Belgium.');
    expect(prompt).toContain(`source: ${ABOUT}`);
    expect(prompt).toContain('observed 2026-10-01');
    expect(prompt).not.toContain('LEAD-');
    const block = prompt.slice(prompt.indexOf('=== SOURCED COMPANY EVIDENCE'), prompt.indexOf('=== YOUR CURRENT LINKED CV'));
    expect(block).not.toContain('CV-SENTINEL');

    // Held past its expiry, the same list contributes nothing and the prompt says so.
    const stale = buildInterviewPrepPrompt(context, new Date(T0.getTime() + COMPANY_FACT_TTL_MS + DAY));
    expect(stale).not.toContain('Northwind Freight operates 14 depots');
    expect(stale).toContain('No sourced company evidence is on file for this employer');

    // Not asking for evidence leaves the prompt exactly as it was before this feature.
    const { companyEvidence: _omitted, ...withoutEvidence } = context;
    void _omitted;
    expect(buildInterviewPrepPrompt(withoutEvidence)).not.toMatch(/company evidence/i);
    expect(buildInterviewPrepPrompt({ ...withoutEvidence, companyEvidence: [] }, T0)).toContain('No sourced company evidence is on file');
  });
});

/* ======================================================== research: bounded, cancellable, redacted == */

function scriptedClient(options: {
  events: (signal: AbortSignal | undefined) => AsyncGenerator<unknown>;
  providers?: unknown[];
}) {
  const created: { prompt: string; cwd: string; provider: string }[] = [];
  const cancel = vi.fn(async () => {});
  const client = {
    providers: {
      list: vi.fn(async () => options.providers ?? [{ id: 'claude', installed: true, authenticated: 'authenticated' }]),
    },
    sessions: {
      createVacancyWebDiscovery: vi.fn(async (request: { prompt: string; cwd: string; provider: string }) => {
        created.push(request);
        return { id: 'session-1' };
      }),
      events: (_id: string, init?: { signal?: AbortSignal }) => options.events(init?.signal),
      cancel,
    },
  } as unknown as AgentDockClient;
  return { client, created, cancel };
}

const answer = (facts: unknown[], queries: string[] = ['Northwind Freight depots']) =>
  `Here is what I found.\n\`\`\`json\n${JSON.stringify({ facts, queriesUsed: queries })}\n\`\`\``;

async function* completed(text: string): AsyncGenerator<unknown> {
  yield { type: 'tool.started', toolName: 'WebSearch' };
  yield { type: 'tool.started', toolName: 'WebFetch' };
  yield { type: 'assistant.message', text };
  yield { type: 'session.completed' };
}

describe('explicit, bounded, cancellable research', () => {
  const PRIVATE = ['CV-SENTINEL-7731', 'NOTE-SENTINEL-9954', 'Jamie Rivera', 'jamie@example.invalid'];

  function wireResearch(client: AgentDockClient) {
    research.mockImplementation((input: Parameters<typeof runCompanyResearchSession>[1]['input'], signal: AbortSignal) =>
      runCompanyResearchSession(client, { input, cwd: join(dir, 'ai-workspace'), signal }),
    );
  }

  it('sends only public fields to the web-only session and keeps private text out of the prompt, queries and diagnostics', async () => {
    workspace.createCvDocument(db, { name: 'CV', kind: 'manual', text: `${PRIVATE[0]} ${PRIVATE[2]} ${PRIVATE[3]}`, profile: { title: '', location: '', skills: [], summary: '' }, isDefault: true });
    const application = workspace.createApplication(db, { role: 'Platform Engineer', company: 'Northwind Freight', location: '', status: 'interview', notes: `${PRIVATE[1]} salary talk` });
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND, { applicationId: application.id });

    web.page(ABOUT, `${PLATFORM_QUOTE}. Founded in 2009`);
    const { client, created } = scriptedClient({
      events: () =>
        completed(
          answer([
            { claim: 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', topic: 'size', scope: 'company', sourceUrl: ABOUT, quote: PLATFORM_QUOTE },
            { claim: 'Northwind Freight has a rail division in Antwerp.', topic: 'general', scope: 'company', sourceUrl: ABOUT, quote: 'Northwind Freight has a rail division in Antwerp' },
            { claim: 'Not a secure source at all for this one.', topic: 'general', scope: 'company', sourceUrl: 'http://plain.example/x', quote: 'a quote that is long enough to be accepted' },
          ]),
        ),
    });
    wireResearch(client);

    const result = await researchCompany(deps, target(attempt.id), { topics: ['size', 'general'] }, runs);
    expect(result).toMatchObject({ ok: true, stats: { sessions: 1, candidates: 2, confirmed: 1 } });

    // The session was the existing web-only route, Claude only, in the app's empty scratch dir.
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ provider: 'claude', cwd: join(dir, 'ai-workspace') });
    const prompt = created[0]!.prompt;
    expect(prompt).toContain('Northwind Freight');
    // An ATS tenant is the POSTING's identity: the board and the posting address, website unknown.
    expect(prompt).toContain('Verified job-board account: greenhouse board "northwind" (the posting: https://job-boards.greenhouse.io/northwind/jobs/1001)');
    expect(prompt).toContain('Employer website: UNKNOWN.');
    expect(prompt).not.toMatch(/Verified (employer )?website: job-boards\.greenhouse\.io/);
    expect(prompt).toContain('Platform Engineer');
    for (const secret of PRIVATE) expect(prompt).not.toContain(secret);

    // The model's claim is a lead until the app's own fetch finds the quote.
    const view = getView(deps, target(attempt.id));
    const byClaim = new Map(view.facts.map((fact) => [fact.claim, fact]));
    expect(byClaim.get('Northwind Freight operates 14 depots across the Netherlands and Belgium.')).toMatchObject({ origin: 'research', verification: 'source_confirmed', support: 'supported' });
    expect(byClaim.get('Northwind Freight has a rail division in Antwerp.')).toMatchObject({ origin: 'research', verification: 'unverified', support: 'lead', lastRefreshReason: 'quote_not_found' });
    expect(byClaim.size).toBe(2);

    // Diagnostics: stable codes, counts and the model's public queries. Nothing private, nothing remote.
    expect(view.research).toMatchObject({ status: 'completed', candidates: 2, confirmed: 1, queries: ['Northwind Freight depots'] });
    const everything = JSON.stringify([view, db.select().from(schema.companyEvidenceRecords).all(), db.select().from(schema.companyEvidenceFacts).all()]);
    for (const secret of PRIVATE) expect(everything).not.toContain(secret);
  });

  it('exposes no way to pass candidate data into a query (the input type and prompt carry public fields only)', () => {
    const input = { companyName: 'Northwind Freight', website: 'northwind.example', jobBoard: null, roleTitle: 'Platform Engineer', topics: ['size'] as const };
    const prompt = buildCompanyResearchPrompt({ ...input, ...({ cvText: 'CV-SENTINEL', notes: 'NOTE-SENTINEL' } as object) });
    expect(prompt).not.toContain('SENTINEL');
    expect(buildCompanyResearchPrompt({ ...input, roleTitle: '' })).toContain('company-level facts only');
    expect(parseCompanyResearchResponse('no json here')).toBeNull();
    expect(parseCompanyResearchResponse(answer([{ claim: 'short', topic: 'size', scope: 'company', sourceUrl: ABOUT, quote: 'x' }]))?.candidates).toEqual([]);
  });

  it('cancels mid-run without writing anything and leaves existing evidence and drafts untouched', async () => {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    await addSized(target(attempt.id), 'Northwind Freight was founded in 2009.', ABOUT, 'It was founded in 2009', { topic: 'other' });
    const factsBefore = JSON.stringify(db.select().from(schema.companyEvidenceFacts).all());
    const recordBefore = JSON.stringify(db.select().from(schema.companyEvidenceRecords).all());

    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client, cancel } = scriptedClient({
      events: async function* (signal) {
        yield { type: 'tool.started', toolName: 'WebSearch' };
        release?.();
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('aborted');
      },
    });
    wireResearch(client);
    const handlers = createCompanyEvidenceHandlers({ service: async () => deps, runs, mutate: (task) => Promise.resolve(task()) });

    const running = handlers['company-evidence:research']!({ attemptId: attempt.id, topics: ['size'] });
    await started;
    // A second research for the same company while one runs is refused, not queued.
    expect(await handlers['company-evidence:research']!({ attemptId: attempt.id, topics: ['size'] })).toMatchObject({ ok: false, code: 'busy' });
    expect(await handlers['company-evidence:cancel']!({ attemptId: attempt.id })).toEqual({ ok: true, cancelled: true });

    const result = (await running) as { ok: true; notice: string; view: CompanyEvidenceView };
    expect(result.ok).toBe(true);
    expect(result.notice).toContain('Stopped');
    expect(cancel).toHaveBeenCalled();
    expect(JSON.stringify(db.select().from(schema.companyEvidenceFacts).all())).toBe(factsBefore);
    expect(JSON.stringify(db.select().from(schema.companyEvidenceRecords).all())).toBe(recordBefore);
    expect(runs.active).toBe(0);
  });

  it('reports every failure as a stable code, stores nothing, and removes a record it created for nothing', async () => {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const cases: { name: string; events: () => AsyncGenerator<unknown>; providers?: unknown[]; status: string }[] = [
      {
        name: 'session failed',
        events: async function* () {
          yield { type: 'session.failed', message: 'Authorization: Bearer SECRET-REMOTE-TEXT' };
        },
        status: 'failed',
      },
      {
        name: 'budget exceeded',
        events: async function* () {
          for (let index = 0; index < 5; index += 1) yield { type: 'tool.started', toolName: 'WebSearch' };
          yield { type: 'assistant.message', text: answer([{ claim: `${PLATFORM_QUOTE}.`, topic: 'size', scope: 'company', sourceUrl: ABOUT, quote: PLATFORM_QUOTE }]) };
          yield { type: 'session.completed' };
        },
        status: 'budget_exceeded',
      },
      { name: 'garbled answer', events: () => completed('I could not format this'), status: 'failed' },
      { name: 'not signed in', events: () => completed(''), providers: [{ id: 'claude', installed: true, authenticated: 'unauthenticated' }], status: 'unavailable' },
      { name: 'not installed', events: () => completed(''), providers: [{ id: 'claude', installed: false, authenticated: 'unknown' }], status: 'unavailable' },
    ];
    for (const item of cases) {
      const { client } = scriptedClient({ events: item.events, ...(item.providers ? { providers: item.providers } : {}) });
      wireResearch(client);
      const result = await researchCompany(deps, target(attempt.id), { topics: ['size'] }, runs);
      expect(result.ok, item.name).toBe(true);
      expect(db.select().from(schema.companyEvidenceFacts).all(), item.name).toEqual([]);
      // The record it created for the attempt is gone again: nothing is left behind by a failure.
      expect(db.select().from(schema.companyEvidenceRecords).all(), item.name).toEqual([]);
      expect(JSON.stringify(result), item.name).not.toContain('SECRET-REMOTE-TEXT');
    }
    // Research off entirely: user-supplied evidence keeps working.
    const bare = { ...deps };
    delete (bare as { runResearch?: unknown }).runResearch;
    expect(await researchCompany(bare, target(attempt.id), {}, runs)).toMatchObject({ ok: false, code: 'unavailable' });
    expect((await addSized(target(attempt.id), 'Northwind Freight was founded in 2009.', ABOUT, 'It was founded in 2009', { topic: 'other' })).ok).toBe(true);
  });
});

/* ======================================================================== IPC handlers + gate ===== */

describe('IPC surface', () => {
  function handlers(mutate = vi.fn((task: () => unknown) => Promise.resolve(task()))) {
    return { mutate, handlers: createCompanyEvidenceHandlers({ service: async () => deps, runs, mutate: mutate as never }) };
  }

  it('parses strictly: both ids, no id, unknown keys (a CV, a note) and bad enums are refused before anything runs', async () => {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const { handlers: h, mutate } = handlers();
    const refused = { ok: false, code: 'invalid_request' };
    expect(await h['company-evidence:get']!({})).toMatchObject(refused);
    expect(await h['company-evidence:get']!({ attemptId: attempt.id, applicationId: 'x' })).toMatchObject(refused);
    expect(await h['company-evidence:get']!({ attemptId: attempt.id, cvText: 'CV-SENTINEL' })).toMatchObject(refused);
    expect(await h['company-evidence:research']!({ attemptId: attempt.id, notes: 'NOTE-SENTINEL' })).toMatchObject(refused);
    expect(await h['company-evidence:add-fact']!({ attemptId: attempt.id, claim: 'x'.repeat(10), sourceUrl: ABOUT, scope: 'galaxy' })).toMatchObject(refused);
    expect(mutate).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(await h['company-evidence:get']!({ attemptId: attempt.id })).toMatchObject({ ok: true });
  });

  it('runs every mutation through the data-reset gate, reads and long actions outside it, and never echoes stored text on failure', async () => {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const { handlers: h, mutate } = handlers();
    await h['company-evidence:get']!({ attemptId: attempt.id });
    await h['company-evidence:prose']!({ attemptId: attempt.id });
    expect(mutate).not.toHaveBeenCalled();
    await h['company-evidence:add-fact']!({ attemptId: attempt.id, claim: 'Northwind Freight was founded in 2009.', sourceUrl: ABOUT, quote: 'It was founded in 2009', scope: 'company', topic: 'other' });
    await h['company-evidence:delete']!({ attemptId: attempt.id });
    expect(mutate).toHaveBeenCalledTimes(2);

    const missing = await h['company-evidence:get']!({ applicationId: 'no-such-application' });
    expect(missing).toMatchObject({ ok: false, code: 'not_found' });
    expect(JSON.stringify(missing)).not.toContain('no-such-application');
  });

  it('is refused while a data reset runs, and a reset waits for (or refuses) an active mutation', async () => {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const gate = new ApplicationDataResetGate();
    const h = createCompanyEvidenceHandlers({ service: async () => deps, runs, mutate: (task) => gate.runMutation(task) });
    let finish: (() => void) | undefined;
    const reset = gate.runReset(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await expect(h['company-evidence:delete']!({ attemptId: attempt.id })).rejects.toBeInstanceOf(ApplicationDataResetBusyError);
    finish?.();
    await reset;
    expect(await h['company-evidence:delete']!({ attemptId: attempt.id })).toMatchObject({ ok: false, code: 'record_not_found' });
  });
});

/* =========================================================================== retention + reset ===== */

describe('deletion, reset and retention', () => {
  async function seedEverything() {
    const platform = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const group = makeAttempt('Northwind Freight Group', 'Dispatcher', 'https://careers.northwind-freight-group.example/jobs/9');
    await addSized(target(platform.id), 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', ABOUT, PLATFORM_QUOTE);
    web.page('https://northwind-freight-group.example/about', 'Northwind Freight Group runs a dispatch centre in Rotterdam for its own fleet');
    await addSized(target(group.id), 'Northwind Freight Group runs a dispatch centre in Rotterdam.', 'https://northwind-freight-group.example/about', 'Northwind Freight Group runs a dispatch centre in Rotterdam for its own fleet');
    const used = proseEvidence(deps, target(platform.id), 'letter');
    store.recordEvidenceUses(db, platform.id, used, clock);
    return { platform, group };
  }

  it('Settings reset removes every evidence table with real counts, leaving no orphan', async () => {
    await seedEverything();
    const result = workspace.resetApplicationData(db);
    expect(result.deleted).toMatchObject({ companyEvidenceRecords: 2, companyEvidenceFacts: 2, companyEvidenceLinks: 1, companyEvidenceUses: 1 });
    for (const table of [schema.companyEvidenceRecords, schema.companyEvidenceFacts, schema.companyEvidenceContradictions, schema.companyEvidenceIdentityLinks, schema.applicationAttemptEvidenceUses]) {
      expect(db.select().from(table).all()).toEqual([]);
    }
  });

  it('drops a research result that finishes after a reset: nothing is written and no record is re-created', async () => {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    let finish: ((value: unknown) => void) | undefined;
    research.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = researchCompany(deps, target(attempt.id), { topics: ['size'] }, runs);
    await vi.waitFor(() => expect(runs.active).toBe(1));
    // What `workspace:data:reset` does: cancel runs, then clear the tables.
    runs.cancelAll();
    workspace.resetApplicationData(db);
    finish?.({
      status: 'completed',
      reason: 'completed',
      queries: ['q'],
      searches: 1,
      fetches: 1,
      candidates: [{ claim: 'Northwind Freight has 200 employees.', topic: 'size', scope: 'company', sourceUrl: ABOUT, quote: 'Northwind Freight has 200 employees' }],
    });
    // The attempt itself was reset away, so there is nothing to describe: a refusal, never a throw.
    expect(await running).toMatchObject({ ok: false, code: 'not_found' });
    expect(db.select().from(schema.companyEvidenceRecords).all()).toEqual([]);
    expect(db.select().from(schema.companyEvidenceFacts).all()).toEqual([]);
  });

  it('deleting or correcting evidence never rewrites what a prepared package said', async () => {
    const { platform } = await seedEverything();
    const attemptBefore = JSON.stringify(workspace.getApplicationAttempt(db, platform.id));
    const usesBefore = store.listEvidenceUses(db, platform.id);
    expect(usesBefore).toHaveLength(1);

    const view = getView(deps, target(platform.id));
    correctFact(deps, target(platform.id), view.facts[0]!.id, 'Northwind Freight operates 99 depots.');
    expect(deleteRecordFor(deps, target(platform.id), runs).ok).toBe(true);
    expect(db.select().from(schema.companyEvidenceFacts).all().map((row) => row.recordId)).not.toContain(view.recordId);

    expect(store.listEvidenceUses(db, platform.id)).toEqual(usesBefore);
    expect(JSON.stringify(workspace.getApplicationAttempt(db, platform.id))).toBe(attemptBefore);
    expect(getView(deps, target(platform.id)).lettersUsed).toMatchObject([{ claim: 'Northwind Freight operates 14 depots across the Netherlands and Belgium.' }]);

    // A submitted attempt's snapshot is never replaced, even by a direct store call.
    db.update(schema.applicationAttempts).set({ checkpoint: 'submitted', submittedAt: new Date(clock) }).run();
    store.recordEvidenceUses(db, platform.id, [], clock);
    expect(store.listEvidenceUses(db, platform.id)).toEqual(usesBefore);
  });

  it('deleting the attempt removes its snapshot with it, and a lone record with no facts is pruned', async () => {
    const { platform } = await seedEverything();
    workspace.deleteApplicationAttempt(db, platform.id);
    expect(store.listEvidenceUses(db, platform.id)).toEqual([]);

    const group = workspace.listApplicationAttempts(db).find((row) => row.role === 'Dispatcher')!;
    const view = getView(deps, target(group.id));
    withdrawFact(deps, target(group.id), view.facts[0]!.id);
    // The proposed link alone does not keep an emptied record alive.
    expect(store.getRecord(db, view.recordId!)).toBeNull();
  });

  it('bounds a record to its newest facts and never prunes a current supported one', async () => {
    const attempt = makeAttempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    await addSized(target(attempt.id), 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', ABOUT, PLATFORM_QUOTE);
    const recordId = getView(deps, target(attempt.id)).recordId!;
    for (let index = 0; index < store.MAX_FACTS_PER_RECORD + 15; index += 1) {
      store.insertFact(
        db,
        {
          recordId,
          scope: 'company',
          roleKey: '',
          roleLabel: '',
          topic: 'other',
          claim: `Rumour number ${index} about Northwind.`,
          sourceUrl: `https://rumours.example/${index}`,
          sourceKind: 'public_web',
          quote: '',
          verification: 'unverified',
          origin: 'research',
          retrievedAt: null,
          observedAt: new Date(T0.getTime() - 200 * DAY),
          contentHash: null,
        },
        new Date(T0.getTime() + index),
      );
    }
    const rows = db.select().from(schema.companyEvidenceFacts).all();
    expect(rows.length).toBeLessThanOrEqual(store.MAX_FACTS_PER_RECORD);
    expect(rows.some((row) => row.claim.startsWith('Northwind Freight operates 14 depots'))).toBe(true);
  });
});


/* ================================================================== measurement (fixed fixtures) ===== */

describe('#689 measurement on a fixed synthetic fixture set', () => {
  /**
   * Method (stated in the output file too): 14 synthetic roles at 7 synthetic employers are carried through
   * the real `researchCompany` action in a fixed order, twice, against a fresh migrated database:
   *  - "cold" = no shared record: the employer's evidence is deleted after each role, i.e. every role
   *    pays for its own research (what the app did before this record existed, for every role);
   *  - "shared" = the record is kept, so a later role at the same verified employer is served from it.
   * Counted: research sessions the (scripted) provider was asked to start, safe source fetches the app
   * made, and the facts that reached the letter / interview lists. Fixture author's labels only: pages,
   * quotes and truth are invented, no real employer or latency is measured, and nothing here claims the
   * evidence makes a letter or an interview better.
   */
  const EMPLOYERS = [
    { n: 1, roles: 3, lead: false },
    { n: 2, roles: 3, lead: false },
    { n: 3, roles: 2, lead: false },
    { n: 4, roles: 2, lead: false },
    { n: 5, roles: 2, lead: true }, // its location quote is not on the page: never fully verified
  ];
  const TOPICS = ['general', 'products', 'location'] as const;

  interface Role {
    employer: number;
    group: boolean;
    index: number;
    company: string;
    role: string;
    url: string;
  }

  function fixtureRoles(): Role[] {
    const roles: Role[] = [];
    for (const employer of EMPLOYERS) {
      for (let index = 1; index <= employer.roles; index += 1) {
        roles.push({ employer: employer.n, group: false, index, company: `Emp${employer.n} Corp`, role: `Role ${employer.n}.${index}`, url: `https://job-boards.greenhouse.io/emp${employer.n}/jobs/${employer.n}0${index}` });
      }
    }
    // Look-alike names with their own domains: they must never inherit the employers above.
    for (const n of [1, 2]) {
      roles.push({ employer: n, group: true, index: 1, company: `Emp${n} Corp Group`, role: `Group role ${n}`, url: `https://careers.emp${n}corpgroup.example/jobs/1` });
    }
    return roles;
  }

  const pageFor = (role: Role): string => (role.group ? `https://emp${role.employer}corpgroup.example/about` : `https://emp${role.employer}.example/about`);
  const sentence = (role: Role, topic: string): string => `${role.company} states ${topic} fact number ${role.employer}`;

  function scenario() {
    const sessions = { count: 0 };
    const localWeb = new FakeWeb();
    const localDir = mkdtempSync(join(tmpdir(), 'ovr-evidence-measure-'));
    const created = createWorkspaceDb(localDir);
    let localClock = new Date(T0);
    const roles = fixtureRoles();
    for (const role of roles) {
      const page = pageFor(role);
      const employer = EMPLOYERS.find((entry) => entry.n === role.employer)!;
      const lines = TOPICS.filter((topic) => !(employer.lead && topic === 'location' && !role.group)).map((topic) => sentence(role, topic));
      localWeb.page(page, `${lines.join('. ')}. Plus unrelated text`);
    }
    const localResearch = vi.fn(async (input: { companyName: string }) => {
      sessions.count += 1;
      const role = roles.find((entry) => entry.company === input.companyName)!;
      return {
        status: 'completed' as const,
        reason: 'completed',
        queries: [`${input.companyName} about`],
        searches: 1,
        fetches: 3,
        candidates: TOPICS.map((topic) => ({
          claim: `${sentence(role, topic)}.`,
          topic,
          scope: 'company' as const,
          sourceUrl: pageFor(role),
          quote: sentence(role, topic),
        })),
      };
    });
    const localDeps: CompanyEvidenceDeps = {
      db: created.db,
      now: () => new Date(localClock),
      getHttp: async () => localWeb.client,
      runResearch: localResearch as unknown as CompanyEvidenceDeps['runResearch'],
    };
    const localRuns = new CompanyEvidenceRuns();
    const attempts = roles.map((role) =>
      workspace.createApplicationAttempt(created.db, { company: role.company, role: role.role, canonicalUrl: role.url, sourceCvContentHash: 'h', jdSnapshotHash: 'j', force: true }),
    );
    return { roles, attempts, sessions, web: localWeb, db: created.db, deps: localDeps, runs: localRuns, advance: (ms: number) => { localClock = new Date(localClock.getTime() + ms); }, close: () => { created.close(); rmSync(localDir, { recursive: true, force: true }); } };
  }

  /**
   * Adversarial fixture matrix (fix round 1). Each case runs the REAL service/store/letter code on a
   * fresh database. `expected` is the fixture author's label of what the app MUST do (usable / lead /
   * refused), never a claim that a statement is true in the world.
   */
  async function adversarialMatrix() {
    type Case = { id: string; kind: string; expected: 'usable' | 'lead' | 'refused' | 'not_in_letter' | 'user_confirmed'; trueParaphrase?: boolean; run: (h: Harness) => Promise<string> };
    interface Harness {
      deps: CompanyEvidenceDeps;
      runs: CompanyEvidenceRuns;
      web: FakeWeb;
      db: WorkspaceDb;
      attempt: (company: string, role: string, url: string) => ReturnType<typeof workspace.createApplicationAttempt>;
      advance: (ms: number) => void;
    }
    const label = (h: Harness, attemptId: string, claim: string): string => {
      const fact = getView(h.deps, { attemptId }).facts.find((row) => row.claim === claim);
      if (!fact) return 'absent';
      return proseEvidence(h.deps, { attemptId }, 'interview').some((row) => row.id === fact.id) ? 'usable' : 'lead';
    };
    const add = (h: Harness, attemptId: string, claim: string, sourceUrl: string, quote: string, extra: Record<string, unknown> = {}) =>
      addFact(h.deps, { attemptId }, { claim, sourceUrl, quote, scope: 'company', topic: 'general', ...extra });
    const NW = 'https://job-boards.greenhouse.io/northwind/jobs/1001';
    const PAGE = 'https://northwind.example/about';
    /** A wrong claim next to one usable fact, through the real letter generator and its revalidation. */
    const letterWith = async (h: Harness, claim: string, sourceUrl: string, quote: string, scope: 'company' | 'role', needle: string): Promise<string> => {
      const a = h.attempt('Northwind Freight', 'R', NW);
      await add(h, a.id, claim, sourceUrl, quote, scope === 'role' ? { scope: 'role' } : { topic: 'size' });
      await add(h, a.id, 'Northwind Freight operates 14 depots in the Benelux.', PAGE, 'Northwind Freight operates 14 depots in the Benelux');
      const evidence = proseEvidence(h.deps, { attemptId: a.id }, 'letter');
      const record = workspace.getApplicationAttempt(h.db, a.id);
      const factIds = ['summary', ...evidence.map((_, index) => `company-${index + 1}`)];
      const letter = await generateApplicationCoverLetterWithEvidence(record, MEASURE_CV, async () => ({ ok: true, text: JSON.stringify({ factIds }) }), evidence, {
        revalidate: () => proseEvidence(h.deps, { attemptId: a.id }, 'letter'),
        now: h.deps.now,
      });
      if (letter.body.includes(needle) || letter.usedCompanyEvidence.some((fact) => fact.claim === claim)) return 'in_letter';
      return letter.body.includes('14 depots in the Benelux') ? 'not_in_letter' : 'letter_without_evidence';
    };
    const cases: Case[] = [
      { id: 'A1', kind: 'claim equals quote', expected: 'usable', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight operates 14 depots in the Benelux.', PAGE, 'Northwind Freight operates 14 depots in the Benelux'); return label(h, a.id, 'Northwind Freight operates 14 depots in the Benelux.'); } },
      { id: 'A2', kind: 'first-person passage, own name omitted', expected: 'usable', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight employs about 450 people.', PAGE, 'We employ about 450 people'); return label(h, a.id, 'Northwind Freight employs about 450 people.'); } },
      { id: 'A3', kind: 'unrelated boilerplate quote', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight employs 12,000 people worldwide.', PAGE, 'We are an equal opportunity employer and value diversity', { topic: 'size' }); return label(h, a.id, 'Northwind Freight employs 12,000 people worldwide.'); } },
      { id: 'A4', kind: 'number 14 vs 140', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight operates 140 depots in the Benelux.', PAGE, 'Northwind Freight operates 14 depots in the Benelux'); return label(h, a.id, 'Northwind Freight operates 140 depots in the Benelux.'); } },
      { id: 'A5', kind: 'opposite negation', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight offers remote work to every engineer.', PAGE, 'Northwind Freight does not offer remote work to every engineer'); return label(h, a.id, 'Northwind Freight offers remote work to every engineer.'); } },
      { id: 'A6', kind: 'different entity', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Contoso operates 14 depots in the Benelux.', PAGE, 'Northwind Freight operates 14 depots in the Benelux'); return label(h, a.id, 'Contoso operates 14 depots in the Benelux.'); } },
      { id: 'A7', kind: 'true paraphrase (author label: true, not near-verbatim)', expected: 'lead', trueParaphrase: true, run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight runs fourteen depots.', PAGE, 'Northwind Freight operates 14 depots in the Benelux'); return label(h, a.id, 'Northwind Freight runs fourteen depots.'); } },
      { id: 'A8', kind: 'sponsorship mislabelled general, random blog', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); h.web.page('https://blog.example/p', 'Northwind Freight sponsors work visas for this role'); await add(h, a.id, 'Northwind Freight sponsors work visas for this role.', 'https://blog.example/p', 'Northwind Freight sponsors work visas for this role', { scope: 'role' }); return label(h, a.id, 'Northwind Freight sponsors work visas for this role.'); } },
      { id: 'A9', kind: 'sponsorship on spoofed ATS host', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); const spoof = 'https://greenhouse.evil-lookalike.example/northwind/jobs/1'; h.web.page(spoof, 'Visa sponsorship is available for this role'); await add(h, a.id, 'Visa sponsorship is available for this role.', spoof, 'Visa sponsorship is available for this role', { scope: 'role', topic: 'sponsorship' }); return label(h, a.id, 'Visa sponsorship is available for this role.'); } },
      { id: 'A10', kind: 'sponsorship on the exact ATS tenant posting', expected: 'usable', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); h.web.page(NW, 'Visa sponsorship is available for this role'); await add(h, a.id, 'Visa sponsorship is available for this role.', NW, 'Visa sponsorship is available for this role', { scope: 'role' }); return label(h, a.id, 'Visa sponsorship is available for this role.'); } },
      { id: 'A11', kind: 'correction then refresh with the old passage', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight operates 14 depots in the Benelux.', PAGE, 'Northwind Freight operates 14 depots in the Benelux'); const id = getView(h.deps, { attemptId: a.id }).facts[0]!.id; await correctFact(h.deps, { attemptId: a.id }, id, 'Northwind Freight operates 140 depots on three continents.'); h.advance(COMPANY_FACT_TTL_MS + DAY); await refreshEvidence(h.deps, { attemptId: a.id }, h.runs); return label(h, a.id, 'Northwind Freight operates 140 depots on three continents.'); } },
      { id: 'A12', kind: 'public-suffix / shared-hosting domain confirmation', expected: 'refused', run: async (h) => { const a = h.attempt('Northwind', 'R', 'https://www.linkedin.com/jobs/view/1'); const out = ['github.io', 'northwind.github.io', 'co.uk', 'northwind.herokuapp.com'].map((domain) => confirmDomain(h.deps, { attemptId: a.id }, { domain }).ok); return out.every((ok) => !ok) ? 'refused' : 'accepted'; } },
      { id: 'A13', kind: 'same-name second vacancy after a confirmation elsewhere', expected: 'lead', run: async (h) => { const one = h.attempt('Apex', 'R1', 'https://www.jobgether.com/offer/1'); confirmDomain(h.deps, { attemptId: one.id }, { domain: 'apex-logistics.example' }); h.web.page('https://apex-logistics.example/a', 'Apex operates cold storage warehouses'); await add(h, one.id, 'Apex operates cold storage warehouses.', 'https://apex-logistics.example/a', 'Apex operates cold storage warehouses'); const two = h.attempt('Apex', 'R2', 'https://www.linkedin.com/jobs/view/2'); return proseEvidence(h.deps, { attemptId: two.id }, 'interview').length === 0 ? 'lead' : 'usable'; } },
      { id: 'A14', kind: 'look-alike posting host (prefix only)', expected: 'refused', run: async (h) => { const a = h.attempt('Apex', 'R', 'https://careers.apexlegends.example/jobs/1'); return getView(h.deps, { attemptId: a.id }).state === 'no_identity' ? 'refused' : 'accepted'; } },
      { id: 'A15', kind: 'linked records disagree (450 vs 9000) after link confirmed', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); const b = h.attempt('Northwind Freight Group', 'R', 'https://careers.northwind-freight-group.example/j/1'); h.web.page('https://northwind.example/s', 'Northwind Freight employs about 450 people'); h.web.page('https://northwind-freight-group.example/s', 'Northwind Freight Group employs about 9000 people'); await add(h, a.id, 'Northwind Freight employs about 450 people.', 'https://northwind.example/s', 'Northwind Freight employs about 450 people', { topic: 'size' }); await add(h, b.id, 'Northwind Freight Group employs about 9000 people.', 'https://northwind-freight-group.example/s', 'Northwind Freight Group employs about 9000 people', { topic: 'size' }); const link = getView(h.deps, { attemptId: a.id }).links[0]!; decideLink(h.deps, { attemptId: a.id }, link.id, 'confirmed'); return label(h, a.id, 'Northwind Freight employs about 450 people.'); } },
      { id: 'A16', kind: 'fact withdrawn while the letter is drafted', expected: 'not_in_letter', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight operates 14 depots in the Benelux.', PAGE, 'Northwind Freight operates 14 depots in the Benelux'); const id = getView(h.deps, { attemptId: a.id }).facts[0]!.id; const evidence = proseEvidence(h.deps, { attemptId: a.id }, 'letter'); const record = workspace.getApplicationAttempt(h.db, a.id); const letter = await generateApplicationCoverLetterWithEvidence(record, MEASURE_CV, async () => { withdrawFact(h.deps, { attemptId: a.id }, id); return { ok: true, text: '{"factIds":["summary","company-1"]}' }; }, evidence, { revalidate: () => proseEvidence(h.deps, { attemptId: a.id }, 'letter'), now: h.deps.now }); return letter.body.includes('depots') || letter.usedCompanyEvidence.length > 0 ? 'in_letter' : 'not_in_letter'; } },
      // ---- fix round 2: the reviewer's shapes (review-689-2-probe G1-G9, F1-F3, F17, E1) and positives ----
      { id: 'B1', kind: 'G2 role sponsorship, quote cut before "for some roles, but not for this one" on the exact tenant page', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); h.web.pages.set(NW, { status: 200, body: '<h1>R</h1><p>Northwind Freight offers visa sponsorship for some roles, but not for this one.</p>' }); await add(h, a.id, 'Northwind Freight offers visa sponsorship.', NW, 'Northwind Freight offers visa sponsorship', { scope: 'role' }); return label(h, a.id, 'Northwind Freight offers visa sponsorship.'); } },
      { id: 'B2', kind: 'G2 claim drops the "but not" its own passage carries', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight offers visa sponsorship.', NW, 'Northwind Freight offers visa sponsorship for some roles, but not for this one', { scope: 'role' }); return label(h, a.id, 'Northwind Freight offers visa sponsorship.'); } },
      { id: 'B3', kind: 'G3 claim drops "except engineering"', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight offers remote work.', PAGE, 'Northwind Freight offers remote work for every team except engineering'); return label(h, a.id, 'Northwind Freight offers remote work.'); } },
      { id: 'B4', kind: 'G1 claim drops "in Germany only for senior hires"', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight sponsors work visas for this role.', NW, 'Northwind Freight sponsors work visas for this role in Germany only for senior hires', { scope: 'role' }); return label(h, a.id, 'Northwind Freight sponsors work visas for this role.'); } },
      { id: 'B5', kind: 'G6 Dutch claim drops ", maar niet voor deze rol"', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight biedt visumsponsoring aan.', NW, 'Northwind Freight biedt visumsponsoring aan, maar niet voor deze rol', { scope: 'role' }); return label(h, a.id, 'Northwind Freight biedt visumsponsoring aan.'); } },
      { id: 'B6', kind: 'G4 name-only claim', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight.', PAGE, 'Northwind Freight is a logistics firm operating in Europe today'); return label(h, a.id, 'Northwind Freight.'); } },
      { id: 'B7', kind: 'G5 name + region claim', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight Europe.', PAGE, 'Northwind Freight is a logistics firm operating in Europe today'); return label(h, a.id, 'Northwind Freight Europe.'); } },
      { id: 'B8', kind: 'F1 figure borrowed from a competitor in the next sentence', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight employs 12,000 people.', PAGE, 'Northwind Freight is a logistics firm. Our competitor Acme Haulage employs 12,000 people worldwide.', { topic: 'size' }); return label(h, a.id, 'Northwind Freight employs 12,000 people.'); } },
      { id: 'B9', kind: 'G9 competitor is the subject, own name inside the sentence', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight employs 12,000 people.', PAGE, 'Acme, a competitor of Northwind Freight, employs 12,000 people', { topic: 'size' }); return label(h, a.id, 'Northwind Freight employs 12,000 people.'); } },
      { id: 'B10', kind: 'F3 founding date borrowed from a later acquisition', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight was founded in 2019.', PAGE, 'Northwind Freight was founded in 1998 and acquired by Contoso Holdings in 2019 for growth.'); return label(h, a.id, 'Northwind Freight was founded in 2019.'); } },
      { id: 'B11', kind: 'F17 market-leader claim borrowed from a competitor sentence', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight is the market leader.', PAGE, 'Northwind Freight is a small carrier. Acme is the market leader in the region by revenue.'); return label(h, a.id, 'Northwind Freight is the market leader.'); } },
      { id: 'B12', kind: 'whole quote sentence, but the NEXT page sentence restricts it ("This does not apply to this role")', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); h.web.pages.set(NW, { status: 200, body: '<p>Northwind Freight sponsors work visas. This does not apply to this role.</p>' }); await add(h, a.id, 'Northwind Freight sponsors work visas.', NW, 'Northwind Freight sponsors work visas', { scope: 'role' }); return label(h, a.id, 'Northwind Freight sponsors work visas.'); } },
      { id: 'B13', kind: 'sponsorship synonym (immigration help for non-EU hires) labelled general on a blog', expected: 'lead', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); h.web.page('https://random-blog.example/p', 'Northwind Freight offers relocation support and immigration help for non-EU hires'); await add(h, a.id, 'Northwind Freight offers relocation support and immigration help for non-EU hires.', 'https://random-blog.example/p', 'Northwind Freight offers relocation support and immigration help for non-EU hires'); return label(h, a.id, 'Northwind Freight offers relocation support and immigration help for non-EU hires.'); } },
      { id: 'B14', kind: 'sponsorship synonym (30% ruling) for this role, whole sentence on the exact tenant', expected: 'usable', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); h.web.pages.set(NW, { status: 200, body: '<h2>Benefits</h2><p>Northwind Freight applies the 30% ruling for this role.</p>' }); await add(h, a.id, 'Northwind Freight applies the 30% ruling for this role.', NW, 'Northwind Freight applies the 30% ruling for this role', { scope: 'role' }); return label(h, a.id, 'Northwind Freight applies the 30% ruling for this role.'); } },
      { id: 'B15', kind: 'whole sentence after a heading block on the employer site', expected: 'usable', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); h.web.pages.set('https://northwind.example/rail', { status: 200, body: '<h1>Rail</h1><p>Northwind Freight runs a rail terminal in Venlo.</p>' }); await add(h, a.id, 'Northwind Freight runs a rail terminal in Venlo.', 'https://northwind.example/rail', 'Northwind Freight runs a rail terminal in Venlo'); return label(h, a.id, 'Northwind Freight runs a rail terminal in Venlo.'); } },
      { id: 'B16', kind: 'true paraphrase of a whole sentence ("runs" for "operates")', expected: 'lead', trueParaphrase: true, run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight runs 14 depots in the Benelux.', PAGE, 'Northwind Freight operates 14 depots in the Benelux'); return label(h, a.id, 'Northwind Freight runs 14 depots in the Benelux.'); } },
      { id: 'B17', kind: 'E1 borrowed-figure claim through the real letter path (with one usable fact)', expected: 'not_in_letter', run: async (h) => letterWith(h, 'Northwind Freight employs 12,000 people.', PAGE, 'Northwind Freight is a logistics firm. Our competitor Acme Haulage employs 12,000 people worldwide.', 'company', '12,000') },
      { id: 'B18', kind: 'cut-off role sponsorship through the real letter path (with one usable fact)', expected: 'not_in_letter', run: async (h) => { h.web.pages.set(NW, { status: 200, body: '<p>Northwind Freight offers visa sponsorship for some roles, but not for this one.</p>' }); return letterWith(h, 'Northwind Freight offers visa sponsorship.', NW, 'Northwind Freight offers visa sponsorship', 'role', 'visa sponsorship'); } },
      { id: 'B19', kind: 'a refused lead the person explicitly attests stays labelled as THEIR confirmation (never source_confirmed)', expected: 'user_confirmed', run: async (h) => { const a = h.attempt('Northwind Freight', 'R', NW); await add(h, a.id, 'Northwind Freight employs 12,000 people.', PAGE, 'Northwind Freight is a logistics firm. Our competitor Acme Haulage employs 12,000 people worldwide.', { topic: 'size' }); const id = getView(h.deps, { attemptId: a.id }).facts[0]!.id; confirmFact(h.deps, { attemptId: a.id }, id); const used = proseEvidence(h.deps, { attemptId: a.id }, 'interview').find((row) => row.id === id); return used ? used.verification : 'absent'; } },
    ];
    const rows: Record<string, unknown>[] = [];
    const FLOOR_ONLY_CASES = new Set(['A3', 'A4', 'A6', 'A7', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B16']);
    /** One-fact cases whose quote passes alone but whose PAGE sentence does not: the fetch is what shows it. */
    const PAGE_CONTEXT_CASES = new Set(['B1', 'B12']);
    let pageContextFetches = 0;
    let floorFailedFetches = 0;
    for (const entry of cases) {
      const localDir = mkdtempSync(join(tmpdir(), 'ovr-evidence-adv-measure-'));
      const created = createWorkspaceDb(localDir);
      const localWeb = new FakeWeb();
      localWeb.page('https://northwind.example/about', 'Northwind Freight operates 14 depots in the Benelux. We employ about 450 people. We are an equal opportunity employer and value diversity. Northwind Freight does not offer remote work to every engineer');
      let localClock = new Date(T0);
      const h: Harness = {
        deps: { db: created.db, now: () => new Date(localClock), getHttp: async () => localWeb.client },
        runs: new CompanyEvidenceRuns(),
        web: localWeb,
        db: created.db,
        attempt: (company, role, url) => workspace.createApplicationAttempt(created.db, { company, role, canonicalUrl: url, sourceCvContentHash: 'h', jdSnapshotHash: 'j', force: true }),
        advance: (ms) => {
          localClock = new Date(localClock.getTime() + ms);
        },
      };
      try {
        const observed = await entry.run(h);
        const floorRefusals = created.db
          .select()
          .from(schema.companyEvidenceFacts)
          .all()
          .filter((row) => (row.lastRefreshReason ?? '').startsWith('claim_')).length;
        // Single-fact cases whose only claim fails the floor: any request here would be wasted.
        if (FLOOR_ONLY_CASES.has(entry.id)) floorFailedFetches += localWeb.calls.length;
        if (PAGE_CONTEXT_CASES.has(entry.id)) pageContextFetches += localWeb.calls.length;
        rows.push({
          id: entry.id,
          kind: entry.kind,
          expected: entry.expected,
          observed,
          matches: observed === entry.expected,
          appSourceFetches: localWeb.calls.length,
          floorRefusedFacts: floorRefusals,
          ...(entry.trueParaphrase ? { trueParaphrase: true } : {}),
        });
      } finally {
        created.close();
        rmSync(localDir, { recursive: true, force: true });
      }
    }
    for (const row of rows) expect(row, String(row.id)).toMatchObject({ matches: true });
    return {
      kind: 'SYNTHETIC adversarial matrix; expected = fixture author label of what the app must do, not truth about any real employer',
      cases: rows,
      summary: {
        cases: rows.length,
        matchingExpectation: rows.filter((row) => row.matches).length,
        falselyUsable: rows.filter((row) => row.observed === 'usable' && row.expected !== 'usable').length,
        trueParaphrasesKeptAsLeads: rows.filter((row) => row.trueParaphrase && row.observed === 'lead').length,
        appSourceFetchesSpentOnFloorFailures: floorFailedFetches,
        floorFailureCases: FLOOR_ONLY_CASES.size,
        pageContextCases: PAGE_CONTEXT_CASES.size,
        appSourceFetchesInPageContextCases: pageContextFetches,
        personAttestedCases: rows.filter((row) => row.observed === 'user_confirmed').length,
        wrongClaimsInRenderedLetters: rows.filter((row) => row.observed === 'in_letter').length,
        scope: 'Counts are over THESE labelled synthetic cases only; they are not an accuracy rate and do not show that no wrong claim can ever become usable.',
      },
    };
  }

  const MEASURE_CV = {
    id: 'cv-m',
    name: 'CV',
    kind: 'manual',
    text: 'Synthetic CV.',
    profile: { title: 'Engineer', location: 'Amsterdam', skills: [], summary: 'Synthetic.' },
    source: {
      contact: { name: 'Sam Example', title: 'Engineer', location: 'Amsterdam', email: 'sam@example.invalid', phone: '+31 6 0000 0000', links: [] },
      summary: 'Synthetic summary for a synthetic candidate.',
      experience: [{ id: 'experience-1', company: 'Example BV', title: 'Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: ['Built things.'] }],
      education: [],
      projects: [],
      maxProjects: 0,
      complete: true,
      incompleteReason: '',
      coveredChars: 100,
      sourceChars: 100,
      reviewedAt: '2026-01-01T00:00:00.000Z',
    },
    isDefault: true,
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
  } as unknown as Parameters<typeof generateApplicationCoverLetterWithEvidence>[1];

  it('counts the research sessions and fetches avoided and the verified claims reused, with no accuracy claim', async () => {
    const cold = scenario();
    const warm = scenario();
    try {
      let coldFetches = 0;
      let warmFetches = 0;
      let inAppAvoidedSessions = 0;
      let inAppAvoidedFetches = 0;
      const perRole: Record<string, unknown>[] = [];
      for (let index = 0; index < cold.roles.length; index += 1) {
        const role = cold.roles[index]!;
        const coldBefore = cold.web.calls.length;
        const coldResult = await researchCompany(cold.deps, { attemptId: cold.attempts[index]!.id }, { topics: [...TOPICS] }, cold.runs);
        expect(coldResult.ok).toBe(true);
        coldFetches += cold.web.calls.length - coldBefore;
        deleteRecordFor(cold.deps, { attemptId: cold.attempts[index]!.id }, cold.runs);

        const sessionsBefore = warm.sessions.count;
        const warmBefore = warm.web.calls.length;
        const warmResult = await researchCompany(warm.deps, { attemptId: warm.attempts[index]!.id }, { topics: [...TOPICS] }, warm.runs);
        expect(warmResult.ok).toBe(true);
        warmFetches += warm.web.calls.length - warmBefore;
        if (warmResult.ok) {
          inAppAvoidedSessions += warmResult.stats?.avoidedSessions ?? 0;
          inAppAvoidedFetches += warmResult.stats?.avoidedFetches ?? 0;
        }
        perRole.push({
          role: role.role,
          lookAlikeEmployer: role.group,
          coldSessions: 1,
          sharedSessions: warm.sessions.count - sessionsBefore,
          sharedCacheHit: warmResult.ok ? warmResult.stats?.cacheHit === true : false,
        });
      }

      const roles = warm.roles.length;
      expect(cold.sessions.count).toBe(roles);
      const avoidedSessions = cold.sessions.count - warm.sessions.count;
      const avoidedFetches = coldFetches - warmFetches;
      // E1..E4 re-use after their first role (2+2+1+1 = 6 roles); E5 never verifies every topic, so it re-researches.
      // Derived from the fixture's structure, not a remembered number: every fully verifiable employer
      // re-uses its record after its first role; Emp5 never verifies every topic, so it re-researches.
      const expectedAvoided = EMPLOYERS.filter((employer) => !employer.lead).reduce((sum, employer) => sum + employer.roles - 1, 0);
      expect(avoidedSessions).toBe(expectedAvoided);
      expect(avoidedFetches).toBe(expectedAvoided * TOPICS.length);
      // The in-app stats report only what they observed: one session not started per cache hit, and no
      // guessed fetch count (how many pages a session would have opened is unknown).
      expect(inAppAvoidedSessions).toBe(avoidedSessions);
      expect(inAppAvoidedFetches).toBe(0);

      // Reuse and isolation, measured on what actually reaches prose.
      let letterClaims = 0;
      let interviewClaims = 0;
      const leaks: string[] = [];
      const distinctVerified = new Set<string>();
      for (let index = 0; index < warm.roles.length; index += 1) {
        const role = warm.roles[index]!;
        const letter = proseEvidence(warm.deps, { attemptId: warm.attempts[index]!.id }, 'letter');
        const interview = proseEvidence(warm.deps, { attemptId: warm.attempts[index]!.id }, 'interview');
        letterClaims += letter.length;
        interviewClaims += interview.length;
        for (const fact of interview) {
          distinctVerified.add(`${role.group ? 'g' : 'e'}${role.employer}:${fact.claim}`);
          if (!fact.claim.startsWith(role.company)) leaks.push(`${role.role} <- ${fact.claim}`);
          if (role.group !== fact.claim.includes('Group')) leaks.push(`${role.role} crossed look-alike employers`);
        }
      }
      expect(leaks).toEqual([]);
      const supportedRows = store.listFactsForRecord(warm.db, store.findRecord(warm.db, 'ats:greenhouse:emp1')!.id);
      expect(supportedRows.length).toBeGreaterThan(0);

      // Expiry and failure: nothing renews itself.
      warm.advance(COMPANY_FACT_TTL_MS + DAY);
      let usableAfterExpiry = 0;
      warm.attempts.forEach((attempt) => (usableAfterExpiry += proseEvidence(warm.deps, { attemptId: attempt.id }, 'interview').length));
      expect(usableAfterExpiry).toBe(0);
      for (const key of warm.web.pages.keys()) warm.web.pages.set(key, new CrawlerHttpError({ category: 'timeout', code: 'request_timeout', url: key, detail: 'down' }));
      const downRequests = warm.web.calls.length;
      for (const attempt of warm.attempts.filter((_, i) => warm.roles[i]!.index === 1)) await refreshEvidence(warm.deps, { attemptId: attempt.id }, warm.runs);
      const failedRefreshRequests = warm.web.calls.length - downRequests;
      const failedRefreshFetchesByPage = warm.web.calls.slice(downRequests).reduce<Record<string, number>>((counts, url) => ({ ...counts, [url]: (counts[url] ?? 0) + 1 }), {});
      const factsStored = warm.db.select().from(schema.companyEvidenceFacts).all().length;
      let usableAfterFailedRefresh = 0;
      warm.attempts.forEach((attempt) => (usableAfterFailedRefresh += proseEvidence(warm.deps, { attemptId: attempt.id }, 'interview').length));
      expect(usableAfterFailedRefresh).toBe(0);
      for (const role of warm.roles) {
        const employer = EMPLOYERS.find((entry) => entry.n === role.employer)!;
        const lines = TOPICS.filter((topic) => !(employer.lead && topic === 'location' && !role.group)).map((topic) => sentence(role, topic));
        warm.web.page(pageFor(role), `${lines.join('. ')}. Plus unrelated text`);
      }
      let renewed = 0;
      for (const attempt of warm.attempts.filter((_, i) => warm.roles[i]!.index === 1)) {
        const result = await refreshEvidence(warm.deps, { attemptId: attempt.id }, warm.runs);
        if (result.ok) renewed += result.stats?.renewed ?? 0;
      }
      let usableAfterRefresh = 0;
      warm.attempts.forEach((attempt) => (usableAfterRefresh += proseEvidence(warm.deps, { attemptId: attempt.id }, 'interview').length));

      const adversarial = await adversarialMatrix();
      const scriptedToolEvents = (sessions: number) => ({ webSearch: sessions * 1, webFetch: sessions * 3 });
      const measurement = {
        issue: 689,
        kind: 'SYNTHETIC fixed-fixture measurement; pages, quotes and truth labels are the fixture author\'s, not human labels of real employers',
        method: [
          'The same 14 roles (5 verified employers with 12 roles, plus 2 look-alike names with their own domains) are carried through the real researchCompany action twice on fresh migrated SQLite databases.',
          'cold = the employer record is deleted after every role (every role pays for its own research); shared = the record is kept and a later role at the same verified employer is served from it.',
          'Counted: research sessions asked of the scripted provider, safe source fetches the app made, and the facts that reach the letter and interview lists. Wall-clock time is not measured.',
        ],
        fixture: { roles, employersWithSharedRoles: 5, lookAlikeNames: 2, topicsRequestedPerRole: [...TOPICS], employerWhoseLocationQuoteIsNotOnItsPage: 'Emp5 Corp' },
        counting: {
          appSourceFetches: "OBSERVED: requests in the FakeWeb call log (the AtsHttpClient seam the app's safe client implements); one entry per physical request the app made",
          scriptedSessionToolEvents: 'SCRIPTED, not observed: the WebSearch/WebFetch counts each scripted research session REPORTS (1 search, 3 fetches); no real tool ran',
          inAppStats: 'What the action itself reported (ActionStats), compared with the observed counts',
        },
        cold: { researchSessions: cold.sessions.count, appSourceFetches: coldFetches, scriptedSessionToolEvents: scriptedToolEvents(cold.sessions.count) },
        shared: { researchSessions: warm.sessions.count, appSourceFetches: warmFetches, scriptedSessionToolEvents: scriptedToolEvents(warm.sessions.count) },
        avoided: {
          observedResearchSessions: avoidedSessions,
          observedAppSourceFetches: avoidedFetches,
          inAppReportedAvoidedSessions: inAppAvoidedSessions,
          inAppReportedAvoidedFetches: inAppAvoidedFetches,
          inAppNote: 'A research cache hit reports avoidedFetches = 0 on purpose: the number of pages a session would have opened is unknown, so it is not guessed.',
          rolesServedFromTheRecord: perRole.filter((row) => row.sharedCacheHit === true).length,
          rolesThatStillNeededResearch: perRole.filter((row) => row.sharedCacheHit !== true).length,
        },
        verifiedClaimReuse: {
          distinctVerifiedClaimsAcrossRoles: distinctVerified.size,
          claimUsesInInterviewLists: interviewClaims,
          claimUsesInLetterLists: letterClaims,
          interviewUsesPerDistinctVerifiedClaim: Number((interviewClaims / distinctVerified.size).toFixed(2)),
          claimsThatCrossedToAnotherEmployerOrLookAlike: leaks.length,
        },
        expiryAndFailure: {
          usableClaimsAfterExpiryWithoutRefresh: usableAfterExpiry,
          factsStoredBeforeExpiry: factsStored,
          sourceFetchesInFailedRefreshPass: failedRefreshRequests,
          failedRefreshFetchesByPage,
          usableClaimsAfterFailedRefresh: usableAfterFailedRefresh,
          claimsRenewedByASuccessfulRefresh: renewed,
          usableClaimsAfterSuccessfulRefresh: usableAfterRefresh,
        },
        perRole,
        adversarial,
        limits: [
          'The "cold" baseline is constructed (the record is deleted after each role); the reuse rate follows from the fixture having 2-3 roles per employer. It shows the arithmetic of reuse, not a real-world saving.',
          'In the reuse fixture every claim equals its quote, so that part cannot test adequate support; the adversarial matrix does, with fixture-author labels (not human labels of real employers).',
          'The quote floor is lexical: it shows a claim repeats one whole sentence of a passage found on the page, with no nearby sentence on the same subject limiting it; it does not show that the page or the claim is true. True paraphrases and shortened sentences are kept as leads (counted below as a cost).',
          'The adversarial matrix (fix round 2: 35 cases) adds the review-2 shapes (dropped "but not"/"except"/"only", Dutch "maar niet", figure/date/subject borrowed from another sentence or organisation, name-only claims, page sentence continuing past a cut quote, a restriction in the next sentence, sponsorship synonyms) and positives. Its counts cover only these labelled cases.',
          'Role-scoped claims are never reused across roles by design, so a request for role-level facts always needs its own research; only company-level topics are counted as avoided here.',
          'An employer whose topics are not all verified (Emp5 Corp) is re-researched for every role: avoiding a call requires current, verified support for every requested topic.',
          'The sessions are scripted and instant; real research cost (time, provider usage), real source availability and real claim accuracy are not measured and no accuracy or quality gain is assumed.',
        ],
      };
      expect(measurement.expiryAndFailure.usableClaimsAfterFailedRefresh).toBe(0);
      expect(measurement.expiryAndFailure.claimsRenewedByASuccessfulRefresh).toBeGreaterThan(0);
      expect(usableAfterRefresh).toBeGreaterThan(0);
      const out = process.env.OVR_689_MEASUREMENT_PATH;
      if (out) writeFileSync(out, `${JSON.stringify(measurement, null, 2)}\n`);
    } finally {
      cold.close();
      warm.close();
    }
  }, 180_000);
});
