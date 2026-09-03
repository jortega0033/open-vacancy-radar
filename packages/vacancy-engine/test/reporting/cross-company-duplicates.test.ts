import { describe, expect, it } from 'vitest';

import {
  descriptionTokens,
  substantiveDescriptionTokens,
  substantiveDescriptionTokenSequence,
} from '../../src/reporting/ats-boilerplate.js';
import {
  CROSS_COMPANY_MINIMUM_DESCRIPTION_TOKENS,
  CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS,
  CROSS_COMPANY_SHINGLE_LENGTH,
  CROSS_COMPANY_SHINGLE_SIMILARITY_THRESHOLD,
  descriptionShingleSimilarity,
  findCrossCompanyDuplicateGroups,
  type CrossCompanyDuplicateCandidate,
} from '../../src/reporting/cross-company-duplicates.js';

/**
 * One real listing, as the employer itself posted it. Long enough to be a real advert, because
 * anything shorter is refused outright by the token floor.
 */
const PAYMENTS_ROLE_AS_POSTED_BY_EMPLOYER = [
  'Contoso is hiring a Senior Backend Engineer for our payments platform team in Amsterdam.',
  'You will design, build and operate the services that settle transactions for our European merchants.',
  'Our stack is TypeScript, Node.js and PostgreSQL, running on Kubernetes.',
  'You will own services end to end, from schema design through deployment and on-call.',
  'We are looking for at least five years of professional backend experience, a strong grasp of',
  'distributed systems and relational data modelling, and the judgement to keep a payments system boring.',
  'You will work in a small team of six engineers alongside product and design.',
  'We offer a permanent contract, thirty days of holiday, a learning budget and a hybrid working arrangement.',
].join(' ');

/** The same listing after a light rewrite: reworded intro, added apply-through-us outro. */
const PAYMENTS_ROLE_AS_REPOSTED_WITH_EDITS = [
  'Our client Contoso Netherlands is hiring a Senior Backend Engineer for their payments platform team in Amsterdam.',
  'You will design, build and operate the services that settle transactions for European merchants.',
  'The stack is TypeScript, Node.js and PostgreSQL, running on Kubernetes.',
  'You will own services end to end, from schema design through deployment and on-call.',
  'We are looking for at least five years of professional backend experience, a strong grasp of',
  'distributed systems and relational data modelling, and the judgement to keep a payments system boring.',
  'You will work in a small team of six engineers alongside product and design.',
  'On offer is a permanent contract, thirty days of holiday, a learning budget and a hybrid working arrangement.',
  'Apply through this posting and we will come back to you within two working days.',
].join(' ');

/** A genuinely different role: enterprise consultancy delivery work, Java and Kafka, on the road. */
const CONSULTING_ROLE = [
  'Acme Consulting places senior engineers with enterprise clients across the Benelux.',
  'As a Senior Backend Engineer you join a consulting squad delivering integration work for banking',
  'and insurance customers. Expect Java, Spring Boot and Kafka, with a rotation onto a new client',
  'engagement roughly every nine months. We want someone comfortable presenting technical trade offs',
  'to a room of stakeholders, writing architecture decision records, and mentoring juniors on the bench.',
  'Travel within the Netherlands and Belgium is expected two or three days a week.',
  'We offer a lease car, a certification budget and a bonus tied to billable utilisation.',
].join(' ');

/** Another genuinely different role: freight routing, Go and geospatial data, on site at a depot. */
const LOGISTICS_ROLE = [
  'Acme Logistics moves temperature controlled freight across northern Europe from our Amsterdam hub.',
  'As a Senior Backend Engineer you extend the routing and slot booking platform that our drivers and',
  'warehouse planners depend on every hour of the day. The stack is Go, PostgreSQL and a large amount',
  'of geospatial data. You work on vehicle scheduling, capacity forecasting and the telemetry pipeline',
  'that feeds them. We want pragmatic engineers who enjoy messy real world constraints, ferry',
  'timetables and cold chain rules included. This is an on site role at our Schiphol Rijk depot,',
  'four days a week.',
].join(' ');

/**
 * The applicant-tracking-system default skeleton, kept unedited, as an enormous number of real
 * postings ship it. Every word of this is shared verbatim between the round-1 adversarial fixtures
 * below, because in the real case that produced that regression both employers had kept it.
 */
