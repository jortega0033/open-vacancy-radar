import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AtsHttpClient } from '../../src/ats/http.js';
import {
  approveSearchPlanDraft,
  captureSearchPlanSnapshot,
  EMPTY_SEARCH_PLAN,
  searchPlanDraftSchema,
  type SearchPlanSnapshot,
} from '../../src/candidate/search-plan.js';
import { EMPTY_CANDIDATE_PROFILE, type CandidateProfile } from '../../src/candidate/profile.js';
import { runGlobalRemoteDiscovery } from '../../src/global-remote/discovery.js';
import { applyFocusedScanCriteria, SOURCE_FILTER_CAPABILITIES } from '../../src/global-remote/focused-scan.js';
import type {
  DiscoveryRun,
  DiscoveryVacancyAudit,
  GlobalRemoteConfig,
  SearchPlanEnvelope,
} from '../../src/global-remote/models.js';
import {
  compileSearchPlanQueries,
  literalQueryDependentRequests,
  LITERAL_QUERY_ID,
  roleFilteredProviders,
  runSearchPlanVariantPasses,
  SEARCH_PLAN_PASS_PROVIDERS,
} from '../../src/global-remote/search-plan.js';
import { applyWorkEligibilityEvidence, resolveFocusedLeads } from '../../src/pipeline/global-remote.js';
import { SYNTHETIC_CORPUS, SyntheticMarket, type SyntheticJob } from '../fixtures/search-plan-market.js';

const NOW = new Date('2026-10-29T10:00:00.000Z');

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

