// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrawlerHttpError, type AtsHttpClient, type AtsHttpRequestOptions } from '@open-vacancy-radar/vacancy-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPANY_FACT_TTL_MS,
  assessQuoteSupport,
  deriveCompanyIdentity,
  domainLabelMatchesName,
  employerDomainOf,
  identityFromConfirmedDomain,
  mentionsSponsorship,
  sourceMatchesIdentity,
} from '../electron/company-evidence.js';
import {
  MAX_SOURCE_HTML_CHARS,
  buildCompanyResearchPrompt,
  confirmSourceQuote,
  htmlToText,
  type ResearchSessionOutcome,
} from '../electron/company-evidence-research.js';
import {
  CompanyEvidenceRuns,
  addFact,
  confirmDomain,
  correctFact,
  decideLink,
  getView,
  proseEvidence,
  refreshEvidence,
  researchCompany,
  resolveContradiction,
  type CompanyEvidenceDeps,
  type EvidenceTarget,
} from '../electron/company-evidence-service.js';
import { parseAtsTenant } from '../electron/workspace/application-identity.js';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import * as store from '../electron/workspace/company-evidence-store.js';
import * as schema from '../electron/workspace/schema.js';

/**
 * #689 fix round 1: the adversarial cases the first review found (P1-P12), against the REAL store
 * (migrated SQLite), service, research driver and policy. Only the public web is an in-memory page
 * map behind the `AtsHttpClient` seam, and the model session is a scripted outcome. Every employer,
 * page and claim is invented. None of these tests can say whether a claim is TRUE: they pin what the
 * app proves (a passage was found and the claim is worded from it) and what it refuses.
 */