const UNEDITED_ATS_TEMPLATE = [
  'We are looking for a talented Software Engineer to join our growing team in Amsterdam.',
  'You will be responsible for designing, developing and maintaining high quality software solutions.',
  'You will work closely with cross functional teams to deliver features on time and to a high standard.',
  'Requirements: 3+ years of experience in software development, strong communication skills, and the',
  'ability to work independently as well as part of a team in a fast paced environment.',
  "A bachelor's degree or equivalent practical experience is required. Excellent written and spoken",
  'English is essential. Experience with agile methodologies and a proven track record of delivering',
  'projects on time is a plus. Attention to detail and strong problem solving skills are important.',
  'What we offer: a competitive salary and benefits package, a hybrid working arrangement, a pension',
  'scheme, 25 days of holiday, a personal development budget and opportunities for career growth.',
  'We are an equal opportunity employer and we celebrate diversity. All qualified applicants will',
  'receive consideration for employment without regard to race, colour, religion, gender, sexual',
  'orientation, national origin, disability or veteran status.',
  'If this sounds like you, apply now and we look forward to receiving your application.',
].join(' ');

/**
 * ROUND 1 adversarial pair. Two real, unrelated companies that both exist and both have an Amsterdam
 * presence: a US IT staffing firm and a Bermuda-headquartered fund administrator. Identical generic
 * job title, identical city, and the whole template above shared verbatim. Only one sentence each
 * says what the job actually is, and those two sentences describe two completely different jobs.
 *
 * This pair broke v1, which measured it at 0.819 raw-token Jaccard against a 0.65 threshold.
 */
const APEX_STAFFING_ROLE = [
  UNEDITED_ATS_TEMPLATE,
  'Apex Systems places contract and permanent engineers with enterprise clients across the Benelux,',
  'and this role sits on site with our client delivering .NET and Java integration work.',
].join(' ');

const APEX_FUND_ADMINISTRATION_ROLE = [
  UNEDITED_ATS_TEMPLATE,
  'Apex Group administers investment funds worldwide, and this role builds the net asset value',
  'calculation and investor reporting platform used by our fund accounting teams.',
].join(' ');

/**
 * ROUND 2 adversarial pair (a), reconstructed from the review that killed the bag-of-words measure.
 *
 * Two independently written postings for two unrelated employers -- a Rotterdam payments company and
 * a Rotterdam moving company -- that share an ordinary modern platform stack and therefore share
 * their *entire* substantive vocabulary bar a single domain noun ("payments" against "relocations").
 * The sentences, the clause order and the phrasing are different throughout, because two different
 * people wrote them.
 *
 * That is the shape no token-set threshold can survive: it measures 0.944 on v2's substantive-token
 * Jaccard, comfortably *above* the genuine-repost fixture's 0.917.
 */
const ATLAS_FINTECH_ROLE = [
  'The payments platform runs on AWS.',
  'Python microservices are packaged into Docker images, scheduled by Kubernetes and described in Terraform.',
  'Events are streamed by Kafka into PostgreSQL, where deployment automation runs schema migrations.',
  'The engineer owns monitoring, alerting and observability dashboards covering latency, throughput and availability across the pipelines.',
  'The infrastructure sits in Rotterdam.',
].join(' ');

const ATLAS_VAN_LINES_ROLE = [
  'In Rotterdam the infrastructure sits across the pipelines.',
  'Covering availability, throughput and latency, dashboards for observability, alerting and monitoring are what the engineer owns.',
  'Automation of deployment runs schema migrations through PostgreSQL, into which events are streamed by Kafka.',
  'Terraform described what Kubernetes scheduled: Docker images packaged from Python microservices.',
  'On AWS the relocations platform runs.',
].join(' ');

/** ROUND 2 adversarial pair (b). The same construction on a data-engineering stack: one differing
 * domain noun ("telemetry" against "billing"), everything else shared, nothing else phrased alike. */
const NOVATECH_SYSTEMS_ROLE = [
  'Telemetry is the domain.',
  'Python, Spark and Airflow fill a Snowflake warehouse from Kafka topics and dbt models.',
  'Docker images ride on Kubernetes, while AWS and Terraform underpin the estate.',
  'Partitioning, backfills, schema evolution and lineage are the daily concerns.',
  'Streaming, batch orchestration and quality checks round out the engineer role.',
].join(' ');

const NOVATECH_GROUP_ROLE = [
  'Checks on quality, batch orchestration and streaming round out the engineer role.',
  'Lineage, schema evolution, backfills and partitioning are the daily concerns.',
  'Terraform and AWS underpin the estate, while Docker images ride on Kubernetes.',
  'From Kafka topics and dbt models, a Snowflake warehouse they fill: Python, Spark and Airflow.',
  'Billing is the domain.',
].join(' ');

/**
 * ROUND 3: this iteration's own attempt to break the *new* measure rather than the old one.
 *
 * Shuffling vocabulary is useless against a shingle measure, so the attack instead gives the two
 * postings a genuinely shared block of verbatim text -- the kind of "what does this role actually
 * do" explainer that gets copied between adverts and that the ATS boilerplate table does not cover,
 * because its words (pipelines, warehouse, ingestion, lineage) are exactly the job-describing words
 * the measure must keep. On top of that block sit two genuinely different jobs at two employers.
 */
