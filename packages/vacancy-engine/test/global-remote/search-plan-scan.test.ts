import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  approveSearchPlanDraft,
  captureSearchPlanSnapshot,
  EMPTY_SEARCH_PLAN,
  searchPlanDraftSchema,
  type SearchPlanSnapshot,
} from '../../src/candidate/search-plan.js';
import { EMPTY_CANDIDATE_PROFILE, type CandidateProfile } from '../../src/candidate/profile.js';
import { runGlobalRemoteDiscovery } from '../../src/global-remote/discovery.js';
import { applyFocusedScanCriteria } from '../../src/global-remote/focused-scan.js';
import type {
  DiscoverySourceAudit,
  DiscoveryVacancyAudit,
  GlobalRemoteConfig,
  SearchPlanEnvelope,
} from '../../src/global-remote/models.js';
import {
  compileSearchPlanQueries,
  LITERAL_QUERY_ID,
  roleFilteredProviders,
  runSearchPlan,
  SEARCH_PLAN_PASS_PROVIDERS,
  type SearchPlanRunResult,
} from '../../src/global-remote/search-plan.js';
import { applyWorkEligibilityEvidence, resolveFocusedLeads } from '../../src/pipeline/global-remote.js';
import {
  SYNTHETIC_CORPUS,
  SyntheticTransport,
  type SyntheticJob,
  type SyntheticTransportOptions,
} from '../fixtures/search-plan-market.js';

const NOW = new Date('2026-10-29T10:00:00.000Z');
const LITERAL = 'React developer';

function baseConfig(literal: string): GlobalRemoteConfig {
  return {
    version: 'test',
    minimumAnnualBaseUsd: null,
    discovery: {
      roleQuery: literal,
      himalayasQueries: [literal],
      himalayasCountry: '',
      himalayasMaxPagesPerQuery: 1,
      jobicyCount: 1,
      freehireLimit: 1,
      jobOpportunitiesLimit: 1,
      remoteLandersMaxPages: 1,
      jobgetherMaxPages: 1,
      remoteFirstMaxPages: 1,
      jobRemotelyMaxPages: 1,
      arbeitnowMaxPages: 1,
      diceMaxPages: 1,
      remooteRoleTitle: '',
      remooteCountry: '',
      remooteLimit: 10,
      aiDevJobsMaxPages: 1,
      taiwanJobsMaxCities: 1,
      museEnabled: false,
      museMaxPages: 1,
      adzunaAppId: '',
      adzunaAppKey: '',
      adzunaMaxPages: 1,
      joobleApiKey: '',
      reedApiKey: '',
      jobspipeApiKey: '',
      atsRosterConcurrency: 1,
      navArbeidsplassenApiKey: '',
      navArbeidsplassenMaxPages: 1,
    },
    officialSources: [],
  } as unknown as GlobalRemoteConfig;
}

function snapshotOf(
  variants: { title: string; language?: string }[],
  extra: { markets?: string[]; primaryFunction?: string } = {},
): SearchPlanSnapshot {
  return captureSearchPlanSnapshot(
    approveSearchPlanDraft(
      EMPTY_SEARCH_PLAN,
      searchPlanDraftSchema.parse({ primaryFunction: extra.primaryFunction ?? 'Frontend engineering', variants, markets: extra.markets ?? [] }),
      NOW,
    ),
  );
}

const FRONTEND_PLAN = snapshotOf([
  { title: 'React developer' },
  { title: 'Frontend engineer' },
  { title: 'UI engineer' },
  { title: 'Frontend ontwikkelaar', language: 'Dutch' },
]);
const NO_TITLES = captureSearchPlanSnapshot(EMPTY_SEARCH_PLAN);

/** A flaky, redirecting upstream: every URL fails once (503, retried) and Himalayas redirects once. */
const FLAKY: SyntheticTransportOptions = { transientFailuresPerUrl: 1, redirectHosts: ['himalayas.app'] };

interface PlannedRun {
  transport: SyntheticTransport;
  plan: SearchPlanRunResult;
  leads: DiscoveryVacancyAudit[];
  sources: DiscoverySourceAudit[];
}

async function runPlanned(
  snapshot: SearchPlanSnapshot,
  options: {
    envelope?: Partial<SearchPlanEnvelope>;
    transport?: SyntheticTransportOptions;
    corpus?: readonly SyntheticJob[];
    literal?: string;
  } = {},
): Promise<PlannedRun> {
  const literal = options.literal ?? LITERAL;
  const transport = new SyntheticTransport(options.corpus ?? SYNTHETIC_CORPUS, options.transport ?? {});
  const config = baseConfig(literal);
  const plan = await runSearchPlan({
    http: transport.http,
    config,
    literal,
    snapshot,
    ...(options.envelope ? { envelope: options.envelope } : {}),
    runLiteral: (http, state) =>
      runGlobalRemoteDiscovery(http, config, [], undefined, undefined, undefined, {
        requestsWereRefused: state.requestsWereRefused,
      }),
  });
  const resolved = resolveFocusedLeads(
    plan.run,
    { role: literal, roleAlternatives: plan.report.queries.slice(1).map((query) => query.query), country: null, employment: null },
    plan,
  );
  return { transport, plan, leads: resolved.focused.vacancies, sources: resolved.discoverySources };
}

function labelOf(lead: DiscoveryVacancyAudit, corpus: readonly SyntheticJob[] = SYNTHETIC_CORPUS): SyntheticJob | undefined {
  return corpus.find((job) => job.url === lead.url && job.title === lead.title) ?? corpus.find((job) => job.url === lead.url);
}