const T0 = new Date('2026-10-01T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const NORTHWIND = 'https://job-boards.greenhouse.io/northwind/jobs/1001';
const ABOUT = 'https://northwind.example/about';
const DEPOTS = 'Northwind Freight operates 14 depots across the Netherlands and Belgium';

class FakeWeb {
  pages = new Map<string, string | Error>();
  calls: string[] = [];
  /** Called while a request is "in flight" (before the body is returned), to model a race. */
  during: ((url: string) => void | Promise<void>) | null = null;
  hang = false;
  inFlight = 0;
  maxInFlight = 0;
  client: AtsHttpClient = {
    get: async (url: string, options?: AtsHttpRequestOptions) => {
      this.calls.push(url);
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      try {
        if (this.hang) {
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        if (this.during) await this.during(url);
        const page = this.pages.get(url);
        if (page === undefined) throw new CrawlerHttpError({ category: 'http_error', code: 'http_status', url, detail: 'nf', status: 404 });
        if (page instanceof Error) throw page;
        return { status: 200, finalUrl: url, headers: {}, body: page };
      } finally {
        this.inFlight -= 1;
      }
    },
    postJson: async () => {
      throw new Error('unused');
    },
  };
  page(url: string, text: string): void {
    this.pages.set(url, `<html><body><p>${text}.</p></body></html>`);
  }
}

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let clock: Date;
let web: FakeWeb;
let runs: CompanyEvidenceRuns;
let deps: CompanyEvidenceDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-evidence-adv-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  clock = new Date(T0);
  web = new FakeWeb();
  runs = new CompanyEvidenceRuns();
  deps = { db, now: () => new Date(clock), getHttp: async () => web.client };
  web.page(ABOUT, `${DEPOTS}. We are an equal opportunity employer and value diversity`);
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function attempt(company: string, role: string, url: string, extra: { applicationId?: string } = {}) {
  return workspace.createApplicationAttempt(db, {
    company,
    role,
    canonicalUrl: url,
    sourceCvContentHash: 'h',
    jdSnapshot: 'Synthetic public job description.',
    jdSnapshotHash: 'j',
    force: true,
    ...extra,
  });
}
const t = (attemptId: string): EvidenceTarget => ({ attemptId });
const factByClaim = (target: EvidenceTarget, claim: string) => getView(deps, target).facts.find((fact) => fact.claim === claim);

/* ============================================================== R1: bounded, single-decode text ===== */

describe('page text extraction is linear and decodes each entity once', () => {
  it('keeps &amp;quot; as the literal text &quot; and never finds a quote it did not contain', async () => {
    expect(htmlToText('<p>&amp;quot;hello world friends&amp;quot;</p>')).toBe(' &quot;hello world friends&quot; ');
    expect(htmlToText('a&amp;lt;b &#65;&#x42; &copy; &bogus; & &;')).toBe('a&lt;b AB © &bogus; & &;');
    expect(htmlToText('x<script>var a = "<p>hidden</p>";</script>y<!-- c -->z<style>p{}</style>w')).toBe('x y z w');
    const page = `<p>&amp;quot;hello world friends and colleagues&amp;quot;</p>`;
    web.pages.set('https://lit.example/a', page);
    expect(await confirmSourceQuote(web.client, 'https://lit.example/a', '"hello world friends and colleagues"')).toMatchObject({ ok: false, reason: 'quote_not_found' });
    expect(await confirmSourceQuote(web.client, 'https://lit.example/a', '&quot;hello world friends and colleagues&quot;')).toMatchObject({ ok: true });
  });

  it('settles hostile markup promptly on the calling thread, and refuses an oversized page', async () => {
    const hostile: Record<string, string> = {
      lessThanRun: '<'.repeat(100_000),
      unclosedScripts: '<script '.repeat(50_000),
      ampersandRun: '&'.repeat(200_000),
      deepNesting: '<div>'.repeat(100_000) + 'needle text here for the check' + '</div>'.repeat(100_000),
      unclosedComment: `ok text <!-- ${'x'.repeat(200_000)}`,
      malformedEntities: '&#99999999;&#xFFFFFFF;&#0;&#xD800;'.repeat(20_000),
      tagRun: '<a<b<c<d '.repeat(40_000) + '>',
      bigButAllowed: 'word '.repeat(Math.floor((MAX_SOURCE_HTML_CHARS - 10) / 5)),
    };
    for (const [name, html] of Object.entries(hostile)) {
      const started = performance.now();
      htmlToText(html);
      const elapsed = performance.now() - started;
      expect(elapsed, name).toBeLessThan(1500);
    }
    expect(htmlToText(hostile.deepNesting!)).toContain('needle text here for the check');
    web.pages.set('https://big.example/p', 'a'.repeat(MAX_SOURCE_HTML_CHARS + 1));
    expect(await confirmSourceQuote(web.client, 'https://big.example/p', 'a quote long enough to be checked')).toEqual({ ok: false, reason: 'content_too_large' });
  });
});

/* ======================================================================= R2: the quote floor ===== */

describe('a found passage must actually say the claim (deterministic floor)', () => {
  const names = ['Northwind Freight'];
  it('accepts a claim worded from its passage, and states every refusal with a stable reason', () => {
    expect(assessQuoteSupport('Northwind Freight operates 14 depots across the Netherlands and Belgium.', DEPOTS, names)).toEqual({ ok: true });
    expect(assessQuoteSupport('Northwind Freight employs about 450 people.', 'We employ about 450 people.', names)).toEqual({ ok: true });
    // Unrelated boilerplate cannot carry a claim.
    expect(assessQuoteSupport('Northwind Freight employs 12,000 people worldwide.', 'We are an equal opportunity employer and value diversity', names)).toEqual({ ok: false, reason: 'claim_number_mismatch' });
    expect(assessQuoteSupport('Northwind Freight is a leader in green logistics.', 'We are an equal opportunity employer and value diversity', names)).toEqual({ ok: false, reason: 'claim_not_in_quote' });
    // 14 is not 140; 12,000 is 12.000.
    expect(assessQuoteSupport('Northwind Freight operates 140 depots.', DEPOTS, names)).toEqual({ ok: false, reason: 'claim_number_mismatch' });
    expect(assessQuoteSupport('Northwind Freight employs 12,000 people in total.', 'Northwind Freight employs 12.000 people in total', names)).toEqual({ ok: true });
    // Opposite negation, either way; Dutch too; and modality.
    expect(assessQuoteSupport('Northwind Freight sponsors work visas for this role.', 'Northwind Freight does not sponsor work visas for this role', names)).toEqual({ ok: false, reason: 'claim_negation_mismatch' });
    expect(assessQuoteSupport("Northwind Freight doesn't offer remote work.", 'Northwind Freight offers remote work to every engineer', names)).toEqual({ ok: false, reason: 'claim_negation_mismatch' });
    expect(assessQuoteSupport('Northwind Freight biedt visumsponsoring.', 'Northwind Freight biedt geen visumsponsoring voor deze rol', names)).toEqual({ ok: false, reason: 'claim_negation_mismatch' });
    expect(assessQuoteSupport('Northwind Freight opened an office in Ghent.', 'Northwind Freight will open an office in Ghent next year', names)).toMatchObject({ ok: false });
    // A different entity.
    expect(assessQuoteSupport('Contoso operates 14 depots across the Netherlands and Belgium.', DEPOTS, names)).toEqual({ ok: false, reason: 'claim_entity_mismatch' });
    expect(assessQuoteSupport('Northwind Freight employs 450 people.', 'At Contoso we employ 450 people', names)).toEqual({ ok: false, reason: 'claim_entity_mismatch' });
    // Reordered words (who acquired whom) are not near-verbatim.
    expect(assessQuoteSupport('Northwind Freight acquired Harbor Logistics.', 'Harbor Logistics acquired Northwind Freight in 2021', names)).toMatchObject({ ok: false });
    expect(assessQuoteSupport('Northwind Freight operates depots.', 'too short', names)).toEqual({ ok: false, reason: 'quote_missing' });
  });

  it('keeps an unrelated, contradictory or re-used-quote claim a lead in every path, and spends no request on it', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    // P3: boilerplate that IS on the page.
    const boiler = await addFact(deps, t(a.id), {
      claim: 'Northwind Freight employs 12,000 people worldwide.',
      sourceUrl: ABOUT,
      quote: 'We are an equal opportunity employer and value diversity',
      scope: 'company',
      topic: 'size',
    });
    expect(boiler).toMatchObject({ ok: true, stats: { requests: 0 } });
    expect(factByClaim(t(a.id), 'Northwind Freight employs 12,000 people worldwide.')).toMatchObject({
      support: 'lead',
      verification: 'unverified',
      lastRefreshReason: 'claim_number_mismatch',
    });
    // Old-quote reuse: the true passage about 14 depots cannot carry 140.
    await addFact(deps, t(a.id), { claim: 'Northwind Freight operates 140 depots.', sourceUrl: ABOUT, quote: DEPOTS, scope: 'company', topic: 'general' });
    expect(factByClaim(t(a.id), 'Northwind Freight operates 140 depots.')?.reasons).toContain('claim_number_mismatch');
    expect(web.calls).toEqual([]);
    expect(proseEvidence(deps, t(a.id), 'letter')).toEqual([]);
    expect(proseEvidence(deps, t(a.id), 'interview')).toEqual([]);

    // Even a row forced to "source_confirmed" is re-checked on every read and every prose use.
    const forced = factByClaim(t(a.id), 'Northwind Freight operates 140 depots.')!;
    db.update(schema.companyEvidenceFacts).set({ verification: 'source_confirmed', retrievedAt: T0 }).run();
    expect(getView(deps, t(a.id)).facts.find((fact) => fact.id === forced.id)).toMatchObject({ support: 'lead', reasons: ['claim_number_mismatch'] });
    expect(proseEvidence(deps, t(a.id), 'interview')).toEqual([]);

    // The near-verbatim claim on the same page is still usable.
    await addFact(deps, t(a.id), { claim: 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', sourceUrl: ABOUT, quote: DEPOTS, scope: 'company', topic: 'general' });
    expect(proseEvidence(deps, t(a.id), 'letter').map((fact) => fact.claim)).toEqual(['Northwind Freight operates 14 depots across the Netherlands and Belgium.']);
    expect(web.calls).toEqual([ABOUT]);
  });

  it('research: a model claim whose quote is boilerplate stays a lead and its page is not fetched for it', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const outcome: ResearchSessionOutcome = {
      status: 'completed',
      reason: 'completed',
      queries: ['northwind freight'],
      searches: 1,
      fetches: 1,
      candidates: [
        { claim: 'Northwind Freight employs 12,000 people worldwide.', topic: 'size', scope: 'company', sourceUrl: ABOUT, quote: 'We are an equal opportunity employer and value diversity' },
        { claim: 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', topic: 'general', scope: 'company', sourceUrl: ABOUT, quote: DEPOTS },
      ],
    };
    const result = await researchCompany({ ...deps, runResearch: async () => outcome }, t(a.id), { topics: ['size', 'general'] }, runs);
    expect(result).toMatchObject({ ok: true, stats: { candidates: 2, confirmed: 1, requests: 1 } });
    expect(web.calls).toEqual([ABOUT]);
    expect(factByClaim(t(a.id), 'Northwind Freight employs 12,000 people worldwide.')).toMatchObject({ support: 'lead', lastRefreshReason: 'claim_number_mismatch' });
  });
});

/* ===================================================================== R3: correction / freshness == */

describe('a correction cannot be renewed by the old passage', () => {
  async function confirmed(): Promise<{ target: EvidenceTarget; id: string; before: { expiresAt: string; retrievedAt: string | null } }> {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    await addFact(deps, t(a.id), { claim: `${DEPOTS}.`, sourceUrl: ABOUT, quote: DEPOTS, scope: 'company', topic: 'general' });
    const fact = getView(deps, t(a.id)).facts[0]!;
    expect(fact.support).toBe('supported');
    return { target: t(a.id), id: fact.id, before: { expiresAt: fact.expiresAt, retrievedAt: fact.retrievedAt } };
  }

  it('correct -> refresh stays a lead, fetches nothing, and keeps the original provenance, time and expiry (P2)', async () => {
    const { target, id, before } = await confirmed();
    clock = new Date(T0.getTime() + 100 * DAY); // also past expiry: refresh would try to renew
    expect((await correctFact(deps, target, id, 'Northwind Freight operates 140 depots on three continents.')).ok).toBe(true);
    const calls = web.calls.length;
    const refreshed = await refreshEvidence(deps, target, runs);
    expect(refreshed).toMatchObject({ ok: true, stats: { requests: 0, renewed: 0 } });
    expect(web.calls.length).toBe(calls);
    const fact = getView(deps, target).facts[0]!;
    expect(fact).toMatchObject({
      claim: 'Northwind Freight operates 140 depots on three continents.',
      quote: '',
      verification: 'unverified',
      support: 'lead',
      expiresAt: before.expiresAt,
      retrievedAt: before.retrievedAt,
      correction: { originalClaim: `${DEPOTS}.`, originalQuote: DEPOTS },
    });
    expect(fact.reasons).toEqual(expect.arrayContaining(['unverified', 'quote_missing']));
    expect(proseEvidence(deps, target, 'interview')).toEqual([]);
  });

  it('a new passage is checked like an add: non-supporting stays a lead, a matching one found on the page renews', async () => {
    const { target, id } = await confirmed();
    expect(await correctFact(deps, target, id, 'Northwind Freight operates 140 depots.', DEPOTS)).toMatchObject({ ok: true, stats: { requests: 0 } });
    expect(getView(deps, target).facts[0]).toMatchObject({ support: 'lead', reasons: expect.arrayContaining(['claim_number_mismatch']) });

    web.page('https://northwind.example/news', 'Northwind Freight now operates 15 depots in the Benelux');
    const fixed = await correctFact(deps, target, id, 'Northwind Freight now operates 15 depots in the Benelux.', 'Northwind Freight now operates 15 depots in the Benelux');
    // The passage must be on the fact's OWN source page: this one is not, so it stays a lead.
    expect(fixed).toMatchObject({ ok: true, stats: { requests: 1 } });
    expect(getView(deps, target).facts[0]).toMatchObject({ support: 'lead', lastRefreshReason: 'quote_not_found' });

    web.page(ABOUT, 'Northwind Freight now operates 15 depots in the Benelux');
    await correctFact(deps, target, id, 'Northwind Freight now operates 15 depots in the Benelux.', 'Northwind Freight now operates 15 depots in the Benelux');
    expect(getView(deps, target).facts[0]).toMatchObject({ verification: 'source_confirmed', support: 'supported' });
  });

  it('a correction that lands while a refresh is fetching the old passage is never renewed', async () => {
    const { target, id, before } = await confirmed();
    clock = new Date(T0.getTime() + 100 * DAY);
    web.during = async () => {
      web.during = null;
      await correctFact(deps, target, id, 'Northwind Freight operates 99 depots.');
    };
    const refreshed = await refreshEvidence(deps, target, runs);
    expect(refreshed).toMatchObject({ ok: true, stats: { requests: 1, renewed: 0 } });
    expect(getView(deps, target).facts[0]).toMatchObject({ claim: 'Northwind Freight operates 99 depots.', support: 'lead', expiresAt: before.expiresAt });
  });

  it('a failed or cancelled refresh never renews', async () => {
    const { target, before } = await confirmed();
    clock = new Date(T0.getTime() + 100 * DAY);
    web.pages.set(ABOUT, new CrawlerHttpError({ category: 'timeout', code: 'request_timeout', url: ABOUT, detail: 'down' }));
    await refreshEvidence(deps, target, runs);
    expect(getView(deps, target).facts[0]).toMatchObject({ support: 'lead', expiresAt: before.expiresAt, retrievedAt: before.retrievedAt });
    web.page(ABOUT, DEPOTS);
    web.during = () => {
      runs.cancelAll();
    };
    await refreshEvidence(deps, target, runs);
    expect(getView(deps, target).facts[0]).toMatchObject({ support: 'lead', expiresAt: before.expiresAt });
  });
});

/* ======================================================================== R4: exact identity ===== */

describe('identity is exact: ATS tenants, registrable domains, and per-vacancy confirmation', () => {
  it('only the exact ATS tenant is the employer source (P1)', () => {
    const identity = deriveCompanyIdentity({ company: 'Northwind Freight', canonicalUrl: NORTHWIND, employerKey: 'greenhouse:northwind' });
    expect(identity).toMatchObject({ verifiedKey: 'ats:greenhouse:northwind', keyKind: 'ats_tenant', host: null, tenant: { provider: 'greenhouse', board: 'northwind' } });
    const official = (url: string) => sourceMatchesIdentity(url, identity);
    expect(official('https://job-boards.greenhouse.io/northwind/jobs/77')).toBe(true);
    expect(official('https://boards.greenhouse.io/northwind')).toBe(true);
    expect(official('https://boards.greenhouse.io/embed/job_app?for=northwind&token=1')).toBe(true);
    for (const spoof of [
      'https://greenhouse.evil-lookalike.example/northwind/jobs/1',
      'https://evilgreenhouse.io/northwind/x',
      'https://greenhouse.io.evil.example/northwind/jobs/1',
      'https://unrelated.example/northwind/jobs/1',
      'https://user:pw@job-boards.greenhouse.io/northwind/jobs/1',
      'https://job-boards.greenhouse.io:8443/northwind/jobs/1',
      'https://job-boards.greenhouse.io./northwind/jobs/1',
      'https://job-boards.greenhоuse.io/northwind/jobs/1', // Cyrillic "о" (IDN look-alike)
      'http://job-boards.greenhouse.io/northwind/jobs/1',
      'https://job-boards.greenhouse.io/other-board/jobs/1',
      'https://jobs.lever.co/northwind/1',
    ]) {
      expect(official(spoof), spoof).toBe(false);
    }
    // The attempt's own key and the URL must agree, or nothing is verified.
    expect(deriveCompanyIdentity({ company: 'Northwind Freight', canonicalUrl: NORTHWIND, employerKey: 'greenhouse:someone-else' }).verifiedKey).toBeNull();
    expect(parseAtsTenant('https://acme.recruitee.com/o/role')).toEqual({ provider: 'recruitee', board: 'acme' });
    expect(parseAtsTenant('https://acme.recruitee.com.evil.example/o/role')).toBeNull();
  });

  it('a spoofed ATS host cannot make a sponsorship claim official or supported', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const spoof = 'https://greenhouse.evil-lookalike.example/northwind/jobs/1';
    const quote = 'Visa sponsorship is available for this role at all offices';
    web.page(spoof, quote);
    await addFact(deps, t(a.id), { claim: 'Visa sponsorship is available for this role at all offices.', sourceUrl: spoof, quote, scope: 'role', topic: 'sponsorship' });
    const fact = getView(deps, t(a.id)).facts[0]!;
    expect(fact).toMatchObject({ official: false, sourceKind: 'public_web', support: 'lead', reasons: expect.arrayContaining(['sponsorship_needs_role_source']) });
    expect(proseEvidence(deps, t(a.id), 'letter')).toEqual([]);
  });

  it('a posting host counts only when its label IS the company name; near misses are suggestions (P11)', () => {
    const derive = (company: string, url: string) => deriveCompanyIdentity({ company, canonicalUrl: url, employerKey: company.toLowerCase() });
    expect(derive('Apex', 'https://careers.apexlegends.example/jobs/1').verifiedKey).toBeNull();
    expect(derive('Nova', 'https://novatech-staffing.example/jobs/1').verifiedKey).toBeNull();
    expect(derive('Acme', 'https://acme-recruiting-scam.example/jobs/1').verifiedKey).toBeNull();
    expect(derive('Northwind Freight', 'https://careers.northwind.example/jobs/1').verifiedKey).toBeNull(); // prefix only
    expect(derive('Northwind Freight', 'https://careers.northwind-freight.example/jobs/1')).toMatchObject({ verifiedKey: 'host:northwind-freight.example', host: 'northwind-freight.example' });
    expect(derive('Northwind Freight B.V.', 'https://werkenbij.northwindfreight.co.uk/vacature/1')).toMatchObject({ verifiedKey: 'host:northwindfreight.co.uk' });
    expect(derive('Northwind', 'https://northwind.github.io/jobs')).toMatchObject({ verifiedKey: null });
    expect(domainLabelMatchesName('apexlegends', 'Apex')).toBe(false);
    expect(domainLabelMatchesName('apex', 'Apex Inc')).toBe(true);
  });

  it('public suffixes and shared hosting are never an employer domain, and their tenants are never official (P8)', () => {
    for (const domain of ['co.uk', 'github.io', 'evil-user.github.io', 'blogspot.com', 'northwind.blogspot.com', 'herokuapp.com', 'northwind.herokuapp.com', 'vercel.app', 'northwind.vercel.app', '192.168.1.10']) {
      expect(identityFromConfirmedDomain('Northwind', domain), domain).toBeNull();
      expect(employerDomainOf(domain).ok, domain).toBe(false);
    }
    expect(employerDomainOf('greenhouse.io')).toEqual({ ok: false, reason: 'job_board_domain' });
    const uk = identityFromConfirmedDomain('Northwind', 'https://careers.northwind.co.uk/')!;
    expect(uk).toMatchObject({ verifiedKey: 'domain:northwind.co.uk', host: 'northwind.co.uk' });
    expect(sourceMatchesIdentity('https://www.northwind.co.uk/about', uk)).toBe(true);
    expect(sourceMatchesIdentity('https://other.co.uk/about', uk)).toBe(false);
    // Even a forged identity on a shared suffix cannot make its tenants official.
    expect(sourceMatchesIdentity('https://evil-user.github.io/x', { verifiedKey: 'domain:github.io', host: 'github.io' })).toBe(false);
  });

  it('refuses a shared or public domain with a stable code when the person confirms one', () => {
    const a = attempt('Northwind', 'Engineer', 'https://www.linkedin.com/jobs/view/1');
    expect(confirmDomain(deps, t(a.id), { domain: 'github.io' })).toMatchObject({ ok: false, code: 'shared_or_public_domain' });
    expect(confirmDomain(deps, t(a.id), { domain: 'northwind.github.io' })).toMatchObject({ ok: false, code: 'shared_or_public_domain' });
    expect(confirmDomain(deps, t(a.id), { domain: 'co.uk' })).toMatchObject({ ok: false, code: 'shared_or_public_domain' });
    expect(db.select().from(schema.companyEvidenceRecords).all()).toEqual([]);
  });

  it('a domain confirmed for one name-only vacancy is a suggestion, not an identity, for another with the same name (P9)', async () => {
    const first = attempt('Apex', 'Engineer', 'https://www.jobgether.com/offer/abc');
    expect(confirmDomain(deps, t(first.id), { domain: 'apex-logistics.example' }).ok).toBe(true);
    const quote = 'Apex operates cold storage warehouses in Rotterdam';
    web.page('https://apex-logistics.example/about', quote);
    await addFact(deps, t(first.id), { claim: 'Apex operates cold storage warehouses in Rotterdam.', sourceUrl: 'https://apex-logistics.example/about', quote, scope: 'company', topic: 'general' });
    expect(proseEvidence(deps, t(first.id), 'letter')).toHaveLength(1);

    const second = attempt('APEX', 'Designer', 'https://www.linkedin.com/jobs/view/999');
    const view = getView(deps, t(second.id));
    expect(view).toMatchObject({ state: 'no_identity', recordId: null, supportedCount: 0, facts: [] });
    expect(view.suggestions).toEqual([{ domain: 'apex-logistics.example', basis: 'same_name_elsewhere' }]);
    expect(proseEvidence(deps, t(second.id), 'letter')).toEqual([]);

    // Only an explicit confirmation FOR this vacancy joins it to the record.
    expect(confirmDomain(deps, t(second.id), { domain: 'apex-logistics.example' }).ok).toBe(true);
    expect(getView(deps, t(second.id))).toMatchObject({ state: 'ready', supportedCount: 1 });
  });

  it('a confirmation made for an application covers its attempts, and offers the posting domain as a suggestion', () => {
    const application = workspace.createApplication(db, { role: 'Engineer', company: 'Harbor Systems', location: '', status: 'applied', notes: '' });
    const a = attempt('Harbor Systems', 'Engineer', 'https://jobs.harbor-careers.example/role/1', { applicationId: application.id });
    expect(getView(deps, t(a.id)).suggestions).toEqual([{ domain: 'harbor-careers.example', basis: 'posting_domain' }]);
    expect(confirmDomain(deps, { applicationId: application.id }, { domain: 'harbor-systems.example', entityRef: 'KvK 12345678' }).ok).toBe(true);
    expect(getView(deps, t(a.id))).toMatchObject({ state: 'ready', entityRef: 'kvk 12345678', identity: { verifiedKey: 'domain:harbor-systems.example' } });
  });
});

/* ===================================================================== R5: sponsorship by content == */

describe('sponsorship is decided by what the claim and quote say, not by the topic label', () => {
  it('recognises English and Dutch wording', () => {
    for (const text of ['We sponsor work visas', 'Work permit support available', 'Wij zijn erkend referent bij de IND', 'Kennismigrantenregeling van toepassing', 'Highly skilled migrant visa', 'Blauwe kaart mogelijk', 'tewerkstellingsvergunning']) {
      expect(mentionsSponsorship(text), text).toBe(true);
    }
    expect(mentionsSponsorship('We operate 14 depots')).toBe(false);
  });

  it('a mislabelled "general" sponsorship claim from a random page is never support (P4), in addFact and research', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const blog = 'https://random-blog.example/post';
    web.page(blog, 'Northwind Freight sponsors work visas for this role');
    await addFact(deps, t(a.id), { claim: 'Northwind Freight sponsors work visas for this role.', sourceUrl: blog, quote: 'Northwind Freight sponsors work visas for this role', scope: 'role', topic: 'general' });
    const fact = getView(deps, t(a.id)).facts[0]!;
    expect(fact).toMatchObject({ topic: 'sponsorship', support: 'lead', reasons: ['sponsorship_needs_role_source'] });
    expect(db.select().from(schema.companyEvidenceFacts).all()[0]!.topic).toBe('sponsorship');

    const dutch = 'https://nieuws.example/northwind';
    web.page(dutch, 'Northwind Freight is erkend referent en neemt kennismigranten aan');
    await researchCompany(
      {
        ...deps,
        runResearch: async () => ({
          status: 'completed',
          reason: 'completed',
          queries: [],
          searches: 1,
          fetches: 1,
          candidates: [{ claim: 'Northwind Freight is erkend referent en neemt kennismigranten aan.', topic: 'general', scope: 'company', sourceUrl: dutch, quote: 'Northwind Freight is erkend referent en neemt kennismigranten aan' }],
        }),
      },
      t(a.id),
      { topics: ['general'] },
      runs,
    );
    expect(getView(deps, t(a.id)).facts.find((row) => row.sourceUrl === dutch)).toMatchObject({ topic: 'sponsorship', support: 'lead', reasons: ['sponsorship_needs_role_source'] });
    expect(proseEvidence(deps, t(a.id), 'interview')).toEqual([]);
  });

  it('the employer\'s own posting for THIS role, worded from its passage, still supports a sponsorship claim', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    web.page(NORTHWIND, 'Platform Engineer. Visa sponsorship is available for this role');
    await addFact(deps, t(a.id), { claim: 'Visa sponsorship is available for this role.', sourceUrl: NORTHWIND, quote: 'Visa sponsorship is available for this role', scope: 'role', topic: 'general' });
    expect(getView(deps, t(a.id)).facts[0]).toMatchObject({ topic: 'sponsorship', official: true, support: 'supported' });
  });
});