const SHARED_ROLE_EXPLAINER = [
  'What does a Data Engineer actually do? A data engineer designs the pipelines that move raw',
  'records from operational systems into an analytical warehouse, models those records into tables',
  'that analysts can query without surprises, and keeps the whole chain observable so that a broken',
  'upstream field is noticed before a dashboard lies about it. In practice that means writing',
  'ingestion jobs, writing transformations, writing tests for both, and owning the schedule that',
  'runs them. It is a role that sits between the software engineers who produce the records and the',
  'analysts who consume them, and it rewards people who are stubborn about correctness.',
].join(' ');

const MERIDIAN_BANK_ROLE = [
  SHARED_ROLE_EXPLAINER,
  'At Meridian Bank in Utrecht you will land mortgage servicing and arrears data into our Snowflake',
  'warehouse, model it for the regulatory reporting teams, and run the nightly reconciliation against',
  'the core banking ledger. Expect dbt, Airflow and a lot of conversations with risk analysts about',
  'exactly which balance a field means on which date.',
].join(' ');

const BRIGHTWATER_AGENCY_ROLE = [
  SHARED_ROLE_EXPLAINER,
  'Our client is a Utrecht insurer rebuilding its claims analytics stack from scratch. You will own',
  'the ingestion of policy and claims events from their legacy AS/400 estate into BigQuery, build the',
  'actuarial aggregates on top, and help retire three separate spreadsheet reporting processes.',
  'Dataform, Cloud Composer and a genuinely greenfield mandate.',
].join(' ');

/**
 * ROUND 3, second attempt -- the one that *succeeds*, kept deliberately.
 *
 * The same idea taken to its limit: a long third-party job-description template, substantive enough
 * to survive boilerplate stripping, pasted verbatim by two unrelated employers who each append only
 * a short tail of their own. See the "limit this measure still has" section of
 * `CROSS_COMPANY_SHINGLE_SIMILARITY_THRESHOLD`. This is an honest record of the boundary of a
 * near-verbatim detector, not a passing test dressed up as one.
 */
const GENERIC_DATA_ENGINEER_TEMPLATE = [
  'The Data Engineer builds and operates the ingestion pipelines that land source records in the',
  'warehouse. Duties include: writing SQL transformations and dbt models; scheduling jobs in Airflow',
  'and monitoring their runs; designing dimensional and star schema models for analysts; implementing',
  'data quality tests, freshness checks and anomaly alerts; documenting lineage from source column to',
  'dashboard field; partitioning and clustering large tables for cost and speed; handling late',
  'arriving records, backfills and schema evolution without breaking downstream consumers; tuning',
  'warehouse compute and storage spend; building and maintaining streaming ingestion from message',
  'topics; enforcing access controls, retention rules and personal data handling under GDPR; and',
  'reviewing pull requests from analytics engineers. Tooling typically includes Python, SQL, Spark,',
  'Airflow, dbt, Kafka, Docker, Kubernetes, Terraform and a cloud warehouse such as Snowflake,',
  'BigQuery or Redshift. The Data Engineer partners with analytics engineers, data scientists and',
  'platform engineers, and is measured on pipeline reliability, data freshness and query performance.',
].join(' ');

const TEMPLATE_REUSER_BANK = [
  GENERIC_DATA_ENGINEER_TEMPLATE,
  'Here in Utrecht that means mortgage arrears feeds and the nightly reconciliation against our core',
  'banking ledger.',
].join(' ');

const TEMPLATE_REUSER_INSURER = [
  GENERIC_DATA_ENGINEER_TEMPLATE,
  'For us in Utrecht it means claims events off an AS/400 estate and the actuarial aggregates built',
  'on top.',
].join(' ');

function candidate(
  overrides: Partial<CrossCompanyDuplicateCandidate> = {},
): CrossCompanyDuplicateCandidate {
  return {
    id: 'vacancy-1',
    companyId: 'company-1',
    company: 'Contoso',
    title: 'Senior Backend Engineer',
    description: PAYMENTS_ROLE_AS_POSTED_BY_EMPLOYER,
    location: 'Amsterdam',
    ...overrides,
  };
}

/** Both scores to three decimals, so every assertion below reads as the table in the source does. */
const measured = (left: string, right: string): number =>
  Math.round(descriptionShingleSimilarity(left, right) * 1000) / 1000;

/**
 * v2's measure, reimplemented here and nowhere else: unordered Jaccard of substantive token sets.
 *
 * It exists only so the regression tests can state, in the same breath, what the old mechanism
 * scored and what the new one scores. Keeping it in the test file rather than in the shipped module
 * is the point -- it is evidence about a design that was removed, not code anything calls.
 */
function bagOfWordsSimilarity(left: string, right: string): number {
  const leftTokens = substantiveDescriptionTokens(left);
  const rightTokens = substantiveDescriptionTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  const union = leftTokens.size + rightTokens.size - shared;
  return union === 0 ? 0 : Math.round((shared / union) * 1000) / 1000;
}