function snapshotOf(variants: { title: string; language?: string }[]): SearchPlanSnapshot {
  return captureSearchPlanSnapshot(
    approveSearchPlanDraft(
      EMPTY_SEARCH_PLAN,
      searchPlanDraftSchema.parse({ primaryFunction: 'Frontend engineering', variants }),
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

interface PlannedRun {
  market: SyntheticMarket;
  literalRun: DiscoveryRun;
  plan: Awaited<ReturnType<typeof runSearchPlanVariantPasses>>;
  leads: DiscoveryVacancyAudit[];
  sources: ReturnType<typeof resolveFocusedLeads>['discoverySources'];
}

async function runPlanned(
  literal: string,
  snapshot: SearchPlanSnapshot,
  envelope?: Partial<SearchPlanEnvelope>,
  wrap: (market: SyntheticMarket) => AtsHttpClient = (market) => market,
  now?: () => number,
): Promise<PlannedRun> {
  const market = new SyntheticMarket();
  const http = wrap(market);
  const config = baseConfig(literal);
  const literalRun = await runGlobalRemoteDiscovery(http, config);
  const plan = await runSearchPlanVariantPasses({
    http,
    config,
    literal,
    snapshot,
    literalRun,
    ...(envelope ? { envelope } : {}),
    ...(now ? { now } : {}),
  });
  const resolved = resolveFocusedLeads(
    plan.run,
    {
      role: literal,
      roleAlternatives: plan.report.queries.slice(1).map((query) => query.query),
      country: null,
      employment: null,
    },
    plan,
  );
  return { market, literalRun, plan, leads: resolved.focused.vacancies, sources: resolved.discoverySources };
}

async function runLiteral(
  literal: string,
): Promise<{ market: SyntheticMarket; leads: DiscoveryVacancyAudit[]; literalRun: DiscoveryRun }> {
  const market = new SyntheticMarket();
  const literalRun = await runGlobalRemoteDiscovery(market, baseConfig(literal));
  const resolved = resolveFocusedLeads(literalRun, { role: literal, country: null, employment: null }, null);
  return { market, leads: resolved.focused.vacancies, literalRun };
}

function labelOf(lead: DiscoveryVacancyAudit): SyntheticJob | undefined {
  return (
    SYNTHETIC_CORPUS.find((job) => job.url === lead.url && job.title === lead.title) ??
    SYNTHETIC_CORPUS.find((job) => job.url === lead.url)
  );
}

describe('search plan scan (#686)', () => {
  it('covers exactly the sources that declare a role filter, so a new one cannot be forgotten', () => {
    const expected = roleFilteredProviders()
      .filter((provider) => provider !== 'theirstack')
      .sort();
    expect([...SEARCH_PLAN_PASS_PROVIDERS].sort()).toEqual(expected);
  });

  it('recovers labelled equivalents the literal query misses, each with a traceable origin', async () => {
    const literal = await runLiteral('React developer');
    const planned = await runPlanned('React developer', FRONTEND_PLAN);

    expect(literal.leads.every((lead) => /react developer/i.test(lead.title))).toBe(true);

    const plannedTitles = planned.leads.map((lead) => lead.title);
    for (const expected of ['React Developer', 'Frontend Engineer', 'UI Engineer', 'Senior UI Engineer', 'Frontend ontwikkelaar']) {
      expect(plannedTitles).toContain(expected);
    }
    // Wrong-family rows stay out: "UI Designer", "Backend Engineer", "Sales Manager", "Data Engineer".
    for (const unwanted of ['UI Designer', 'Backend Engineer', 'Sales Manager', 'Data Engineer']) {
      expect(plannedTitles).not.toContain(unwanted);
    }
    expect(planned.leads.length).toBeGreaterThan(literal.leads.length);

    // Every kept lead says which approved title(s) its text matched, as copies of the text.
    for (const lead of planned.leads) {
      expect(lead.queryProvenance?.planRevision).toBe(1);
      expect(lead.queryProvenance?.matchedLocally.length).toBeGreaterThan(0);
    }
    const uiLead = planned.leads.find((lead) => lead.title === 'Senior UI Engineer')!;
    expect(uiLead.queryProvenance!.matchedLocally.map((query) => query.query)).toEqual(['UI engineer']);
    // Found upstream by the UI-engineer query on a source that declares a role filter.
    expect(uiLead.queryProvenance!.fetchedBy.map((origin) => [origin.query, origin.provider])).toEqual([
      ['UI engineer', 'jobicy'],
    ]);
    // A lead from a source with no role filter has no upstream origin, only the local match.
    const feedLead = planned.leads.find((lead) => lead.company === 'Theta Apps')!;
    expect(feedLead.queryProvenance!.fetchedBy).toEqual([]);
    expect(feedLead.queryProvenance!.matchedLocally.map((query) => query.variantId)).toContain(LITERAL_QUERY_ID);
  });

  it('keeps a title found only by an approved variant, instead of letting the literal query discard it', () => {
    const rows = [
      { title: 'Frontend Engineer', description: '' },
      { title: 'React Developer', description: '' },
    ].map((row, index) => ({
      ...row,
      key: `k${index}`,
      url: `https://example.test/${index}`,
      company: 'Acme',
      provider: 'jobicy',
      location: 'Remote',
    })) as unknown as DiscoveryVacancyAudit[];
    expect(applyFocusedScanCriteria(rows, { role: 'React developer', country: null, employment: null }).vacancies).toHaveLength(1);
    const either = applyFocusedScanCriteria(rows, {
      role: 'React developer',
      roleAlternatives: ['Frontend engineer'],
      country: null,
      employment: null,
    });
    expect(either.vacancies.map((row) => row.title)).toEqual(['Frontend Engineer', 'React Developer']);
  });

  it('keeps the selected language on the query and never turns an ad language into a mandatory requirement', async () => {
    const planned = await runPlanned('React developer', FRONTEND_PLAN);
    expect(planned.plan.report.workingLanguages).toEqual(['Dutch']);
    const dutchQuery = planned.plan.report.queries.find((query) => query.query === 'Frontend ontwikkelaar');
    expect(dutchQuery?.language).toBe('Dutch');

    const englishOnly: CandidateProfile = {
      ...EMPTY_CANDIDATE_PROFILE,
      constraints: { ...EMPTY_CANDIDATE_PROFILE.constraints, professionalLanguage: 'English' },
    };
    const assessed = applyWorkEligibilityEvidence(planned.leads, englishOnly, NOW);

    // Dutch adverts that state no language requirement are NOT gated: the answer stays unknown, so
    // the lead stays reviewable instead of being treated as "Dutch required".
    for (const company of ['Eerste Software BV', 'Achtste Software BV']) {
      const silent = assessed.find((lead) => lead.company === company)!;
      expect(silent.decision).not.toBe('language_mismatch');
      expect(silent.eligibility!.mandatoryLanguage.answer).toBe('unknown');
    }
    // The unchanged gate still reads an explicit "Dutch is required" statement.
    const explicit = assessed.find((lead) => lead.company === 'Zesde Digitaal BV')!;
    expect(explicit.decision).toBe('language_mismatch');
    expect(explicit.eligibility!.mandatoryLanguage.answer).toBe('no');
    // The plan's selected language is desired work, never a candidate fact.
    expect(englishOnly.constraints.professionalLanguage).toBe('English');
  });

  it('merges a requisition found by several queries and keeps distinct requisitions of the same company and title', async () => {
    const planned = await runPlanned('React developer', FRONTEND_PLAN);
    // h1 (Himalayas) and j1 (Jobicy) are the same greenhouse requisition: one lead, both sources kept.
    const acme = planned.leads.filter((lead) => lead.company === 'Acme Labs');
    expect(acme).toHaveLength(1);
    expect(acme[0]!.sources!.map((source) => source.provider).sort()).toEqual(['himalayas', 'jobicy']);
    // The same requisition found by two sources under one approved title keeps both upstream origins.
    const beta = planned.leads.filter((lead) => lead.company === 'Beta Works');
    expect(beta).toHaveLength(1);
    expect(
      beta[0]!.queryProvenance!.fetchedBy.map((origin) => `${origin.query}@${origin.provider}`).sort(),
    ).toEqual(['Frontend engineer@himalayas', 'Frontend engineer@jobicy']);
    // Same company, same title, two requisition ids: both survive.
    const iota = planned.leads.filter((lead) => lead.company === 'Iota Platforms');
    expect(iota.map((lead) => lead.url).sort()).toEqual([
      'https://job-boards.greenhouse.io/iotaplatforms/jobs/111',
      'https://job-boards.greenhouse.io/iotaplatforms/jobs/222',
    ]);
  });

  it('stays inside one declared request envelope however many titles are approved, and reports what it deferred', async () => {
    const many = snapshotOf(Array.from({ length: 12 }, (_, index) => ({ title: `Frontend title ${index + 1}` })));
    const probe = await runLiteral('React developer');
    const spent = literalQueryDependentRequests(probe.literalRun);
    const envelope = { maxRequests: spent + 10, maxDurationMs: 60_000, maxResults: 1_000 };
    const planned = await runPlanned('React developer', many, envelope);

    expect(planned.plan.report.usage.literalRequests).toBe(spent);
    // The shared allowance bounds the variants together, not each title separately.
    expect(planned.plan.report.usage.variantRequests).toBeLessThanOrEqual(10);
    expect(planned.plan.report.usage.literalRequests + planned.plan.report.usage.variantRequests).toBeLessThanOrEqual(
      envelope.maxRequests,
    );
    const deferred = planned.plan.report.variants.filter((variant) => variant.handling === 'deferred_request_budget');
    expect(deferred.length).toBeGreaterThan(0);
    expect(planned.plan.report.variants).toHaveLength(12);
    expect(planned.plan.report.coverage).toBe('partial');
    expect(planned.plan.report.coverageReason).toMatch(/not fully searched/);
    for (const variant of deferred) {
      expect(variant.requests).toBe(0);
      expect(variant.reason).toMatch(/request allowance/);
    }
    // Every approved title is still part of the local OR filter even when it could not be sent upstream.
    expect(planned.plan.report.queries).toHaveLength(13);
    // A source the shared allowance stopped from asking is partial coverage, not a broken source.
    const refused = planned.plan.run.sources.filter((source) => source.completenessReason?.startsWith('Not fully asked'));
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((source) => source.status === 'partial' && source.complete === false && source.id.includes('::plan:'))).toBe(true);

    // A roomier envelope is respected as well.
    const roomy = await runPlanned('React developer', many, { maxRequests: 40, maxDurationMs: 60_000, maxResults: 1_000 });
    expect(roomy.plan.report.usage.literalRequests + roomy.plan.report.usage.variantRequests).toBeLessThanOrEqual(40);
  });

  it('defers the remaining titles when time or the result allowance runs out', async () => {
    const outOfTime = await runPlanned('React developer', FRONTEND_PLAN, {
      maxRequests: 200,
      maxDurationMs: 0,
      maxResults: 1_000,
    });
    expect(outOfTime.plan.report.variants.filter((variant) => variant.handling === 'deferred_time_budget')).toHaveLength(3);
    expect(outOfTime.plan.report.usage.variantRequests).toBe(0);

    let clock = 0;
    const slowAfterFirst = await runPlanned(
      'React developer',
      FRONTEND_PLAN,
      { maxRequests: 200, maxDurationMs: 100_000, maxResults: 1_000 },
      (market) => ({
        get: async (url) => {
          const response = await market.get(url);
          if (url.includes('himalayas.app') && url.includes('q=Frontend+engineer')) clock = 500_000;
          return response;
        },
        postJson: (url) => market.postJson(url),
      }),
      () => clock,
    );
    const handled = slowAfterFirst.plan.report.variants.map((variant) => variant.handling);
    expect(handled[0]).toMatch(/sent_upstream|partial/);
    expect(handled).toContain('deferred_time_budget');

    const capped = await runPlanned('React developer', FRONTEND_PLAN, {
      maxRequests: 200,
      maxDurationMs: 60_000,
      maxResults: 1,
    });
    expect(capped.plan.report.usage.variantRows).toBe(1);
    expect(
      capped.plan.report.variants.some(
        (variant) => variant.handling === 'partial' || variant.handling === 'deferred_result_cap',
      ),
    ).toBe(true);
    expect(capped.plan.report.coverage).toBe('partial');
  });

  it('shows in the source audit which titles went upstream and which were matched locally only', async () => {
    const planned = await runPlanned('React developer', FRONTEND_PLAN);
    const feed = planned.sources.find((source) => source.provider === 'arbeitnow')!;
    expect(SOURCE_FILTER_CAPABILITIES.arbeitnow.role).toBeUndefined();
    expect(feed.focusedScan!.searchPlan!.every((entry) => entry.handling === 'local_only')).toBe(true);
    expect(feed.focusedScan!.searchPlan![0]!.reason).toMatch(/declares no role filter/);
    // The unchanged per-criterion audit is still there beside it.
    expect(feed.focusedScan!.unsupported.some((entry) => entry.criterion === 'role')).toBe(true);

    const jobicyLiteral = planned.sources.find((source) => source.id === 'jobicy:frontend')!;
    expect(jobicyLiteral.focusedScan!.searchPlan!.map((entry) => entry.handling)).toEqual(Array(4).fill('sent_upstream'));
    const jobicyVariant = planned.sources.find((source) => source.id.startsWith('jobicy:frontend::plan:'))!;
    expect(jobicyVariant.focusedScan!.searchPlan).toHaveLength(1);
    expect(jobicyVariant.focusedScan!.searchPlan![0]!.handling).toBe('sent_upstream');
  });

  it('asks the same words only once and lists the repeated title as covered', () => {
    const { queries, covered } = compileSearchPlanQueries(
      'React developer',
      snapshotOf([{ title: 'react  developer' }, { title: 'UI engineer' }]),
    );
    expect(queries.map((query) => query.query)).toEqual(['React developer', 'UI engineer']);
    expect(covered.map((entry) => entry.coveredBy)).toEqual([LITERAL_QUERY_ID]);
  });

  it('with no plan the literal scan is untouched: same rows, same requests, no plan fields', async () => {
    const literal = await runLiteral('React developer');
    expect(literal.leads.every((lead) => lead.queryProvenance === undefined)).toBe(true);
    expect(literal.literalRun.sources.every((source) => source.focusedScan === undefined)).toBe(true);
    expect(literal.market.requestsTo('himalayas.app')).toBe(1);
  });
});

describe('search plan measurement on the synthetic corpus (#686)', () => {
  const equivalentUrls = new Set(SYNTHETIC_CORPUS.filter((job) => job.equivalent).map((job) => job.url));

  function metrics(label: string, leads: readonly DiscoveryVacancyAudit[], market: SyntheticMarket) {
    const suitable = leads.filter((lead) => labelOf(lead)?.equivalent === true);
    const suitableDistinctUrls = new Set(suitable.map((lead) => lead.url)).size;
    return {
      label,
      retainedUniqueLeads: leads.length,
      suitableUniqueLeads: suitable.length,
      suitableDistinctUrls,
      precision: leads.length === 0 ? null : Number((suitable.length / leads.length).toFixed(3)),
      fixtureRecall: Number((suitableDistinctUrls / equivalentUrls.size).toFixed(3)),
      upstreamRequests: market.requests.length,
      queryFilteredHostRequests: ['himalayas.app', 'jobicy.com', 'jobsearch.api.jobtechdev.se'].reduce(
        (sum, host) => sum + market.requestsTo(host),
        0,
      ),
      requestsPerSuitableLead: suitable.length === 0 ? null : Number((market.requests.length / suitable.length).toFixed(2)),
    };
  }

  it('compares the literal query and the planned query on ONE corpus under the SAME envelope', async () => {
    const probe = await runLiteral('React developer');
    const spent = literalQueryDependentRequests(probe.literalRun);
    const scenarios: { name: string; envelope: SearchPlanEnvelope }[] = [
      {
        name: 'tight: the literal pass plus 3 shared requests',
        envelope: { maxRequests: spent + 3, maxDurationMs: 120_000, maxResults: 1_500 },
      },
      {
        name: 'moderate: the literal pass plus 12 shared requests',
        envelope: { maxRequests: spent + 12, maxDurationMs: 120_000, maxResults: 1_500 },
      },
      {
        name: 'ample: the literal pass plus 60 shared requests',
        envelope: { maxRequests: spent + 60, maxDurationMs: 120_000, maxResults: 1_500 },
      },
    ];
    const output: unknown[] = [];
    for (const scenario of scenarios) {
      const literal = await runLiteral('React developer');
      const planned = await runPlanned('React developer', FRONTEND_PLAN, scenario.envelope);
      const literalMetrics = metrics('literal query only', literal.leads, literal.market);
      const plannedMetrics = metrics('reviewed plan: literal + 4 approved titles', planned.leads, planned.market);
      expect(plannedMetrics.suitableDistinctUrls).toBeGreaterThan(literalMetrics.suitableDistinctUrls);
      expect(plannedMetrics.precision).toBeGreaterThanOrEqual(literalMetrics.precision ?? 0);
      expect(planned.plan.report.usage.literalRequests + planned.plan.report.usage.variantRequests).toBeLessThanOrEqual(
        scenario.envelope.maxRequests,
      );
      output.push({
        scenario: scenario.name,
        envelope: scenario.envelope,
        literal: literalMetrics,
        planned: {
          ...plannedMetrics,
          coverage: planned.plan.report.coverage,
          coverageReason: planned.plan.report.coverageReason,
          variants: planned.plan.report.variants.map((variant) => ({
            query: variant.query,
            language: variant.language,
            handling: variant.handling,
            requests: variant.requests,
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
            kind: 'SYNTHETIC labelled fixture measurement',
            corpus: `${SYNTHETIC_CORPUS.length} made-up postings served by an in-memory fake upstream (Himalayas, Jobicy and JobTech filter by title server-side; Arbeitnow does not)`,
            labelledEquivalentUrlsInFixture: equivalentUrls.size,
            labels: 'the equivalent flag is the fixture author construction, not a human relevance judgement',
            literalQuery: 'React developer',
            approvedTitles: FRONTEND_PLAN.variants.map((variant) => ({ title: variant.title, language: variant.language || null })),
            scenarios: output,
            limitations: [
              'Synthetic data and synthetic labels only; no live provider, no real job site, no human judgement.',
              'The fake upstream filters by simple substring match; real sources rank and tokenize differently.',
              'Request counts are counted at the fake upstream: every attempted request, including those to sources the fixture does not serve.',
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