/* ================================================================= R7: linked contradictions ====== */

describe('contradictions across a confirmed identity link', () => {
  async function linkedPair() {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const b = attempt('Northwind Freight Group', 'Planner', 'https://careers.northwind-freight-group.example/jobs/9');
    web.page('https://northwind.example/a', 'Northwind Freight employs about 450 people');
    web.page('https://northwind-freight-group.example/b', 'Northwind Freight Group employs about 9000 people');
    await addFact(deps, t(a.id), { claim: 'Northwind Freight employs about 450 people.', sourceUrl: 'https://northwind.example/a', quote: 'Northwind Freight employs about 450 people', scope: 'company', topic: 'size' });
    await addFact(deps, t(b.id), { claim: 'Northwind Freight Group employs about 9000 people.', sourceUrl: 'https://northwind-freight-group.example/b', quote: 'Northwind Freight Group employs about 9000 people', scope: 'company', topic: 'size' });
    // A role fact on B never takes part.
    web.page('https://careers.northwind-freight-group.example/jobs/9', 'The Planner role is based in Rotterdam');
    await addFact(deps, t(b.id), { claim: 'The Planner role is based in Rotterdam.', sourceUrl: 'https://careers.northwind-freight-group.example/jobs/9', quote: 'The Planner role is based in Rotterdam', scope: 'role', topic: 'location' });
    const link = getView(deps, t(a.id)).links[0]!;
    return { a, b, link };
  }
  const claims = (target: EvidenceTarget) => proseEvidence(deps, target, 'letter').map((fact) => fact.claim);

  it('blocks both sides on confirm, shows the conflict in both records, and resolves explicitly (P6: 450 vs 9000)', async () => {
    const { a, b, link } = await linkedPair();
    expect(claims(t(a.id))).toEqual(['Northwind Freight employs about 450 people.']);
    expect(decideLink(deps, t(a.id), link.id, 'confirmed').ok).toBe(true);
    for (const target of [t(a.id), t(b.id)]) {
      const view = getView(deps, target);
      expect(view.contradictions).toHaveLength(1);
      expect(view.facts.filter((fact) => fact.topic === 'size').every((fact) => fact.support === 'lead' && fact.reasons.includes('contradicted'))).toBe(true);
    }
    expect(claims(t(a.id))).toEqual([]);
    expect(claims(t(b.id))).toEqual(['The Planner role is based in Rotterdam.']);

    const contradiction = getView(deps, t(a.id)).contradictions[0]!;
    const keep = factByClaim(t(a.id), 'Northwind Freight employs about 450 people.')!.id;
    expect(resolveContradiction(deps, t(a.id), contradiction.id, keep).ok).toBe(true);
    expect(claims(t(a.id))).toEqual(['Northwind Freight employs about 450 people.']);
    expect(getView(deps, t(b.id)).facts.find((fact) => fact.claim.includes('9000'))).toMatchObject({ status: 'superseded', support: 'lead' });
  });

  it('revoking the link restores each record on its own; relinking asks again; never transitive', async () => {
    const { a, b, link } = await linkedPair();
    decideLink(deps, t(a.id), link.id, 'confirmed');
    const contradiction = getView(deps, t(a.id)).contradictions[0]!;
    resolveContradiction(deps, t(a.id), contradiction.id, factByClaim(t(a.id), 'Northwind Freight employs about 450 people.')!.id);
    expect(decideLink(deps, t(a.id), link.id, 'rejected').ok).toBe(true);
    expect(claims(t(a.id))).toEqual(['Northwind Freight employs about 450 people.']);
    expect(claims(t(b.id))).toEqual(expect.arrayContaining(['Northwind Freight Group employs about 9000 people.', 'The Planner role is based in Rotterdam.']));
    expect(getView(deps, t(a.id)).contradictions).toEqual([]);

    decideLink(deps, t(a.id), link.id, 'confirmed');
    expect(getView(deps, t(a.id)).contradictions).toHaveLength(1);
    expect(claims(t(a.id))).toEqual([]);

    // C is linked to B only: nothing of C reaches A.
    const c = attempt('Northwind Freight Group Holding', 'Analyst', 'https://careers.northwind-freight-group-holding.example/j/1');
    web.page('https://northwind-freight-group-holding.example/x', 'Northwind Freight Group Holding has its head office in Utrecht');
    await addFact(deps, t(c.id), { claim: 'Northwind Freight Group Holding has its head office in Utrecht.', sourceUrl: 'https://northwind-freight-group-holding.example/x', quote: 'Northwind Freight Group Holding has its head office in Utrecht', scope: 'company', topic: 'general' });
    const bc = getView(deps, t(c.id)).links.find((row) => row.otherName === 'Northwind Freight Group')!;
    decideLink(deps, t(c.id), bc.id, 'confirmed');
    expect(getView(deps, t(a.id)).facts.some((fact) => fact.claim.includes('Utrecht'))).toBe(false);
  });

  it('a new conflicting fact on either side of a confirmed link is detected at insert', async () => {
    const { a, b, link } = await linkedPair();
    store.decideLink(db, link.id, 'rejected', T0);
    // Remove B's size claim so the link starts clean, then confirm, then B adds a conflicting one.
    db.delete(schema.companyEvidenceFacts).run();
    decideLink(deps, t(a.id), link.id, 'confirmed');
    web.page('https://northwind.example/a', 'Northwind Freight employs about 450 people');
    await addFact(deps, t(a.id), { claim: 'Northwind Freight employs about 450 people.', sourceUrl: 'https://northwind.example/a', quote: 'Northwind Freight employs about 450 people', scope: 'company', topic: 'size' });
    expect(claims(t(a.id))).toEqual(['Northwind Freight employs about 450 people.']);
    await addFact(deps, t(b.id), { claim: 'Northwind Freight Group employs about 9000 people.', sourceUrl: 'https://northwind-freight-group.example/b', quote: 'Northwind Freight Group employs about 9000 people', scope: 'company', topic: 'size' });
    expect(claims(t(a.id))).toEqual([]);
    expect(getView(deps, t(a.id)).contradictions).toHaveLength(1);
  });
});