describe('shingle similarity', () => {
  it('builds windows over the substantive sequence, not over the raw text', () => {
    // The measure only ever sees words that survived boilerplate stripping, in the order they were
    // written. Both halves of that matter: the stripping is what stops a shared ATS skeleton from
    // contributing runs, and the ordering is the entire signal the shingles carry.
    const sequence = substantiveDescriptionTokenSequence(PAYMENTS_ROLE_AS_POSTED_BY_EMPLOYER);
    expect(sequence.slice(0, 5)).toEqual([
      'contoso',
      'senior',
      'backend',
      'engineer',
      'payments',
    ]);
    expect(sequence).not.toContain('experience');
    expect(CROSS_COMPANY_SHINGLE_LENGTH).toBe(5);
  });

  it('scores a lightly rewritten repost of one listing above the grouping threshold', () => {
    expect(measured(PAYMENTS_ROLE_AS_POSTED_BY_EMPLOYER, PAYMENTS_ROLE_AS_REPOSTED_WITH_EDITS)).toBe(
      0.882,
    );
    expect(
      descriptionShingleSimilarity(
        PAYMENTS_ROLE_AS_POSTED_BY_EMPLOYER,
        PAYMENTS_ROLE_AS_REPOSTED_WITH_EDITS,
      ),
    ).toBeGreaterThanOrEqual(CROSS_COMPANY_SHINGLE_SIMILARITY_THRESHOLD);
  });

  it('scores a byte-identical repost as a perfect match', () => {
    expect(
      descriptionShingleSimilarity(
        PAYMENTS_ROLE_AS_POSTED_BY_EMPLOYER,
        PAYMENTS_ROLE_AS_POSTED_BY_EMPLOYER,
      ),
    ).toBe(1);
  });

  it('scores the round-1 Apex pair far below the threshold', () => {
    expect(measured(APEX_STAFFING_ROLE, APEX_FUND_ADMINISTRATION_ROLE)).toBe(0.071);
    expect(bagOfWordsSimilarity(APEX_STAFFING_ROLE, APEX_FUND_ADMINISTRATION_ROLE)).toBe(0.2);
  });

  it('scores the round-2 pairs at exactly zero, where the bag-of-words measure scored them 0.94', () => {
    // The measurement that ended the previous design. Both pairs share their entire substantive
    // vocabulary bar one noun, so the old measure ranked them *above* its own genuine-repost
    // fixture (0.917). Because the two sides were written as different sentences, they share no
    // five-word run whatsoever, and the new measure ranks them at the bottom of the scale.
    expect(bagOfWordsSimilarity(ATLAS_FINTECH_ROLE, ATLAS_VAN_LINES_ROLE)).toBe(0.944);
    expect(measured(ATLAS_FINTECH_ROLE, ATLAS_VAN_LINES_ROLE)).toBe(0);

    expect(bagOfWordsSimilarity(NOVATECH_SYSTEMS_ROLE, NOVATECH_GROUP_ROLE)).toBe(0.939);
    expect(measured(NOVATECH_SYSTEMS_ROLE, NOVATECH_GROUP_ROLE)).toBe(0);

    // Both would have cleared even the hardened 0.90 "weak name relation" threshold of v2.
    for (const score of [
      bagOfWordsSimilarity(ATLAS_FINTECH_ROLE, ATLAS_VAN_LINES_ROLE),
      bagOfWordsSimilarity(NOVATECH_SYSTEMS_ROLE, NOVATECH_GROUP_ROLE),
    ]) {
      expect(score).toBeGreaterThan(0.9);
    }
  });

  it('scores the round-3 shared-explainer pair below the threshold, with room to spare', () => {
    // This iteration's own adversarial construction, and the highest-scoring pair that must not
    // group. Jaccard is what holds the line here: the two postings share a block, then diverge into
    // two completely different jobs, and dividing by the union charges them for that divergence.
    expect(measured(MERIDIAN_BANK_ROLE, BRIGHTWATER_AGENCY_ROLE)).toBe(0.449);
    expect(descriptionShingleSimilarity(MERIDIAN_BANK_ROLE, BRIGHTWATER_AGENCY_ROLE)).toBeLessThan(
      CROSS_COMPANY_SHINGLE_SIMILARITY_THRESHOLD,
    );
  });

  it('scores two genuinely different roles at zero', () => {
    expect(measured(CONSULTING_ROLE, LOGISTICS_ROLE)).toBe(0);
  });

  it('separates the true-positive floor from the adversarial ceiling by a wide band', () => {
    const truePositiveFloor = descriptionShingleSimilarity(
      PAYMENTS_ROLE_AS_POSTED_BY_EMPLOYER,
      PAYMENTS_ROLE_AS_REPOSTED_WITH_EDITS,
    );
    const adversarialCeiling = Math.max(
      descriptionShingleSimilarity(APEX_STAFFING_ROLE, APEX_FUND_ADMINISTRATION_ROLE),
      descriptionShingleSimilarity(ATLAS_FINTECH_ROLE, ATLAS_VAN_LINES_ROLE),
      descriptionShingleSimilarity(NOVATECH_SYSTEMS_ROLE, NOVATECH_GROUP_ROLE),
      descriptionShingleSimilarity(MERIDIAN_BANK_ROLE, BRIGHTWATER_AGENCY_ROLE),
    );

    // v2's equivalent band was 0.917 - 0.913 = 0.004, which is what made it indefensible.
    expect(truePositiveFloor - adversarialCeiling).toBeGreaterThan(0.4);
    expect(CROSS_COMPANY_SHINGLE_SIMILARITY_THRESHOLD).toBeGreaterThan(adversarialCeiling + 0.25);
    expect(CROSS_COMPANY_SHINGLE_SIMILARITY_THRESHOLD).toBeLessThan(truePositiveFloor - 0.1);
  });

  it('records the case this measure still gets wrong, rather than hiding it', () => {
    // Two unrelated employers pasting the same long third-party job-description template verbatim,
    // each with a short tail of their own, DO group. That is the documented boundary of the feature
    // as narrowed: at a hundred consecutive shared substantive words the two adverts are
    // near-verbatim copies of one text, and no local order-sensitive measure can decide whether one
    // text describes one opening or two. Asserted so the number is visible and any future change to
    // it is deliberate.
    expect(measured(TEMPLATE_REUSER_BANK, TEMPLATE_REUSER_INSURER)).toBe(0.88);
    expect(
      descriptionShingleSimilarity(TEMPLATE_REUSER_BANK, TEMPLATE_REUSER_INSURER),
    ).toBeGreaterThan(CROSS_COMPANY_SHINGLE_SIMILARITY_THRESHOLD);
  });

  it('treats an empty description as no evidence rather than a perfect match', () => {
    expect(descriptionShingleSimilarity('', '')).toBe(0);
  });

  it('cannot by itself tell two identical templates from two identical postings', () => {
    // Deliberately recorded rather than papered over: a similarity score compares, it does not
    // judge how much there was to compare. Two identical pure-template descriptions score a perfect
    // 1.0 here, exactly as two identical real postings do. What separates them is
    // CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS, asserted below.
    expect(descriptionShingleSimilarity(UNEDITED_ATS_TEMPLATE, UNEDITED_ATS_TEMPLATE)).toBe(1);
    expect(substantiveDescriptionTokens(UNEDITED_ATS_TEMPLATE).size).toBeLessThan(
      CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS,
    );
  });
});