/** The query a served upstream received, read from the upstream's own request log. */
const SERVED_HOST_PARAM: Partial<Record<DiscoverySourceAudit['provider'], readonly [string, string]>> = {
  himalayas: ['himalayas.app', 'q'],
  jobicy: ['jobicy.com', 'tag'],
  jobtech_sweden: ['jobsearch.api.jobtechdev.se', 'q'],
};

function upstreamQueries(transport: SyntheticTransport, provider: DiscoverySourceAudit['provider']): string[] {
  const served = SERVED_HOST_PARAM[provider];
  if (!served) return [];
  return transport.fetchesTo(served[0]).map((entry) => new URL(entry.url).searchParams.get(served[1]) ?? '');
}

describe('search plan scan on the real transport (#686)', () => {
  it('covers exactly the sources that declare a role filter, so a new one cannot be forgotten', () => {
    const expected = roleFilteredProviders()
      .filter((provider) => provider !== 'theirstack')
      .sort();
    expect([...SEARCH_PLAN_PASS_PROVIDERS].sort()).toEqual(expected);
  });

  it('recovers labelled equivalents the literal query misses, each with a traceable origin', async () => {
    const literal = await runPlanned(NO_TITLES, { transport: FLAKY });
    const planned = await runPlanned(FRONTEND_PLAN, { transport: FLAKY });

    const plannedTitles = planned.leads.map((lead) => lead.title);
    for (const expected of ['React Developer', 'Frontend Engineer', 'UI Engineer', 'Senior UI Engineer', 'Frontend ontwikkelaar']) {
      expect(plannedTitles).toContain(expected);
    }
    for (const unwanted of ['UI Designer', 'Sales Manager', 'Data Engineer', 'Sales Engineer', 'Data Scientist', 'React Native Developer']) {
      expect(plannedTitles).not.toContain(unwanted);
    }
    const suitable = (leads: DiscoveryVacancyAudit[]) => new Set(leads.filter((lead) => labelOf(lead)?.equivalent).map((lead) => lead.url)).size;
    expect(suitable(planned.leads)).toBeGreaterThan(suitable(literal.leads));

    for (const lead of planned.leads) {
      expect(lead.queryProvenance?.planRevision).toBe(1);
      expect(lead.queryProvenance?.matchedLocally.length).toBeGreaterThan(0);
    }
    const uiLead = planned.leads.find((lead) => lead.title === 'Senior UI Engineer')!;
    expect(uiLead.queryProvenance!.matchedLocally.map((query) => [query.query, query.field])).toEqual([['UI engineer', 'title']]);
    expect(uiLead.queryProvenance!.fetchedBy.map((origin) => [origin.query, origin.provider])).toEqual([['UI engineer', 'jobicy']]);
    const feedLead = planned.leads.find((lead) => lead.company === 'Theta Apps')!;
    expect(feedLead.queryProvenance!.fetchedBy).toEqual([]);
    expect(feedLead.queryProvenance!.matchedLocally.map((query) => query.variantId)).toContain(LITERAL_QUERY_ID);
  });

  it('charges every physical attempt -- retries and redirect hops included -- and never exceeds the envelope', async () => {
    for (const maxRequests of [30, 54, 60, 75, 1_000]) {
      const planned = await runPlanned(FRONTEND_PLAN, { transport: FLAKY, envelope: { maxRequests } });
      const { usage } = planned.plan.report;
      // The upstream's own log is the truth: one entry per fetch the real client made.
      expect(planned.transport.fetchLog.length).toBe(usage.attempts);
      expect(usage.attempts).toBeLessThanOrEqual(maxRequests);
      expect(usage.attempts).toBe(usage.literalAttempts + usage.variantAttempts);
      // Per-row telemetry adds up to the same physical attempts, so nothing is charged twice or missed.
      expect(planned.sources.reduce((sum, source) => sum + source.networkAttempts, 0)).toBe(planned.transport.fetchLog.length);
      // A row's requests are never more than the calls that really reached the network.
      for (const source of planned.sources) {
        const admission = source.searchPlanAdmission ?? { sentCalls: 0, refusedCalls: 0 };
        expect(source.requests).toBeLessThanOrEqual(admission.sentCalls);
        if (admission.sentCalls === 0) expect(source.networkAttempts).toBe(0);
      }
    }
    // Retries and redirects really happened and were counted: Himalayas' one literal call took
    // 302 -> 503, then the retry 302 -> 200: four physical attempts, two of them in the retry.
    const ample = await runPlanned(FRONTEND_PLAN, { transport: FLAKY });
    const himalayas = ample.sources.find((source) => source.id === `himalayas:${LITERAL}`)!;
    expect(himalayas.networkAttempts).toBe(4);
    expect(himalayas.retries).toBe(2);
    expect(himalayas.requests).toBe(1);
    expect(ample.transport.fetchesTo('himalayas.app').filter((entry) => new URL(entry.url).searchParams.get('q') === LITERAL)).toHaveLength(4);
  });

  it('charges the literal pass too: an allowance smaller than the literal pass cuts it and defers every title', async () => {
    const planned = await runPlanned(FRONTEND_PLAN, { transport: FLAKY, envelope: { maxRequests: 30 } });
    const report = planned.plan.report;
    expect(report.usage.literalAttempts).toBe(30);
    expect(report.usage.variantAttempts).toBe(0);
    expect(report.literal.handling).toBe('partial');
    expect(report.literal.reason).toMatch(/request allowance/);
    expect(report.coverage).toBe('partial');
    for (const variant of report.variants.filter((entry) => entry.handling !== 'covered_by_earlier_query')) {
      expect(variant.handling).toBe('deferred_request_budget');
      expect(variant.attempts).toBe(0);
      expect(variant.providersQueried).toEqual([]);
    }
  });

  it('every source row and title says what really reached the upstream, checked against the upstream log', async () => {
    for (const maxRequests of [58, 62, 70, 1_000]) {
      const planned = await runPlanned(FRONTEND_PLAN, { transport: FLAKY, envelope: { maxRequests } });
      const report = planned.plan.report;
      for (const variant of report.variants) {
        for (const provider of Object.keys(SERVED_HOST_PARAM) as DiscoverySourceAudit['provider'][]) {
          const asked = upstreamQueries(planned.transport, provider).includes(variant.query);
          expect(variant.providersQueried.includes(provider)).toBe(asked && variant.handling !== 'covered_by_earlier_query');
        }
      }
      for (const source of planned.sources.filter((row) => row.id.includes('::plan:'))) {
        const entry = source.focusedScan!.searchPlan!;
        expect(entry).toHaveLength(1);
        const asked = upstreamQueries(planned.transport, source.provider).includes(entry[0]!.query);
        if (SERVED_HOST_PARAM[source.provider]) {
          expect(['sent_upstream', 'partial'].includes(entry[0]!.handling)).toBe(asked);
        }
        if (entry[0]!.handling === 'deferred_request_budget') {
          expect(source.requests).toBe(0);
          expect(source.networkAttempts).toBe(0);
          expect(source.status).toBe('partial');
          expect(entry[0]!.reason).toMatch(/request allowance/);
        }
      }
      // Request totals cannot include phantom calls: requests sum to calls that reached the network.
      const sent = planned.sources.reduce((sum, source) => sum + (source.searchPlanAdmission?.sentCalls ?? 0), 0);
      expect(planned.sources.reduce((sum, source) => sum + source.requests, 0)).toBeLessThanOrEqual(sent);
    }
  });

  it('shares a tight allowance across sources deterministically instead of starving all but the first', async () => {
    const plan = snapshotOf([{ title: 'Frontend engineer' }, { title: 'UI engineer' }, { title: 'Frontend ontwikkelaar', language: 'Dutch' }, { title: 'Web developer' }]);
    const outcomes: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      // No flakiness: the literal pass costs exactly one attempt per source (26), then 4 for 4 titles.
      const planned = await runPlanned(plan, { envelope: { maxRequests: 30 } });
      const asked = planned.plan.report.variants.map((variant) => variant.providersQueried);
      expect(asked.every((providers) => providers.length === 1)).toBe(true);
      // Four titles, four different sources: coverage degrades evenly rather than always serving one.
      expect(new Set(asked.flat()).size).toBe(4);
      expect(planned.plan.report.providersNeverAsked.length).toBeGreaterThan(0);
      outcomes.push(JSON.stringify(asked));
    }
    expect(new Set(outcomes).size).toBe(1);
  });

  it('cuts an in-flight request at the shared deadline and defers the titles it never reached', async () => {
    const started = Date.now();
    const planned = await runPlanned(FRONTEND_PLAN, {
      transport: { hangingHosts: ['jobicy.com'] },
      envelope: { maxDurationMs: 400 },
    });
    const elapsed = Date.now() - started;
    // The real client's own timeout is 5 s: returning well before it proves the plan deadline aborted the fetch.
    expect(elapsed).toBeLessThan(4_000);
    const report = planned.plan.report;
    expect(report.literal.handling).toBe('partial');
    expect(report.literal.reason).toMatch(/time allowance/);
    for (const variant of report.variants.filter((entry) => entry.handling !== 'covered_by_earlier_query')) {
      expect(variant.handling).toBe('deferred_time_budget');
    }
    const jobicy = planned.sources.find((source) => source.provider === 'jobicy')!;
    expect(jobicy.searchPlanAdmission?.refusal).toBe('time');
    expect(jobicy.focusedScan!.searchPlan![0]!.handling).toBe('partial');
    // No fetch was started after the deadline: only the literal pass's first attempts went out.
    expect(planned.transport.fetchLog.length).toBe(report.usage.attempts);
    expect(report.usage.variantAttempts).toBe(0);
  });

  it('counts a call the allowance cut AFTER it reached the network as sent, and only a never-sent call as zero', async () => {
    // Pre-request refusals and refused retries together: every URL answers 503 once, the allowance ends mid-pass.
    const admissionOf = (row: DiscoverySourceAudit) => row.searchPlanAdmission ?? { sentCalls: 0, refusedCalls: 0, refusedFollowUps: 0, refusal: null };
    let neverSentSeen = 0;
    let cutSeen = 0;
    for (const maxRequests of [30, 58, 62, 66, 70, 80]) {
      const planned = await runPlanned(FRONTEND_PLAN, { transport: FLAKY, envelope: { maxRequests } });
      const { usage } = planned.plan.report;
      const neverSent = planned.sources.filter((row) => admissionOf(row).sentCalls === 0 && admissionOf(row).refusedCalls > 0);
      const cutAfterAsking = planned.sources.filter((row) => admissionOf(row).sentCalls > 0 && admissionOf(row).refusedFollowUps > 0);
      neverSentSeen += neverSent.length;
      cutSeen += cutAfterAsking.length;
      for (const row of neverSent) {
        expect(row.requests, `${maxRequests} ${row.id}`).toBe(0);
        expect(row.networkAttempts, row.id).toBe(0);
        expect(row.status, row.id).toBe('partial');
        expect(row.error, row.id).toMatch(/^Not asked:/);
        if (row.id.includes('::plan:')) expect(row.focusedScan!.searchPlan![0]!.handling, row.id).toBe('deferred_request_budget');
      }
      for (const row of cutAfterAsking) {
        // It went out (and its retry was refused): a request, a partial row, truthful text -- not "Not asked".
        expect(row.requests, `${maxRequests} ${row.id}`).toBe(admissionOf(row).sentCalls);
        expect(row.requests, row.id).toBeGreaterThan(0);
        expect(row.status, row.id).toBe('partial');
        expect(row.complete, row.id).toBe(false);
        expect(row.error, row.id).toMatch(/^Stopped after asking:/);
        expect(row.error, row.id).not.toMatch(/Not asked/);
        expect(row.completenessReason, row.id).toBe(row.error);
        // A source without an upstream role filter reports its one feed as matched locally; every other cut row is partial.
        if (row.id.includes('::plan:') || SERVED_HOST_PARAM[row.provider]) {
          expect(row.focusedScan!.searchPlan![0]!.handling, row.id).toBe('partial');
        }
        // The upstream's own log agrees for the literal rows of the sources this fixture serves.
        const served = SERVED_HOST_PARAM[row.provider];
        if (served && !row.id.includes('::plan:')) {
          const queried = planned.transport.fetchesTo(served[0]).filter((entry) => new URL(entry.url).searchParams.get(served[1]) === LITERAL);
          expect(queried.length, row.id).toBe(row.networkAttempts);
        }
      }
      // Ledger, upstream log, per-row telemetry and the report's totals tell one story.
      expect(planned.transport.fetchLog.length).toBe(usage.attempts);
      expect(planned.sources.reduce((sum, row) => sum + row.networkAttempts, 0)).toBe(usage.attempts);
      expect(planned.sources.reduce((sum, row) => sum + admissionOf(row).refusedCalls, 0)).toBe(usage.refusedCalls);
      expect(planned.sources.reduce((sum, row) => sum + admissionOf(row).refusedFollowUps, 0)).toBe(usage.refusedFollowUps);
      // No row claims more requests than calls that reached the network.
      for (const row of planned.sources) expect(row.requests, row.id).toBeLessThanOrEqual(admissionOf(row).sentCalls);
    }
    expect(neverSentSeen).toBeGreaterThan(0);
    expect(cutSeen).toBeGreaterThan(0);

    // In-flight interruption: Jobicy hangs, the shared deadline aborts the attempt that was already sent.
    const hung = await runPlanned(FRONTEND_PLAN, { transport: { hangingHosts: ['jobicy.com'] }, envelope: { maxDurationMs: 400 } });
    const jobicy = hung.sources.find((row) => row.id === `jobicy:${LITERAL}`) ?? hung.sources.find((row) => row.provider === 'jobicy')!;
    expect(admissionOf(jobicy).sentCalls).toBe(1);
    expect(admissionOf(jobicy).refusedFollowUps).toBe(1);
    expect(jobicy.networkAttempts).toBe(1);
    expect(hung.transport.fetchesTo('jobicy.com')).toHaveLength(1);
    expect(jobicy.requests).toBe(1);
    expect(jobicy.status).toBe('partial');
    expect(jobicy.error).toBe('Stopped after asking: the search plan used its whole shared time allowance before this source finished.');
    expect(jobicy.focusedScan!.searchPlan![0]!.handling).toBe('partial');
    expect(hung.plan.report.usage.attempts).toBe(hung.transport.fetchLog.length);
    expect(hung.plan.report.usage.refusedFollowUps).toBeGreaterThanOrEqual(1);
    // A source the deadline passed before it was ever asked still says "Not asked" with zero requests.
    const unasked = hung.sources.filter((row) => admissionOf(row).sentCalls === 0 && admissionOf(row).refusedCalls > 0);
    for (const row of unasked) {
      expect(row.requests, row.id).toBe(0);
      expect(row.error, row.id).toMatch(/^Not asked:/);
    }
  });

  it('bounds matching rows across the literal pass and every title with one result allowance', async () => {
    const planned = await runPlanned(FRONTEND_PLAN, { envelope: { maxResults: 3 } });
    const report = planned.plan.report;
    expect(report.usage.matchingRows).toBe(3);
    expect(report.usage.trimmedRows).toBeGreaterThan(0);
    expect(report.literal.handling).toBe('partial');
    expect(report.literal.reason).toMatch(/result allowance/);
    for (const variant of report.variants.filter((entry) => entry.handling !== 'covered_by_earlier_query')) {
      expect(variant.handling).toBe('deferred_result_cap');
    }
    expect(planned.leads.length).toBeLessThanOrEqual(3);
  });

  it('keeps the selected language on the query and never turns an ad language into a mandatory requirement', async () => {
    const planned = await runPlanned(FRONTEND_PLAN);
    expect(planned.plan.report.workingLanguages).toEqual(['Dutch']);
    expect(planned.plan.report.queries.find((query) => query.query === 'Frontend ontwikkelaar')?.language).toBe('Dutch');

    const englishOnly: CandidateProfile = {
      ...EMPTY_CANDIDATE_PROFILE,
      constraints: { ...EMPTY_CANDIDATE_PROFILE.constraints, professionalLanguage: 'English' },
    };
    const assessed = applyWorkEligibilityEvidence(planned.leads, englishOnly, NOW);
    for (const company of ['Eerste Software BV', 'Achtste Software BV']) {
      const silent = assessed.find((lead) => lead.company === company)!;
      expect(silent.decision).not.toBe('language_mismatch');
      expect(silent.eligibility!.mandatoryLanguage.answer).toBe('unknown');
    }
    const explicit = assessed.find((lead) => lead.company === 'Zesde Digitaal BV')!;
    expect(explicit.decision).toBe('language_mismatch');
    // The plan's selected language is desired work, never a candidate fact.
    expect(englishOnly.constraints.professionalLanguage).toBe('English');
  });

  it('treats approved titles as in scope, so the language gate reads "React developer" and Dutch titles like any frontend title', async () => {
    const job = (id: string, title: string, description: string): SyntheticJob => ({
      id, source: 'himalayas', equivalent: true, title, company: `Co ${id}`, url: `https://job-boards.greenhouse.io/co${id}/jobs/${id}`, description,
    });
    const corpus = [
      job('e1', 'Frontend Engineer', 'Fluent Dutch is required. Je werkt met klanten in het Nederlands.'),
      job('e2', 'Frontend ontwikkelaar', 'Fluent Dutch is required. Je werkt met klanten in het Nederlands.'),
      job('e3', 'React Developer', 'Fluent Dutch is required. Je werkt met klanten in het Nederlands.'),
      job('e4', 'React Developer', 'Wij zoeken een ontwikkelaar voor ons team.'),
    ];
    const englishOnly: CandidateProfile = {
      ...EMPTY_CANDIDATE_PROFILE,
      constraints: { ...EMPTY_CANDIDATE_PROFILE.constraints, professionalLanguage: 'English' },
    };
    const planned = await runPlanned(FRONTEND_PLAN, { corpus });
    const assessed = applyWorkEligibilityEvidence(planned.leads, englishOnly, NOW);
    for (const id of ['e1', 'e2', 'e3']) {
      const lead = assessed.find((entry) => entry.company === `Co ${id}`)!;
      expect(lead.decision).toBe('language_mismatch');
      expect(lead.eligibility!.mandatoryLanguage.answer).toBe('no');
    }
    const silent = assessed.find((entry) => entry.company === 'Co e4')!;
    expect(silent.decision).not.toBe('language_mismatch');
    expect(silent.decision).not.toBe('role_mismatch');
    expect(silent.reasons[0]).toMatch(/approved in the search plan/);

    // Without a plan the built-in English-only pre-classification is unchanged.
    const literalOnly = await runPlanned(NO_TITLES, { corpus });
    const plain = applyWorkEligibilityEvidence(literalOnly.leads, englishOnly, NOW).find((entry) => entry.company === 'Co e3')!;
    expect(plain.decision).toBe('role_mismatch');
  });

  it('never lifts a role exclusion: manager, full-stack and mobile titles that embed an approved title stay role_mismatch', async () => {
    const job = (id: string, title: string): SyntheticJob => ({
      id, source: 'himalayas', equivalent: false, title, company: `Excl ${id}`, url: `https://job-boards.greenhouse.io/excl${id}/jobs/${id}`, description: 'Remote role.',
    });
    const excluded = [
      'Frontend Engineering Manager',
      'Engineering Manager, Frontend Engineering',
      'Full Stack Frontend Engineer',
      'Frontend Engineer (Mobile)',
      'Full-Stack React Developer',
      'Head of Frontend Engineering',
    ];
    const allowed = [
      job('ok1', 'React Developer'),
      job('ok2', 'Frontend ontwikkelaar'),
      job('ok3', 'Senior Frontend Engineer'),
      job('ok4', 'UI Engineer'),
    ].map((entry) => ({ ...entry, equivalent: true }));
    const corpus = [...allowed, ...excluded.map((title, index) => job(`x${index}`, title))];
    const planned = await runPlanned(FRONTEND_PLAN, { corpus });
    for (const title of excluded) {
      const lead = planned.leads.find((entry) => entry.title === title);
      expect(lead, title).toBeDefined();
      expect(lead!.decision, title).toBe('role_mismatch');
      expect(lead!.reasons, title).toEqual(['Title is not explicitly frontend-only.']);
    }
    for (const entry of allowed) {
      const lead = planned.leads.find((candidate) => candidate.title === entry.title)!;
      expect(lead.decision, entry.title).not.toBe('role_mismatch');
      // Only titles the built-in English check rejects need the approval; the rest keep their own reason.
      if (['React Developer', 'Frontend ontwikkelaar'].includes(entry.title)) {
        expect(lead.reasons[0], entry.title).toMatch(/approved in the search plan/);
      }
    }
    // Same decisions without a plan for the excluded titles (the unchanged built-in classifier).
    const literal = await runPlanned(NO_TITLES, { corpus, literal: 'Frontend' });
    for (const title of excluded) {
      const lead = literal.leads.find((entry) => entry.title === title);
      if (lead) expect(lead.decision, title).toBe('role_mismatch');
    }
  });

  it('matches approved titles on the listing title only, and marks description-only matches of the typed query', async () => {
    const planned = await runPlanned(FRONTEND_PLAN);
    const titles = planned.leads.map((lead) => lead.title);
    // "UI engineer toolkit" and "frontend engineer colleagues" in a description do not admit a listing.
    expect(titles).not.toContain('Sales Engineer');
    expect(titles).not.toContain('Data Scientist');
    // The typed query keeps its long-standing title-and-description rule, so the provenance says where.
    const recruiter = planned.leads.find((lead) => lead.title === 'Technical Recruiter')!;
    expect(recruiter.queryProvenance!.matchedLocally).toEqual([
      { variantId: LITERAL_QUERY_ID, query: LITERAL, language: null, field: 'description' },
    ]);
    // The filter still RETAINS a manager title that embeds an approved title (retention is the OR text match)...
    expect(titles).toContain('Frontend Engineering Manager');
    // ...but it is classified role_mismatch, exactly as without a plan: an approval never lifts a role exclusion.
    for (const title of ['Frontend Engineering Manager', 'Engineering Manager, Frontend Engineering']) {
      expect(planned.leads.find((lead) => lead.title === title)!.decision, title).toBe('role_mismatch');
    }

    const rows = [
      { title: 'Frontend Engineer', description: '' },
      { title: 'React Developer', description: '' },
      { title: 'Backend Engineer', description: 'Pairs with frontend engineers.' },
    ].map((row, index) => ({ ...row, key: `k${index}`, url: `https://example.test/${index}`, company: 'Acme', provider: 'jobicy', location: 'Remote' })) as unknown as DiscoveryVacancyAudit[];
    expect(applyFocusedScanCriteria(rows, { role: LITERAL, country: null, employment: null }).vacancies).toHaveLength(1);
    const either = applyFocusedScanCriteria(rows, { role: LITERAL, roleAlternatives: ['Frontend engineer'], country: null, employment: null });
    expect(either.vacancies.map((row) => row.title)).toEqual(['Frontend Engineer', 'React Developer']);
  });

  it('merges a requisition found by several queries and keeps distinct requisitions of the same company and title', async () => {
    const planned = await runPlanned(FRONTEND_PLAN, { transport: FLAKY });
    const acme = planned.leads.filter((lead) => lead.company === 'Acme Labs');
    expect(acme).toHaveLength(1);
    expect(acme[0]!.sources!.map((source) => source.provider).sort()).toEqual(['himalayas', 'jobicy']);
    const beta = planned.leads.filter((lead) => lead.company === 'Beta Works');
    expect(beta).toHaveLength(1);
    expect(beta[0]!.queryProvenance!.fetchedBy.map((origin) => `${origin.query}@${origin.provider}`).sort()).toEqual([
      'Frontend engineer@himalayas',
      'Frontend engineer@jobicy',
    ]);
    const iota = planned.leads.filter((lead) => lead.company === 'Iota Platforms');
    expect(iota.map((lead) => lead.url).sort()).toEqual([
      'https://job-boards.greenhouse.io/iotaplatforms/jobs/111',
      'https://job-boards.greenhouse.io/iotaplatforms/jobs/222',
    ]);
  });

  it('keeps titles that slug alike apart: unique ids, unique source rows, provenance for each', async () => {
    const colliding = snapshotOf([
      { title: 'C++ developer' },
      { title: 'C# developer' },
      { title: 'Front-end engineer' },
      { title: 'Front end engineer' },
      { title: 'Frontend engineer' },
      { title: 'Frontend-engineer!' },
    ]);
    const ids = colliding.variants.map((variant) => variant.id);
    expect(new Set(ids).size).toBe(6);
    // One posting both "C++ developer" and "C# developer" find upstream: their slugs used to collide.
    const polyglot: SyntheticJob = {
      id: 'c1', source: 'himalayas', equivalent: true, title: 'C++ developer / C# developer', company: 'Polyglot Systems',
      url: 'https://job-boards.greenhouse.io/polyglot/jobs/77', description: 'Remote role.',
    };
    const planned = await runPlanned(colliding, { corpus: [...SYNTHETIC_CORPUS, polyglot] });
    const rowIds = planned.sources.map((source) => source.id);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    const variantIds = planned.plan.report.variants.map((variant) => variant.variantId);
    expect(new Set(variantIds).size).toBe(variantIds.length);
    // Each variant's own pass rows point at that variant, and only that one.
    for (const id of ids) {
      const own = planned.sources.filter((source) => source.id.endsWith(`::plan:${id}`));
      expect(own.length).toBeGreaterThan(0);
      for (const row of own) expect(row.focusedScan!.searchPlan!.map((entry) => entry.variantId)).toEqual([id]);
    }
    // Both upstream origins survive the requisition merge, under their own ids.
    const lead = planned.leads.find((entry) => entry.company === 'Polyglot Systems')!;
    expect(lead.queryProvenance!.fetchedBy.map((origin) => [origin.variantId, origin.query]).sort()).toEqual(
      [
        [colliding.variants[0]!.id, 'C++ developer'],
        [colliding.variants[1]!.id, 'C# developer'],
      ].sort(),
    );
  });

  it('reports markets, the primary function and languages as not applied, per source, instead of ignoring them', async () => {
    const plan = snapshotOf([{ title: 'Frontend engineer', language: 'English' }], { markets: ['Netherlands', 'Germany'], primaryFunction: 'Frontend' });
    const planned = await runPlanned(plan);
    expect(planned.plan.report.criteria.map((entry) => [entry.criterion, entry.value, entry.treatment])).toEqual([
      ['primary_function', 'Frontend', 'not_applied'],
      ['markets', 'Netherlands', 'not_applied'],
      ['markets', 'Germany', 'not_applied'],
      ['working_language', 'English', 'title_text_only'],
    ]);
    // No request carried a market: the plan never quietly narrows (or pretends to).
    expect(planned.transport.fetchLog.some((entry) => /netherlands|germany/i.test(entry.url))).toBe(false);
    const himalayas = planned.sources.find((source) => source.id === `himalayas:${LITERAL}`)!;
    const markets = himalayas.focusedScan!.searchPlanCriteria!.filter((entry) => entry.criterion === 'markets');
    expect(markets[0]!.reason).toMatch(/can filter by country/);
    const arbeitnow = planned.sources.find((source) => source.provider === 'arbeitnow')!;
    expect(arbeitnow.focusedScan!.searchPlanCriteria!.find((entry) => entry.criterion === 'markets')!.reason).toMatch(/declares no country filter/);
  });

  it('asks the same words only once and lists the repeated title as covered', () => {
    const { queries, covered } = compileSearchPlanQueries('React developer', FRONTEND_PLAN);
    expect(queries.map((query) => query.query)).toEqual(['React developer', 'Frontend engineer', 'UI engineer', 'Frontend ontwikkelaar']);
    expect(covered.map((entry) => entry.query)).toEqual(['React developer']);
  });

  it('with no plan the literal scan is untouched: same requests, no plan fields', async () => {
    const transport = new SyntheticTransport(SYNTHETIC_CORPUS, FLAKY);
    const literalRun = await runGlobalRemoteDiscovery(transport.http, baseConfig(LITERAL));
    expect(literalRun.sources.every((source) => source.searchPlanAdmission === undefined)).toBe(true);
    const resolved = resolveFocusedLeads(literalRun, { role: LITERAL, country: null, employment: null }, null);
    expect(resolved.focused.vacancies.every((lead) => lead.queryProvenance === undefined)).toBe(true);
    // The planned run's literal pass makes exactly the same requests.
    const planned = await runPlanned(NO_TITLES, { transport: FLAKY });
    expect(planned.transport.fetchLog.map((entry) => entry.url).sort()).toEqual(transport.fetchLog.map((entry) => entry.url).sort());
  });
});