/* ========================================================== R8: research context per identity ===== */

describe('the research prompt names exactly what is verified', () => {
  const base = { companyName: 'Northwind Freight', roleTitle: 'Platform Engineer', topics: ['general'] as const };
  it('ATS tenant: the board and posting, website unknown; website kinds: the verified website (P12)', () => {
    const ats = buildCompanyResearchPrompt({ ...base, website: '', jobBoard: { provider: 'greenhouse', board: 'northwind', postingUrl: 'https://job-boards.greenhouse.io/northwind/jobs/1001' } });
    expect(ats).toContain('Verified job-board account: greenhouse board "northwind" (the posting: https://job-boards.greenhouse.io/northwind/jobs/1001)');
    expect(ats).toContain('Employer website: UNKNOWN.');
    expect(ats).toContain("it is NOT this employer's website");
    expect(ats).not.toMatch(/Verified (employer )?website:/);
    expect(ats).not.toContain('Prefer pages on job-boards.greenhouse.io');

    const site = buildCompanyResearchPrompt({ ...base, website: 'northwind-freight.example', jobBoard: null });
    expect(site).toContain('Verified employer website: northwind-freight.example');
    expect(site).toContain('Prefer pages on northwind-freight.example');
  });

  it('research from an ATS identity passes the posting without its query string, and nothing private', async () => {
    const application = workspace.createApplication(db, { role: 'Platform Engineer', company: 'Northwind Freight', location: '', status: 'applied', notes: 'NOTE-SENTINEL-1' });
    const a = attempt('Northwind Freight', 'Platform Engineer', `${NORTHWIND}?gh_src=CV-SENTINEL-2&utm_source=x`, { applicationId: application.id });
    const seen: unknown[] = [];
    await researchCompany(
      { ...deps, runResearch: async (input) => (seen.push(input), { status: 'failed', reason: 'session_failed', candidates: [], queries: [], searches: 0, fetches: 0 }) },
      t(a.id),
      { topics: ['general'] },
      runs,
    );
    expect(seen).toEqual([
      {
        companyName: 'Northwind Freight',
        website: '',
        jobBoard: { provider: 'greenhouse', board: 'northwind', postingUrl: NORTHWIND },
        roleTitle: 'Platform Engineer',
        topics: ['general'],
      },
    ]);
    expect(JSON.stringify(seen)).not.toContain('SENTINEL');
    const posting = attempt('Northwind Freight', 'Data Engineer', 'https://careers.northwind-freight.example/jobs/2');
    seen.length = 0;
    await researchCompany(
      { ...deps, runResearch: async (input) => (seen.push(input), { status: 'failed', reason: 'session_failed', candidates: [], queries: [], searches: 0, fetches: 0 }) },
      t(posting.id),
      { topics: ['general'] },
      runs,
    );
    expect(seen[0]).toMatchObject({ website: 'northwind-freight.example', jobBoard: null });
  });
});