describe('boilerplate discounting', () => {
  it('leaves the substance of a real posting and removes the recruiting scaffolding', () => {
    const substantive = substantiveDescriptionTokens(PAYMENTS_ROLE_AS_POSTED_BY_EMPLOYER);
    // The job survives.
    for (const token of ['payments', 'typescript', 'postgresql', 'kubernetes', 'merchants']) {
      expect(substantive).toContain(token);
    }
    // The advert around it does not.
    for (const token of ['experience', 'years', 'team', 'offer', 'looking', 'work']) {
      expect(substantive).not.toContain(token);
    }
  });

  it('still earns its place under the shingle measure, on the round-1 pair', () => {
    // Without stripping, the Apex pair's shared ATS skeleton would contribute its own five-word runs
    // and carry the pair most of the way up the scale. With it, the pair scores 0.071.
    const strippedScore = descriptionShingleSimilarity(
      APEX_STAFFING_ROLE,
      APEX_FUND_ADMINISTRATION_ROLE,
    );
    expect(strippedScore).toBeLessThan(0.1);
    // Proof that the skeleton really is the bulk of both texts: it is over half of each posting's
    // raw vocabulary and contributes almost none of its substantive vocabulary.
    expect(descriptionTokens(UNEDITED_ATS_TEMPLATE).size).toBeGreaterThan(
      descriptionTokens(APEX_STAFFING_ROLE).size / 2,
    );
    expect(substantiveDescriptionTokens(UNEDITED_ATS_TEMPLATE).size).toBeLessThan(
      CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS,
    );
  });

  it('reduces a description that is pure template to almost nothing', () => {
    // Long enough to sail past the raw-text floor, and empty of anything that identifies a job:
    // what survives is only the echo of the title and the city, which the exact-title and
    // exact-location gates already established and which therefore add no evidence.
    expect(descriptionTokens(UNEDITED_ATS_TEMPLATE).size).toBeGreaterThan(
      CROSS_COMPANY_MINIMUM_DESCRIPTION_TOKENS,
    );
    expect([...substantiveDescriptionTokens(UNEDITED_ATS_TEMPLATE)].sort()).toEqual([
      'amsterdam',
      'engineer',
      'projects',
      'software',
    ]);
  });

  it('keeps repeats and order, which a set would throw away', () => {
    const sequence = substantiveDescriptionTokenSequence(PAYMENTS_ROLE_AS_POSTED_BY_EMPLOYER);
    expect(sequence.length).toBeGreaterThan(new Set(sequence).size);
  });

  it('keeps every fixture posting above the substantive floor', () => {
    for (const description of [
      PAYMENTS_ROLE_AS_POSTED_BY_EMPLOYER,
      PAYMENTS_ROLE_AS_REPOSTED_WITH_EDITS,
      CONSULTING_ROLE,
      LOGISTICS_ROLE,
      APEX_STAFFING_ROLE,
      APEX_FUND_ADMINISTRATION_ROLE,
      ATLAS_FINTECH_ROLE,
      ATLAS_VAN_LINES_ROLE,
      NOVATECH_SYSTEMS_ROLE,
      NOVATECH_GROUP_ROLE,
      MERIDIAN_BANK_ROLE,
      BRIGHTWATER_AGENCY_ROLE,
    ]) {
      expect(substantiveDescriptionTokens(description).size).toBeGreaterThan(
        CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS,
      );
    }
  });
});