describe('search plan measurement on the synthetic corpus (#686)', () => {
  const equivalentUrls = new Set(SYNTHETIC_CORPUS.filter((job) => job.equivalent).map((job) => job.url));
  const negativeUrls = new Set(SYNTHETIC_CORPUS.filter((job) => !job.equivalent).map((job) => job.url));

  /**
   * Where each suitable unique job came from, from the leads' own provenance: found by the typed query's
   * own filter, or added by the plan -- and, of those added, fetched by a request that carried an approved
   * title versus matched locally in rows the typed-query pass had already fetched (an unfiltered feed).
   */
  function attribution(run: PlannedRun) {
    const byUrl = new Map<string, DiscoveryVacancyAudit[]>();
    for (const lead of run.leads) {
      if (labelOf(lead)?.equivalent !== true) continue;
      byUrl.set(lead.url, [...(byUrl.get(lead.url) ?? []), lead]);
    }
    let foundByTypedQuery = 0;
    let addedByPlan = 0;
    let addedAndFetchedByATitleRequest = 0;
    let addedAndMatchedOnlyLocally = 0;
    for (const leads of byUrl.values()) {
      const matched = leads.flatMap((lead) => lead.queryProvenance?.matchedLocally ?? []);
      if (matched.some((entry) => entry.variantId === LITERAL_QUERY_ID)) {
        foundByTypedQuery += 1;
        continue;
      }
      addedByPlan += 1;
      const fetchedByTitle = leads.some((lead) => (lead.queryProvenance?.fetchedBy ?? []).some((origin) => origin.variantId !== LITERAL_QUERY_ID));
      if (fetchedByTitle) addedAndFetchedByATitleRequest += 1;
      else addedAndMatchedOnlyLocally += 1;
    }
    return {
      suitableFoundByTheTypedQuery: foundByTypedQuery,
      suitableAddedByThePlan: addedByPlan,
      addedAndFetchedByATitleRequest,
      addedAndMatchedOnlyLocallyInRowsTheTypedPassFetched: addedAndMatchedOnlyLocally,
      titleRequestAttempts: run.plan.report.usage.variantAttempts,
    };
  }

  function metrics(run: PlannedRun) {
    const suitable = run.leads.filter((lead) => labelOf(lead)?.equivalent === true);
    const wrong = run.leads.filter((lead) => labelOf(lead)?.equivalent === false);
    const suitableUnique = new Set(suitable.map((lead) => lead.url)).size;
    // What the report presents as candidates: a retained lead the role classifier did not reject.
    const inScope = run.leads.filter((lead) => lead.decision !== 'role_mismatch');
    const inScopeSuitable = inScope.filter((lead) => labelOf(lead)?.equivalent === true);
    const attempts = run.transport.fetchLog.length;
    return {
      retainedLeads: run.leads.length,
      suitableUniqueJobs: suitableUnique,
      wronglyRetained: wrong.map((lead) => lead.title),
      precision: run.leads.length === 0 ? null : Number((suitable.length / run.leads.length).toFixed(3)),
      inScopeLeads: inScope.length,
      wronglyInScope: inScope.filter((lead) => labelOf(lead)?.equivalent === false).map((lead) => lead.title),
      inScopePrecision: inScope.length === 0 ? null : Number((inScopeSuitable.length / inScope.length).toFixed(3)),
      rejectedByRoleClassifier: wrong.filter((lead) => lead.decision === 'role_mismatch').map((lead) => lead.title),
      fixtureRecall: Number((suitableUnique / equivalentUrls.size).toFixed(3)),
      physicalAttempts: attempts,
      attemptsCountedByPlan: run.plan.report.usage.attempts,
      attemptsPerRetainedSuitableJob: suitableUnique === 0 ? null : Number((attempts / suitableUnique).toFixed(2)),
      attribution: attribution(run),
      coverage: run.plan.report.coverage,
      literalHandling: run.plan.report.literal.handling,
    };
  }

  it('compares the literal query and the planned query on ONE corpus under the SAME real envelope', async () => {
    const scenarios: { name: string; envelope: SearchPlanEnvelope }[] = [
      { name: 'tight: 60 attempts (the flaky literal pass alone needs 54)', envelope: { maxRequests: 60, maxDurationMs: 120_000, maxResults: 1_500 } },
      { name: 'moderate: 75 attempts', envelope: { maxRequests: 75, maxDurationMs: 120_000, maxResults: 1_500 } },
      { name: 'ample: 200 attempts', envelope: { maxRequests: 200, maxDurationMs: 120_000, maxResults: 1_500 } },
    ];
    const output: unknown[] = [];
    for (const scenario of scenarios) {
      // Both arms: the same corpus, the same flaky real transport, the same envelope, enforced the same way.
      const literal = await runPlanned(NO_TITLES, { transport: FLAKY, envelope: scenario.envelope });
      const planned = await runPlanned(FRONTEND_PLAN, { transport: FLAKY, envelope: scenario.envelope });
      const literalMetrics = metrics(literal);
      const plannedMetrics = metrics(planned);
      for (const arm of [literalMetrics, plannedMetrics]) {
        expect(arm.physicalAttempts).toBeLessThanOrEqual(scenario.envelope.maxRequests);
        expect(arm.physicalAttempts).toBe(arm.attemptsCountedByPlan);
      }
      expect(plannedMetrics.suitableUniqueJobs).toBeGreaterThan(literalMetrics.suitableUniqueJobs);
      // The attribution accounts for every suitable job exactly once, and the typed-query arm adds nothing by a plan.
      expect(plannedMetrics.attribution.suitableFoundByTheTypedQuery + plannedMetrics.attribution.suitableAddedByThePlan).toBe(plannedMetrics.suitableUniqueJobs);
      expect(plannedMetrics.attribution.addedAndFetchedByATitleRequest + plannedMetrics.attribution.addedAndMatchedOnlyLocallyInRowsTheTypedPassFetched).toBe(plannedMetrics.attribution.suitableAddedByThePlan);
      expect(literalMetrics.attribution.suitableAddedByThePlan).toBe(0);
      // No approved title may promote a role the product excludes: nothing labelled negative by title is in scope for a manager/etc.
      expect(plannedMetrics.wronglyInScope).not.toContain('Frontend Engineering Manager');
      expect(plannedMetrics.wronglyInScope).not.toContain('Engineering Manager, Frontend Engineering');
      output.push({
        scenario: scenario.name,
        envelope: scenario.envelope,
        literal: literalMetrics,
        planned: {
          ...plannedMetrics,
          coverageReason: planned.plan.report.coverageReason,
          variants: planned.plan.report.variants.map((variant) => ({
            query: variant.query,
            language: variant.language,
            handling: variant.handling,
            attempts: variant.attempts,
            providersQueried: variant.providersQueried,
          })),
        },
      });
    }
    const target = process.env.OVR_686_MEASUREMENT_PATH;
    if (target) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        `${JSON.stringify(
          {
            issue: 686,
            kind: 'SYNTHETIC labelled fixture measurement (fix round 2)',
            corpus: `${SYNTHETIC_CORPUS.length} made-up postings (${equivalentUrls.size} distinct labelled-equivalent URLs, ${negativeUrls.size} labelled negatives including ${7} hard negatives) served through a REAL SafeHttpClient with a scripted fetch: every URL answers 503 once (retried) and Himalayas redirects once`,
            labels: 'The equivalent flag is the fixture author construction, not a human relevance judgement. Hard negatives were added from the independent review, not tuned to the matcher.',
            literalQuery: LITERAL,
            approvedTitles: FRONTEND_PLAN.variants.map((variant) => ({ title: variant.title, language: variant.language || null })),
            unit: 'physical network attempts (first attempts, retries, redirect hops) counted by the upstream fetch log and by the plan ledger; both arms run the literal discovery pass under the same envelope',
            scenarios: output,
            limitations: [
              'Synthetic data and synthetic labels only; no live provider, no real job site, no human judgement.',
              'The fake upstream filters by simple substring match over title and description; real sources rank and tokenize differently.',
              'Most of the 26 literal-pass sources are not served by the fixture and answer 404; they still cost real attempts in both arms.',
              'Precision counts retained leads after identity merge, including leads the role classifier then marks role_mismatch; inScopePrecision counts only the leads it did not reject. Recall is relative to the fixture only.',
              'attribution splits the suitable jobs of each arm by origin. A job "added by the plan" and "matched only locally" was already in a row the typed-query pass fetched (an unfiltered feed) and was matched against an approved title on this machine; no title request fetched it. attemptsPerRetainedSuitableJob divides ALL physical attempts, so it mixes that local gain with the cost of title requests that may have fetched nothing extra.',
              'inScopeLeads/inScopePrecision measure the role classifier, not retrieval: the literal arm shows few or no in-scope leads because the built-in English-only role check rejects "React Developer" and Dutch titles, which only an approved plan title stands in for. Compare suitableUniqueJobs and attribution for retrieval. The classifier still rejects every labelled negative whose title is a manager, full-stack, mobile or other excluded family, with or without an approved title.',
              'Says nothing about real-world recall, cost, latency or hiring outcomes.',
            ],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    }
  });
});