/* ======================================================================== R9: bounded P3 ========== */

describe('cache scope, observed stats, admission bound and time envelope', () => {
  it('a role fact never satisfies a company topic, and a cache hit does not guess avoided fetches', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    web.page(NORTHWIND, 'The Platform Engineer builds the routing platform');
    await addFact(deps, t(a.id), { claim: 'The Platform Engineer builds the routing platform.', sourceUrl: NORTHWIND, quote: 'The Platform Engineer builds the routing platform', scope: 'role', topic: 'general' });
    const runner = vi.fn(async (): Promise<ResearchSessionOutcome> => ({ status: 'failed', reason: 'session_failed', candidates: [], queries: [], searches: 0, fetches: 0 }));
    await researchCompany({ ...deps, runResearch: runner }, t(a.id), { topics: ['general'] }, runs);
    expect(runner).toHaveBeenCalledTimes(1);

    await addFact(deps, t(a.id), { claim: 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', sourceUrl: ABOUT, quote: DEPOTS, scope: 'company', topic: 'general' });
    const hit = await researchCompany({ ...deps, runResearch: runner }, t(a.id), { topics: ['general'] }, runs);
    expect(hit).toMatchObject({ ok: true, stats: { cacheHit: true, avoidedSessions: 1, avoidedFetches: 0, sessions: 0, requests: 0 } });
    expect(runner).toHaveBeenCalledTimes(1);

    // A refresh counts only what it actually did not fetch: the two current, checkable facts.
    const calls = web.calls.length;
    const refreshed = await refreshEvidence(deps, t(a.id), runs);
    expect(refreshed).toMatchObject({ ok: true, stats: { requests: 0, avoidedFetches: 2, cacheHit: true } });
    expect(web.calls.length).toBe(calls);
  });

  it('admits at most 80 active facts per record with a stable code, without pruning current ones', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    await addFact(deps, t(a.id), { claim: 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', sourceUrl: ABOUT, quote: DEPOTS, scope: 'company', topic: 'general' });
    const recordId = getView(deps, t(a.id)).recordId!;
    const outcomes: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const inserted = store.insertFact(
        db,
        {
          recordId,
          scope: 'company',
          roleKey: '',
          roleLabel: '',
          topic: 'other',
          claim: `Northwind Freight current fact number ${index}.`,
          sourceUrl: `https://facts.example/${index}`,
          sourceKind: 'public_web',
          quote: `Northwind Freight current fact number ${index}`,
          verification: 'source_confirmed',
          origin: 'research',
          retrievedAt: T0,
          observedAt: T0,
          contentHash: null,
        },
        T0,
      );
      outcomes.push(inserted === null ? 'gone' : 'refused' in inserted ? inserted.refused : 'stored');
    }
    const rows = db.select().from(schema.companyEvidenceFacts).all();
    expect(rows.filter((row) => row.status === 'active')).toHaveLength(store.MAX_FACTS_PER_RECORD);
    expect(outcomes.filter((outcome) => outcome === 'stored')).toHaveLength(store.MAX_FACTS_PER_RECORD - 1);
    expect(outcomes.filter((outcome) => outcome === 'record_full')).toHaveLength(100 - (store.MAX_FACTS_PER_RECORD - 1));
    expect(rows.some((row) => row.claim.startsWith('Northwind Freight operates 14 depots'))).toBe(true);
    expect(await addFact(deps, t(a.id), { claim: 'One more claim about Northwind.', sourceUrl: ABOUT, quote: '', scope: 'company', topic: 'other' })).toMatchObject({ ok: false, code: 'record_full' });
    const research = await researchCompany(
      {
        ...deps,
        runResearch: async () => ({ status: 'completed', reason: 'completed', queries: [], searches: 1, fetches: 1, candidates: [{ claim: 'Northwind Freight operates 14 depots.', topic: 'size', scope: 'company', sourceUrl: 'https://x.example/1', quote: 'Northwind Freight operates 14 depots in total' }] }),
      },
      t(a.id),
      { topics: ['size'] },
      runs,
    );
    expect(research.ok && getView(deps, t(a.id)).research).toMatchObject({ reason: 'record_full' });
  });

  it('page checks share one deadline and run a few at a time, so research cannot run 6 x 20 s', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    web.hang = true;
    const candidates = Array.from({ length: 6 }, (_, index) => ({
      claim: `Northwind Freight runs depot number ${index}.`,
      topic: 'general' as const,
      scope: 'company' as const,
      sourceUrl: `https://slow.example/${index}`,
      quote: `Northwind Freight runs depot number ${index}`,
    }));
    const started = Date.now();
    const result = await researchCompany(
      { ...deps, deadlines: { confirmPhaseMs: 300 }, runResearch: async () => ({ status: 'completed', reason: 'completed', queries: [], searches: 1, fetches: 6, candidates }) },
      t(a.id),
      { topics: ['general'] },
      runs,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(web.maxInFlight).toBeLessThanOrEqual(3);
    expect(result).toMatchObject({ ok: true, stats: { candidates: 6, confirmed: 0 } });
    expect(getView(deps, t(a.id)).facts.every((fact) => fact.support === 'lead')).toBe(true);
    expect(getView(deps, t(a.id)).facts.map((fact) => fact.lastRefreshReason)).toEqual(Array(6).fill('timeout'));
    // Same envelope for "check sources again".
    clock = new Date(T0.getTime() + COMPANY_FACT_TTL_MS + DAY);
    const refreshStarted = Date.now();
    await refreshEvidence({ ...deps, deadlines: { refreshEnvelopeMs: 300 } }, t(a.id), runs);
    expect(Date.now() - refreshStarted).toBeLessThan(5_000);
  });
});

/* ========================================== fix round 2: the floor is a WHOLE-statement check ===== */

/**
 * #689 review 2 (P1): the round-1 floor matched the claim's words as an ordered subsequence ANYWHERE
 * in the passage and checked negation/qualifiers only inside the matched span, so a claim could drop
 * a trailing "but not for this one" or borrow a number from a competitor's sentence. Every shape the
 * reviewer reproduced (G1-G9, F1-F3, F6, F7, F12, F15, F17 in review-689-2-probe) is pinned here,
 * with the reason the person is shown. These pin WORDING only; none says a statement is true.
 */
describe('fix round 2: a claim must repeat one whole statement of its passage', () => {
  const names = ['Northwind Freight'];
  const floor = (claim: string, quote: string, options = {}) => assessQuoteSupport(claim, quote, names, options);

  it('refuses every reviewer shape (dropped restriction, borrowed words, name-only), with a stable reason', () => {
    const refused: Array<[string, string, string, string]> = [
      ['G1 trailing "only" + place', 'Northwind Freight sponsors work visas for this role', 'Northwind Freight sponsors work visas for this role in Germany only for senior hires', 'claim_negation_mismatch'],
      ['G2 trailing "but not"', 'Northwind Freight offers visa sponsorship', 'Northwind Freight offers visa sponsorship for some roles, but not for this one', 'claim_negation_mismatch'],
      ['G3 trailing "except"', 'Northwind Freight offers remote work', 'Northwind Freight offers remote work for every team except engineering', 'claim_negation_mismatch'],
      ['G4 name only', 'Northwind Freight', 'Northwind Freight is a logistics firm operating in Europe today.', 'claim_too_vague'],
      ['G5 name + region', 'Northwind Freight Europe', 'Northwind Freight is a logistics firm operating in Europe today.', 'claim_too_vague'],
      ['G6 Dutch "maar niet"', 'Northwind Freight biedt visumsponsoring aan', 'Northwind Freight biedt visumsponsoring aan, maar niet voor deze rol', 'claim_negation_mismatch'],
      ['G7 borrowed across sentences', 'Northwind Freight employs 12,000 people', 'Northwind Freight is small. Acme employs 12,000 people.', 'claim_entity_mismatch'],
      ['G8 dropped places', 'Northwind Freight operates 14 depots', 'Northwind Freight operates 14 depots across the Netherlands and Belgium', 'claim_entity_mismatch'],
      ['G9 competitor subject, own name inside', 'Northwind Freight employs 12,000 people', 'Acme, a competitor of Northwind Freight, employs 12,000 people', 'claim_entity_mismatch'],
      ['F1 competitor in the next sentence', 'Northwind Freight employs 12,000 people', 'Northwind Freight is a logistics firm. Our competitor Acme Haulage employs 12,000 people worldwide.', 'claim_entity_mismatch'],
      ['F2 partner attribution', 'Northwind Freight employs 12,000 people', 'Northwind Freight partners with Acme Haulage, which employs 12,000 people across Europe.', 'claim_entity_mismatch'],
      ['F3 date of another event', 'Northwind Freight was founded in 2019', 'Northwind Freight was founded in 1998 and acquired by Contoso Holdings in 2019 for growth.', 'claim_entity_mismatch'],
      ['F6 "to nobody"', 'Northwind Freight offers remote work', 'We never allow remote roles at all anywhere in the company. Northwind Freight offers remote work to nobody in practice, sadly.', 'claim_negation_mismatch'],
      ['F7 "only on request"', 'Northwind Freight sponsors visas', 'Northwind Freight sponsors visas for interns only on request in 2019.', 'claim_negation_mismatch'],
      ['F8 repeated word', 'employs employs employs', 'employs employs employs employs employs employs', 'claim_too_vague'],
      ['F12 conditional', 'Northwind Freight has 400 employees', 'If Northwind Freight had 400 employees we would be larger than we are now, honestly.', 'claim_negation_mismatch'],
      ['F15 number of another clause', 'Northwind Freight operates 14 depots', 'Northwind Freight operates 140 depots; also 14 trucks per depot.', 'claim_not_whole_sentence'],
      ['F17 competitor sentence', 'Northwind Freight is the market leader', 'Northwind Freight is a small carrier. Acme is the market leader in the region by revenue.', 'claim_not_whole_sentence'],
      ['F18 subject swap', 'Northwind Freight acquired Contoso', 'Contoso acquired Northwind Freight last year in a surprise deal of 2019.', 'claim_entity_mismatch'],
      ['only senior hires', 'Northwind Freight sponsors work visas', 'Northwind Freight sponsors work visas only for senior hires.', 'claim_negation_mismatch'],
      ['only Germany', 'Northwind Freight offers relocation support', 'Northwind Freight offers relocation support only in Germany.', 'claim_negation_mismatch'],
      ['next sentence restricts it', 'Northwind Freight offers visa sponsorship.', 'Northwind Freight offers visa sponsorship. This does not apply to this role.', 'claim_context_qualified'],
      ['same-subject sentence restricts it', 'Northwind Freight offers remote work.', 'Northwind Freight offers remote work. Remote work is only possible from Utrecht.', 'claim_context_qualified'],
      ['next sentence revises the figure', 'Northwind Freight operates 14 depots.', 'Northwind Freight operates 14 depots. Of these depots 9 will close.', 'claim_context_qualified'],
      ['Dutch next sentence restricts it', 'Northwind Freight biedt visumsponsoring aan.', 'Northwind Freight biedt visumsponsoring aan. Dit geldt niet voor deze rol.', 'claim_context_qualified'],
      ['attributed by a lead-in', 'Northwind Freight employs 12,000 people.', 'Acme Haulage says: Northwind Freight employs 12,000 people.', 'claim_context_qualified'],
      ['attributed in the sentence', 'Northwind Freight employs about 450 people.', 'Analysts say Northwind Freight employs about 450 people.', 'claim_entity_mismatch'],
      ['"we" after another organisation', 'Northwind Freight operates 14 depots.', 'Acme Haulage is a carrier from Ghent. We operate 14 depots.', 'claim_entity_mismatch'],
      ['tense changed', 'Northwind Freight offered remote work.', 'Northwind Freight offers remote work to every engineer.', 'claim_not_in_quote'],
      ['claim of two sentences', 'Northwind Freight operates 14 depots. It employs 450 people.', 'Northwind Freight operates 14 depots. It employs 450 people.', 'claim_not_whole_sentence'],
      ['first person in the claim', 'We operate 14 depots across the Benelux.', 'We operate 14 depots across the Benelux.', 'claim_entity_mismatch'],
    ];
    for (const [label, claim, quote, reason] of refused) expect(floor(claim, quote), label).toEqual({ ok: false, reason });
  });

  it('still accepts a whole statement, with only articles, case, plural -s, number format and "we" for the name differing', () => {
    const accepted: Array<[string, string, string]> = [
      ['whole sentence', 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', DEPOTS],
      ['one sentence of several', 'Northwind Freight operates 14 depots across the Netherlands and Belgium.', `${DEPOTS}. We are an equal opportunity employer.`],
      ['first person', 'Northwind Freight operates 14 depots.', 'We operate 14 depots.'],
      ['number format', 'Northwind Freight employs 12,000 people in total.', 'Northwind Freight employs 12.000 people in total.'],
      ['legal form and abbreviation dots', 'Northwind Freight B.V. operates 14 depots in Utrecht.', 'Northwind Freight B.V. operates 14 depots in Utrecht. It was founded in 2009.'],
      ['Dutch whole sentence', 'Northwind Freight biedt visumsponsoring aan voor deze rol.', 'Northwind Freight biedt visumsponsoring aan voor deze rol.'],
      ['a stated restriction kept in the claim', 'Northwind Freight offers visa sponsorship for some roles, but not for this one.', 'Northwind Freight offers visa sponsorship for some roles, but not for this one.'],
      ['lead-in date', 'In 2019, Northwind Freight opened a depot in Ghent.', 'In 2019, Northwind Freight opened a depot in Ghent.'],
    ];
    for (const [label, claim, quote] of accepted) expect(floor(claim, quote), label).toEqual({ ok: true });
  });

  it('accepts a claim without the employer as subject only when the caller allows it (role scope, own source), and fails closed without names', () => {
    expect(floor('Visa sponsorship is available for this role.', 'Visa sponsorship is available for this role')).toEqual({ ok: false, reason: 'claim_entity_mismatch' });
    expect(floor('Visa sponsorship is available for this role.', 'Visa sponsorship is available for this role', { unnamedSubjectAllowed: true })).toEqual({ ok: true });
    // A competitor sentence quoted in full is still not about the employer.
    expect(floor('Acme, a competitor of Northwind Freight, employs 12,000 people.', 'Acme, a competitor of Northwind Freight, employs 12,000 people')).toEqual({ ok: false, reason: 'claim_entity_mismatch' });
    expect(assessQuoteSupport(`${DEPOTS}.`, DEPOTS, [])).toEqual({ ok: false, reason: 'claim_entity_mismatch' });
    // Names with digits or a legal form are matched whole, or without the trailing legal form.
    expect(assessQuoteSupport('Emp1 Corp Group runs 3 depots in Ghent.', 'Emp1 Corp Group runs 3 depots in Ghent.', ['Emp1 Corp Group'])).toEqual({ ok: true });
    expect(assessQuoteSupport(`${DEPOTS}.`, DEPOTS, ['Northwind Freight B.V.'])).toEqual({ ok: true });
    expect(assessQuoteSupport('Emp1 Corp runs 3 depots in Ghent.', 'Emp1 Corp runs 3 depots in Ghent.', ['Emp1 Corp Group'])).toEqual({ ok: false, reason: 'claim_entity_mismatch' });
  });

  it('add: a quote cut short of its page sentence is checked against the page, costs its one request, and stays a lead', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    web.pages.set(NORTHWIND, '<html><body><h1>Platform Engineer</h1><p>Northwind Freight offers visa sponsorship for some roles, but not for this one.</p></body></html>');
    const cut = await addFact(deps, t(a.id), { claim: 'Northwind Freight offers visa sponsorship.', sourceUrl: NORTHWIND, quote: 'Northwind Freight offers visa sponsorship', scope: 'role', topic: 'general' });
    expect(cut).toMatchObject({ ok: true, stats: { requests: 1 } });
    expect(cut.ok && cut.notice).toContain('"but not"');
    expect(factByClaim(t(a.id), 'Northwind Freight offers visa sponsorship.')).toMatchObject({
      topic: 'sponsorship',
      support: 'lead',
      verification: 'unverified',
      lastRefreshReason: 'quote_context_unsupported',
    });
    // Dutch, and a restriction in the NEXT sentence of the page, behave the same.
    web.pages.set('https://job-boards.greenhouse.io/northwind/jobs/1002', '<p>Northwind Freight biedt visumsponsoring aan. Dit geldt niet voor deze rol.</p>');
    await addFact(deps, t(a.id), { claim: 'Northwind Freight biedt visumsponsoring aan.', sourceUrl: 'https://job-boards.greenhouse.io/northwind/jobs/1002', quote: 'Northwind Freight biedt visumsponsoring aan', scope: 'role', topic: 'general' });
    expect(factByClaim(t(a.id), 'Northwind Freight biedt visumsponsoring aan.')).toMatchObject({ support: 'lead', lastRefreshReason: 'quote_context_unsupported' });
    expect(proseEvidence(deps, t(a.id), 'letter')).toEqual([]);
    expect(proseEvidence(deps, t(a.id), 'interview')).toEqual([]);

  });

  it('add: the same sponsorship claim as a whole page sentence on the exact tenant is usable', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    // A heading before the sentence is its own block, not the start of the sentence.
    web.pages.set(NORTHWIND, '<html><body><h2>Visa</h2><p>Northwind Freight sponsors work visas for this role.</p></body></html>');
    await addFact(deps, t(a.id), { claim: 'Northwind Freight sponsors work visas for this role.', sourceUrl: NORTHWIND, quote: 'Northwind Freight sponsors work visas for this role', scope: 'role', topic: 'general' });
    expect(proseEvidence(deps, t(a.id), 'letter').map((fact) => fact.claim)).toEqual(['Northwind Freight sponsors work visas for this role.']);
  });

  it('add: a borrowed-figure claim fails the floor before any request', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const quote = 'Northwind Freight is a logistics firm. Our competitor Acme Haulage employs 12,000 people worldwide.';
    web.page(ABOUT, quote);
    const result = await addFact(deps, t(a.id), { claim: 'Northwind Freight employs 12,000 people.', sourceUrl: ABOUT, quote, scope: 'company', topic: 'size' });
    expect(result).toMatchObject({ ok: true, stats: { requests: 0 } });
    expect(web.calls).toEqual([]);
    expect(factByClaim(t(a.id), 'Northwind Freight employs 12,000 people.')).toMatchObject({ support: 'lead', reasons: expect.arrayContaining(['unverified', 'claim_entity_mismatch']) });
    // A row forced to source_confirmed is re-checked on read and never reaches prose.
    db.update(schema.companyEvidenceFacts).set({ verification: 'source_confirmed', retrievedAt: T0 }).run();
    expect(factByClaim(t(a.id), 'Northwind Freight employs 12,000 people.')).toMatchObject({ support: 'lead', reasons: ['claim_entity_mismatch'] });
    expect(proseEvidence(deps, t(a.id), 'interview')).toEqual([]);
  });

  it('research: no fetch for a floor failure, one fetch that shows the page sentence for a cut quote, and the whole statement confirmed', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    web.pages.set(NORTHWIND, '<p>Northwind Freight offers visa sponsorship for some roles, but not for this one.</p>');
    const outcome: ResearchSessionOutcome = {
      status: 'completed',
      reason: 'completed',
      queries: ['northwind freight'],
      searches: 1,
      fetches: 2,
      candidates: [
        { claim: 'Northwind Freight employs 12,000 people.', topic: 'size', scope: 'company', sourceUrl: ABOUT, quote: 'Northwind Freight is a logistics firm. Our competitor Acme Haulage employs 12,000 people worldwide.' },
        { claim: 'Northwind Freight offers visa sponsorship.', topic: 'general', scope: 'role', sourceUrl: NORTHWIND, quote: 'Northwind Freight offers visa sponsorship' },
        { claim: `${DEPOTS}.`, topic: 'general', scope: 'company', sourceUrl: ABOUT, quote: DEPOTS },
      ],
    };
    const result = await researchCompany({ ...deps, runResearch: async () => outcome }, t(a.id), { topics: ['size', 'general'] }, runs);
    expect(result).toMatchObject({ ok: true, stats: { candidates: 3, confirmed: 1, requests: 2 } });
    expect([...web.calls].sort()).toEqual([ABOUT, NORTHWIND].sort());
    expect(factByClaim(t(a.id), 'Northwind Freight employs 12,000 people.')).toMatchObject({ support: 'lead', lastRefreshReason: 'claim_entity_mismatch' });
    expect(factByClaim(t(a.id), 'Northwind Freight offers visa sponsorship.')).toMatchObject({ support: 'lead', topic: 'sponsorship', lastRefreshReason: 'quote_context_unsupported' });
    expect(proseEvidence(deps, t(a.id), 'letter').map((fact) => fact.claim)).toEqual([`${DEPOTS}.`]);
  });

  it('refresh: a page that later adds "but not" to the sentence demotes the fact instead of renewing it', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    web.pages.set(NORTHWIND, '<p>Northwind Freight sponsors work visas for this role.</p>');
    await addFact(deps, t(a.id), { claim: 'Northwind Freight sponsors work visas for this role.', sourceUrl: NORTHWIND, quote: 'Northwind Freight sponsors work visas for this role', scope: 'role', topic: 'sponsorship' });
    const before = factByClaim(t(a.id), 'Northwind Freight sponsors work visas for this role.')!;
    expect(before.support).toBe('supported');
    clock = new Date(T0.getTime() + 20 * DAY);
    web.pages.set(NORTHWIND, '<p>Northwind Freight sponsors work visas for this role in Germany, but not in the Netherlands.</p>');
    const refreshed = await refreshEvidence(deps, t(a.id), runs);
    expect(refreshed).toMatchObject({ ok: true, stats: { requests: 1, renewed: 0, demoted: 1 } });
    expect(factByClaim(t(a.id), 'Northwind Freight sponsors work visas for this role.')).toMatchObject({
      support: 'lead',
      verification: 'unverified',
      lastRefreshOutcome: 'source_changed',
      lastRefreshReason: 'quote_context_unsupported',
      expiresAt: before.expiresAt,
    });
  });

  it('store: a fetched check is applied only with page text that also passes (fail closed without it)', async () => {
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const claim = 'Northwind Freight offers visa sponsorship.';
    const quote = 'Northwind Freight offers visa sponsorship';
    await addFact(deps, t(a.id), { claim, sourceUrl: 'https://northwind.example/v', quote, scope: 'company', topic: 'general' });
    const id = factByClaim(t(a.id), claim)!.id;
    const identity = getView(deps, t(a.id)).identity;
    const check = (context: string | null) =>
      store.confirmFactFromFetch(db, id, { retrievedAt: T0, contentHash: null, claim, quote, employerNames: names, identity, context }, T0);
    expect(check(null)).toBe('unsupported');
    expect(check('Northwind Freight offers visa sponsorship for some roles, but not for this one.')).toBe('unsupported');
    expect(factByClaim(t(a.id), claim)).toMatchObject({ verification: 'unverified', lastRefreshReason: 'quote_context_unsupported' });
    expect(check('Visa.\nNorthwind Freight offers visa sponsorship.\nApply today')).toBe('applied');
  });

  it('sponsorship wording covers immigration, residence permits, non-EU / third-country hires and the 30% ruling (EN and NL)', async () => {
    for (const text of [
      'Northwind Freight offers relocation support and immigration help for non-EU hires',
      'Northwind Freight supports residence permits for new staff',
      'Northwind Freight helps newcomers with their residence permit',
      'Northwind Freight hires third-country nationals',
      'Northwind Freight covers the 30% ruling',
      'Northwind Freight applies the 30%-regeling for expats',
      'Northwind Freight biedt hulp bij immigratie en verhuizing',
      'Northwind Freight neemt niet-EU kandidaten aan',
      'Northwind Freight helpt bij de verblijfsvergunning',
      'Northwind Freight offers expat relocation services',
      'Northwind Freight applies for a single permit (GVVA) for you',
    ]) {
      expect(mentionsSponsorship(text), text).toBe(true);
    }
    // Not over-matched on ordinary words.
    for (const text of ['Northwind Freight works in the logistics industry', 'Northwind Freight hires individual contributors', 'Northwind Freight eats lunch at noon']) {
      expect(mentionsSponsorship(text), text).toBe(false);
    }

    // add: a blog page, topic "general", company scope -> forced onto the sponsorship rule.
    const a = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const blog = 'https://random-blog.example/post';
    for (const claim of ['Northwind Freight offers relocation support and immigration help for non-EU hires.', 'Northwind Freight biedt hulp bij immigratie en verhuizing.']) {
      web.page(blog, claim.slice(0, -1));
      await addFact(deps, t(a.id), { claim, sourceUrl: blog, quote: claim.slice(0, -1), scope: 'company', topic: 'general' });
      expect(factByClaim(t(a.id), claim), claim).toMatchObject({ topic: 'sponsorship', support: 'lead', reasons: expect.arrayContaining(['sponsorship_needs_role_source']) });
    }
    // research: the same wording labelled "general" is read as sponsorship too.
    const outcome: ResearchSessionOutcome = {
      status: 'completed',
      reason: 'completed',
      queries: [],
      searches: 1,
      fetches: 1,
      candidates: [{ claim: 'Northwind Freight covers the 30% ruling for this role.', topic: 'general', scope: 'role', sourceUrl: blog, quote: 'Northwind Freight covers the 30% ruling for this role' }],
    };
    web.page(blog, 'Northwind Freight covers the 30% ruling for this role');
    await researchCompany({ ...deps, runResearch: async () => outcome }, t(a.id), { topics: ['general'] }, runs);
    expect(factByClaim(t(a.id), 'Northwind Freight covers the 30% ruling for this role.')).toMatchObject({ topic: 'sponsorship', support: 'lead', reasons: expect.arrayContaining(['sponsorship_needs_role_source']) });
    expect(proseEvidence(deps, t(a.id), 'interview')).toEqual([]);
  });
});