describe('cross-company duplicate grouping', () => {
  it('groups one listing reposted under a name variant of the same employer', () => {
    const rows = [
      candidate({ id: 'employer-row', companyId: 'company-contoso', company: 'Contoso' }),
      candidate({
        id: 'agency-row',
        companyId: 'company-contoso-nl',
        company: 'Contoso Netherlands B.V.',
        description: PAYMENTS_ROLE_AS_REPOSTED_WITH_EDITS,
      }),
    ];

    const groups = findCrossCompanyDuplicateGroups(rows);

    expect(groups.get('employer-row')).toEqual({
      groupId: expect.any(String),
      otherVacancyIds: ['agency-row'],
      otherCompanies: ['Contoso Netherlands B.V.'],
    });
    expect(groups.get('agency-row')).toEqual({
      groupId: groups.get('employer-row')!.groupId,
      otherVacancyIds: ['employer-row'],
      otherCompanies: ['Contoso'],
    });
  });

  it('groups a verbatim staffing-agency repost whose company name shares nothing with the employer', () => {
    // An agency's own brand has no relation to its client's, so a name gate would never have seen
    // this. Since v3 there is no name gate to see it with, and the identical advert text is the
    // whole of the evidence.
    const rows = [
      candidate({ id: 'employer-row', companyId: 'company-contoso', company: 'Contoso' }),
      candidate({
        id: 'agency-row',
        companyId: 'company-agency',
        company: 'Blue Harbour Recruitment',
      }),
    ];

    const groups = findCrossCompanyDuplicateGroups(rows);

    expect(groups.get('employer-row')?.otherCompanies).toEqual(['Blue Harbour Recruitment']);
    expect(groups.get('agency-row')?.otherCompanies).toEqual(['Contoso']);
  });

  it('groups a lightly rewritten repost under two names that share nothing at all', () => {
    // The other half of dropping the name gate, and a case v2 refused: v2 required a name relation
    // before it would look at a rewritten description, so an agency repost under an unrelated brand
    // was invisible to it. The text is now allowed to be the whole argument, in both directions.
    const rows = [
      candidate({ id: 'employer-row', companyId: 'company-contoso', company: 'Contoso' }),
      candidate({
        id: 'agency-row',
        companyId: 'company-agency',
        company: 'Blue Harbour Recruitment',
        description: PAYMENTS_ROLE_AS_REPOSTED_WITH_EDITS,
      }),
    ];

    expect(findCrossCompanyDuplicateGroups(rows).get('employer-row')?.otherCompanies).toEqual([
      'Blue Harbour Recruitment',
    ]);
  });

  it('does NOT group two different roles at similarly named companies', () => {
    // Same normalized job title, same city, and company names that the deleted name heuristic
    // happily related. Only the posting text decides now, and it says no.
    const rows = [
      candidate({
        id: 'consulting-row',
        companyId: 'company-acme-consulting',
        company: 'Acme Consulting',
        description: CONSULTING_ROLE,
      }),
      candidate({
        id: 'logistics-row',
        companyId: 'company-acme-logistics',
        company: 'Acme Logistics',
        description: LOGISTICS_ROLE,
      }),
    ];

    expect(findCrossCompanyDuplicateGroups(rows).size).toBe(0);
  });

  it('does NOT group the round-1 Apex Systems / Apex Group boilerplate pair', () => {
    // Permanent regression test for the confirmed v1 false positive: a US IT staffing firm and a
    // Bermuda fund administrator, both with an Amsterdam presence, posting two genuinely different
    // Software Engineer roles on the same untouched ATS template.
    const rows = [
      candidate({
        id: 'apex-systems-row',
        companyId: 'company-apex-systems',
        company: 'Apex Systems',
        title: 'Software Engineer',
        description: APEX_STAFFING_ROLE,
      }),
      candidate({
        id: 'apex-group-row',
        companyId: 'company-apex-group',
        company: 'Apex Group',
        title: 'Software Engineer',
        description: APEX_FUND_ADMINISTRATION_ROLE,
      }),
    ];

    // Not passing because some earlier gate started rejecting the pair for an unrelated reason:
    // both descriptions are long, substantive and identically titled and located.
    expect(descriptionTokens(APEX_STAFFING_ROLE).size).toBeGreaterThan(
      CROSS_COMPANY_MINIMUM_DESCRIPTION_TOKENS,
    );
    expect(substantiveDescriptionTokens(APEX_FUND_ADMINISTRATION_ROLE).size).toBeGreaterThan(
      CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS,
    );

    expect(findCrossCompanyDuplicateGroups(rows).size).toBe(0);
  });

  it('does NOT group the round-2 Atlas / Atlas Van Lines common-stack pair', () => {
    // Regression test for the finding that killed the bag-of-words design twice over: the deleted
    // name heuristic called "Atlas" *strongly* related to "Atlas Van Lines" (a token-set subset
    // test on a one-word brand), and the text measure then scored the pair 0.944, above its own
    // genuine-repost fixture. Neither half of that can happen now: names are not consulted, and the
    // shingle measure scores this pair at zero.
    const rows = [
      candidate({
        id: 'atlas-row',
        companyId: 'company-atlas',
        company: 'Atlas',
        title: 'Platform Engineer',
        location: 'Rotterdam',
        description: ATLAS_FINTECH_ROLE,
      }),
      candidate({
        id: 'atlas-van-lines-row',
        companyId: 'company-atlas-van-lines',
        company: 'Atlas Van Lines',
        title: 'Platform Engineer',
        location: 'Rotterdam',
        description: ATLAS_VAN_LINES_ROLE,
      }),
    ];

    expect(findCrossCompanyDuplicateGroups(rows).size).toBe(0);
  });

  it('does NOT group the round-2 NovaTech Systems / NovaTech Group common-stack pair', () => {
    const rows = [
      candidate({
        id: 'novatech-systems-row',
        companyId: 'company-novatech-systems',
        company: 'NovaTech Systems',
        title: 'Data Engineer',
        location: 'Eindhoven',
        description: NOVATECH_SYSTEMS_ROLE,
      }),
      candidate({
        id: 'novatech-group-row',
        companyId: 'company-novatech-group',
        company: 'NovaTech Group',
        title: 'Data Engineer',
        location: 'Eindhoven',
        description: NOVATECH_GROUP_ROLE,
      }),
    ];

    expect(findCrossCompanyDuplicateGroups(rows).size).toBe(0);
  });

  it('does NOT group the round-3 shared-explainer pair built to beat this very measure', () => {
    // Two different data-engineering jobs at two employers, sharing a verbatim fifty-word explainer
    // that the boilerplate table cannot strip because its words are the job-describing ones. The
    // highest-scoring pair that must not group, at 0.449 against a 0.75 threshold.
    const rows = [
      candidate({
        id: 'meridian-row',
        companyId: 'company-meridian',
        company: 'Meridian Bank',
        title: 'Data Engineer',
        location: 'Utrecht',
        description: MERIDIAN_BANK_ROLE,
      }),
      candidate({
        id: 'brightwater-row',
        companyId: 'company-brightwater',
        company: 'Brightwater Talent',
        title: 'Data Engineer',
        location: 'Utrecht',
        description: BRIGHTWATER_AGENCY_ROLE,
      }),
    ];

    expect(findCrossCompanyDuplicateGroups(rows).size).toBe(0);
  });

  it('does NOT group two employers who both pasted the same untouched recruiting template', () => {
    // The identical-text case that the similarity measure alone would rank a perfect 1.0. The
    // substantive floor is what refuses it: the shared text is pure template, so it is evidence of
    // a shared ATS vendor and of nothing else.
    const rows = [
      candidate({
        id: 'template-row-a',
        companyId: 'company-apex-systems',
        company: 'Apex Systems',
        title: 'Software Engineer',
        description: UNEDITED_ATS_TEMPLATE,
      }),
      candidate({
        id: 'template-row-b',
        companyId: 'company-northwind',
        company: 'Northwind Traders',
        title: 'Software Engineer',
        description: UNEDITED_ATS_TEMPLATE,
      }),
    ];

    // The raw-token floor does not catch this: there is plenty of text, it just says nothing.
    expect(descriptionTokens(UNEDITED_ATS_TEMPLATE).size).toBeGreaterThan(
      CROSS_COMPANY_MINIMUM_DESCRIPTION_TOKENS,
    );
    expect(findCrossCompanyDuplicateGroups(rows).size).toBe(0);
  });

  it('does not group two different titles even when everything else lines up', () => {
    const rows = [
      candidate({ id: 'row-a', companyId: 'company-contoso', company: 'Contoso' }),
      candidate({
        id: 'row-b',
        companyId: 'company-contoso-nl',
        company: 'Contoso Netherlands B.V.',
        title: 'Senior Backend Engineer II',
      }),
    ];

    expect(findCrossCompanyDuplicateGroups(rows).size).toBe(0);
  });

  it('does not group two different locations even when everything else lines up', () => {
    const rows = [
      candidate({ id: 'row-a', companyId: 'company-contoso', company: 'Contoso' }),
      candidate({
        id: 'row-b',
        companyId: 'company-contoso-nl',
        company: 'Contoso Netherlands B.V.',
        location: 'Rotterdam',
      }),
    ];

    expect(findCrossCompanyDuplicateGroups(rows).size).toBe(0);
  });

  it('refuses to group stub rows whose descriptions are too thin to be evidence', () => {
    // Identical text, but a placeholder. Two unrelated employers both posting a bare "Software
    // Engineer" line is not a duplicate, it is a lack of data.
    const stub = 'Software Engineer. Apply on our website.';
    expect(descriptionTokens(stub).size).toBeLessThan(CROSS_COMPANY_MINIMUM_DESCRIPTION_TOKENS);

    const rows = [
      candidate({ id: 'row-a', companyId: 'company-a', company: 'Contoso', description: stub }),
      candidate({
        id: 'row-b',
        companyId: 'company-b',
        company: 'Contoso Netherlands B.V.',
        description: stub,
      }),
    ];

    expect(findCrossCompanyDuplicateGroups(rows).size).toBe(0);
  });

  it('leaves same-company rows alone, so the existing same-company collapse is untouched', () => {
    const rows = [
      candidate({ id: 'row-a', companyId: 'company-contoso', company: 'Contoso' }),
      candidate({
        id: 'row-b',
        companyId: 'company-contoso',
        company: 'Contoso',
        description: PAYMENTS_ROLE_AS_REPOSTED_WITH_EDITS,
      }),
    ];

    expect(findCrossCompanyDuplicateGroups(rows).size).toBe(0);
  });

  it('never removes, hides or reorders a row: it only returns annotations', () => {
    const rows = [
      candidate({ id: 'employer-row', companyId: 'company-contoso', company: 'Contoso' }),
      candidate({
        id: 'agency-row',
        companyId: 'company-agency',
        company: 'Blue Harbour Recruitment',
      }),
      candidate({
        id: 'unrelated-row',
        companyId: 'company-acme-logistics',
        company: 'Acme Logistics',
        description: LOGISTICS_ROLE,
      }),
    ];

    const groups = findCrossCompanyDuplicateGroups(rows);
    const annotated = rows.map((row) => ({ ...row, duplicateGroup: groups.get(row.id) ?? null }));

    // Same rows, same order, same count. Every grouped row is still independently addressable by
    // its own id and still carries its own company, so either can be opened or dismissed alone.
    expect(annotated).toHaveLength(rows.length);
    expect(annotated.map((row) => row.id)).toEqual(['employer-row', 'agency-row', 'unrelated-row']);
    expect(annotated.filter((row) => row.duplicateGroup !== null)).toHaveLength(2);
    expect(annotated[2]!.duplicateGroup).toBeNull();
    for (const row of annotated) {
      expect(row.duplicateGroup?.otherVacancyIds ?? []).not.toContain(row.id);
    }
  });

  it('collects a listing reposted by two separate agencies into one group of three', () => {
    const rows = [
      candidate({ id: 'employer-row', companyId: 'company-contoso', company: 'Contoso' }),
      candidate({
        id: 'agency-a-row',
        companyId: 'company-agency-a',
        company: 'Blue Harbour Recruitment',
      }),
      candidate({
        id: 'agency-b-row',
        companyId: 'company-agency-b',
        company: 'Red Kite Staffing',
      }),
    ];

    const groups = findCrossCompanyDuplicateGroups(rows);

    expect(groups.size).toBe(3);
    expect(new Set([...groups.values()].map((group) => group.groupId)).size).toBe(1);
    expect(groups.get('employer-row')?.otherVacancyIds).toEqual(['agency-a-row', 'agency-b-row']);
  });

  it('returns nothing for a single row or an empty report', () => {
    expect(findCrossCompanyDuplicateGroups([]).size).toBe(0);
    expect(findCrossCompanyDuplicateGroups([candidate()]).size).toBe(0);
  });
});
