import { isDeepStrictEqual } from 'node:util';

import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { withTransaction, type Database } from '../db/client.js';
import {
  companyDiscoveryCampaignItems,
  indSponsors,
  scanRuns,
} from '../db/schema.js';
import { sanitizeDiagnosticContext } from '../scans/repository.js';

export const COMPANY_DISCOVERY_CAMPAIGN_COMMAND = 'companies:discovery:campaign';
export const COMPANY_DISCOVERY_CAMPAIGN_OUTCOME_BATCH_LIMIT = 100;

const CAMPAIGN_INSERT_BATCH_SIZE = 500;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,99}$/u;
const PARTIAL_OUTCOMES = new Set<CompanyDiscoveryCampaignOutcome>([
  'needs_domain',
  'candidate_ready',
  'unsupported',
  'blocked',
  'manual_review',
  'error',
]);

export type CompanyDiscoveryCampaignOutcome = NonNullable<
  typeof companyDiscoveryCampaignItems.$inferSelect.outcome
>;

export type StartCompanyDiscoveryCampaignResult = {
  campaignRunId: string;
  resumed: boolean;
  expectedSponsors: number;
  inspectionRunIds: string[];
};

export type CompanyDiscoveryCampaignMetadataPatch = {
  inspectionRunIds?: readonly string[];
  structuredSourceRequestCount?: number;
  sourceScanRunId?: string;
  sourceScanPhysicalRequestCount?: number;
};

export type CompleteCompanyDiscoveryCampaignItemInput = {
  sponsorId: string;
  finalPhase: string;
  outcome: CompanyDiscoveryCampaignOutcome;
  reasonCode: string;
  networkAttempted: boolean;
  pagesAttempted: number;
  pagesFetched: number;
  physicalRequestCount: number;
  httpStatus?: number | null;
  details?: Record<string, unknown>;
  completedAt?: Date;
};

export type CompleteCompanyDiscoveryCampaignItemsResult = {
  completed: number;
  unchanged: number;
  progress: CompanyDiscoveryCampaignProgress;
};

export type CompanyDiscoveryCampaignProgress = {
  campaignRunId: string;
  runStatus: typeof scanRuns.$inferSelect.status;
  startedAt: Date;
  finishedAt: Date | null;
  expectedSponsors: number;
  totalSponsors: number;
  pendingSponsors: number;
  terminalSponsors: number;
  siteInspectionAttemptedSponsors: number;
  sitePagesAttempted: number;
  sitePagesFetched: number;
  sitePhysicalRequestCount: number;
  structuredSourceRequestCount: number;
  sourceScanRunId: string | null;
  sourceScanPhysicalRequestCount: number;
  totalPhysicalRequestCount: number;
  outcomeCounts: Record<string, number>;
  reasonCounts: Record<string, number>;
};

export type CompanyDiscoveryCampaignExportRow = {
  campaignRunId: string;
  ordinal: number;
  sponsorId: string;
  sourceIdentityKey: string;
  legalName: string;
  kvkNumber: string | null;
  state: typeof companyDiscoveryCampaignItems.$inferSelect.state;
  finalPhase: string | null;
  outcome: CompanyDiscoveryCampaignOutcome | null;
  reasonCode: string | null;
  networkAttempted: boolean;
  pagesAttempted: number;
  pagesFetched: number;
  physicalRequestCount: number;
  httpStatus: number | null;
  details: Record<string, unknown>;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ProgressTotals = {
  totalSponsors: number;
  pendingSponsors: number;
  terminalSponsors: number;
  networkAttemptedSponsors: number;
  pagesAttempted: number;
  pagesFetched: number;
  physicalRequestCount: number;
};

function numeric(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} must match ${IDENTIFIER_PATTERN.source}`);
  }
}

function normalizeCompletionInput(
  input: CompleteCompanyDiscoveryCampaignItemInput,
): Required<
  Omit<CompleteCompanyDiscoveryCampaignItemInput, 'httpStatus' | 'details' | 'completedAt'>
> & {
  httpStatus: number | null;
  details: Record<string, unknown>;
  completedAt: Date;
} {
  assertIdentifier(input.finalPhase, 'finalPhase');
  assertIdentifier(input.reasonCode, 'reasonCode');
  if (!Number.isInteger(input.pagesAttempted) || input.pagesAttempted < 0 || input.pagesAttempted > 2) {
    throw new RangeError('pagesAttempted must be an integer from 0 through 2');
  }
  if (
    !Number.isInteger(input.pagesFetched) ||
    input.pagesFetched < 0 ||
    input.pagesFetched > input.pagesAttempted
  ) {
    throw new RangeError('pagesFetched must be an integer from 0 through pagesAttempted');
  }
  if (!Number.isInteger(input.physicalRequestCount) || input.physicalRequestCount < 0) {
    throw new RangeError('physicalRequestCount must be a non-negative integer');
  }
  if (input.networkAttempted !== (input.pagesAttempted > 0)) {
    throw new Error('networkAttempted must be true exactly when pagesAttempted is greater than zero');
  }
  const httpStatus = input.httpStatus ?? null;
  if (
    httpStatus !== null &&
    (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)
  ) {
    throw new RangeError('httpStatus must be null or an integer from 100 through 599');
  }
  if (!input.networkAttempted && (input.physicalRequestCount !== 0 || httpStatus !== null)) {
    throw new Error('A no-network outcome cannot have physical requests or an HTTP status');
  }
  const sanitizedDetails = sanitizeDiagnosticContext(input.details ?? {});
  return {
    sponsorId: input.sponsorId,
    finalPhase: input.finalPhase,
    outcome: input.outcome,
    reasonCode: input.reasonCode,
    networkAttempted: input.networkAttempted,
    pagesAttempted: input.pagesAttempted,
    pagesFetched: input.pagesFetched,
    physicalRequestCount: input.physicalRequestCount,
    httpStatus,
    details: sanitizedDetails,
    completedAt: input.completedAt ?? new Date(),
  };
}

function statisticsFromTotals(expectedSponsors: number, totals: ProgressTotals): Record<string, unknown> {
  return {
    expectedSponsors,
    totalSponsors: totals.totalSponsors,
    pendingSponsors: totals.pendingSponsors,
    terminalSponsors: totals.terminalSponsors,
    siteInspectionAttemptedSponsors: totals.networkAttemptedSponsors,
    sitePagesAttempted: totals.pagesAttempted,
    sitePagesFetched: totals.pagesFetched,
    sitePhysicalRequestCount: totals.physicalRequestCount,
  };
}

function statisticStringArray(statistics: Record<string, unknown>, key: string): string[] {
  const value = statistics[key];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}

function statisticString(statistics: Record<string, unknown>, key: string): string | null {
  const value = statistics[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sameCompletion(
  current: typeof companyDiscoveryCampaignItems.$inferSelect,
  input: ReturnType<typeof normalizeCompletionInput>,
): boolean {
  return (
    current.state === 'terminal' &&
    current.finalPhase === input.finalPhase &&
    current.outcome === input.outcome &&
    current.reasonCode === input.reasonCode &&
    current.networkAttempted === input.networkAttempted &&
    current.pagesAttempted === input.pagesAttempted &&
    current.pagesFetched === input.pagesFetched &&
    current.physicalRequestCount === input.physicalRequestCount &&
    current.httpStatus === input.httpStatus &&
    isDeepStrictEqual(current.details, input.details)
  );
}

/**
 * Starts a campaign by snapshotting every active sponsor in stable order, or
 * resumes the sole unfinished campaign. The transaction lock prevents two
 * callers from creating competing campaign headers.
 */
export async function startOrResumeCompanyDiscoveryCampaign(
  database: Database,
  now = new Date(),
): Promise<StartCompanyDiscoveryCampaignResult> {
  return withTransaction(database, async (transaction) => {
    // The former `pg_advisory_xact_lock` is unnecessary on SQLite: the
    // enclosing `begin immediate` transaction already holds the database's
    // single write lock for its whole lifetime, so two callers cannot create
    // competing campaign headers.
    const running = await transaction
      .select({
        id: scanRuns.id,
        statistics: scanRuns.statistics,
      })
      .from(scanRuns)
      .where(
        and(
          eq(scanRuns.command, COMPANY_DISCOVERY_CAMPAIGN_COMMAND),
          eq(scanRuns.status, 'running'),
          isNull(scanRuns.finishedAt),
        ),
      )
      .orderBy(desc(scanRuns.startedAt), desc(scanRuns.id))
      .limit(2);
    if (running.length > 1) {
      throw new Error('Multiple unfinished company discovery campaigns require manual review');
    }
    const current = running[0];
    if (current !== undefined) {
      const [itemCount] = await transaction
        .select({ count: count() })
        .from(companyDiscoveryCampaignItems)
        .where(eq(companyDiscoveryCampaignItems.campaignRunId, current.id));
      const expectedSponsors = numeric(current.statistics.expectedSponsors);
      const persistedItems = numeric(itemCount?.count);
      if (expectedSponsors !== persistedItems) {
        throw new Error(
          `Campaign ${current.id} snapshot mismatch: expected ${expectedSponsors}, found ${persistedItems}`,
        );
      }
      return {
        campaignRunId: current.id,
        resumed: true,
        expectedSponsors,
        inspectionRunIds: statisticStringArray(current.statistics, 'inspectionRunIds'),
      };
    }

    const sponsors = await transaction
      .select({
        sponsorId: indSponsors.id,
        sourceIdentityKey: indSponsors.sourceIdentityKey,
        legalName: indSponsors.legalName,
        kvkNumber: indSponsors.kvkNumber,
      })
      .from(indSponsors)
      .where(eq(indSponsors.active, true))
      .orderBy(asc(indSponsors.sourceIdentityKey), asc(indSponsors.id));
    const expectedSponsors = sponsors.length;
    const [run] = await transaction
      .insert(scanRuns)
      .values({
        command: COMPANY_DISCOVERY_CAMPAIGN_COMMAND,
        status: 'running',
        aiEnabled: false,
        startedAt: now,
        statistics: {
          ...statisticsFromTotals(expectedSponsors, {
            totalSponsors: expectedSponsors,
            pendingSponsors: expectedSponsors,
            terminalSponsors: 0,
            networkAttemptedSponsors: 0,
            pagesAttempted: 0,
            pagesFetched: 0,
            physicalRequestCount: 0,
          }),
          inspectionRunIds: [],
          structuredSourceRequestCount: 0,
          sourceScanPhysicalRequestCount: 0,
        },
      })
      .returning({ id: scanRuns.id });
    if (run === undefined) throw new Error('Campaign scan run insert did not return an id');

    for (let offset = 0; offset < sponsors.length; offset += CAMPAIGN_INSERT_BATCH_SIZE) {
      const batch = sponsors.slice(offset, offset + CAMPAIGN_INSERT_BATCH_SIZE);
      if (batch.length === 0) continue;
      await transaction.insert(companyDiscoveryCampaignItems).values(
        batch.map((sponsor, index) => ({
          campaignRunId: run.id,
          sponsorId: sponsor.sponsorId,
          ordinal: offset + index + 1,
          sourceIdentityKeySnapshot: sponsor.sourceIdentityKey,
          legalNameSnapshot: sponsor.legalName,
          kvkNumberSnapshot: sponsor.kvkNumber,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    return {
      campaignRunId: run.id,
      resumed: false,
      expectedSponsors,
      inspectionRunIds: [],
    };
  });
}

export async function checkpointCompanyDiscoveryCampaign(
  database: Database,
  campaignRunId: string,
  patch: CompanyDiscoveryCampaignMetadataPatch,
): Promise<void> {
  for (const [label, value] of [
    ['structuredSourceRequestCount', patch.structuredSourceRequestCount],
    ['sourceScanPhysicalRequestCount', patch.sourceScanPhysicalRequestCount],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new RangeError(`${label} must be a non-negative integer`);
    }
  }
  if (patch.sourceScanRunId?.length === 0) {
    throw new Error('sourceScanRunId cannot be empty');
  }

  await withTransaction(database, async (transaction) => {
    const [run] = await transaction
      .select({
        command: scanRuns.command,
        status: scanRuns.status,
        finishedAt: scanRuns.finishedAt,
        statistics: scanRuns.statistics,
      })
      .from(scanRuns)
      .where(eq(scanRuns.id, campaignRunId))

      .limit(1);
    if (
      run?.command !== COMPANY_DISCOVERY_CAMPAIGN_COMMAND ||
      run.status !== 'running' ||
      run.finishedAt !== null
    ) {
      throw new Error(`Company discovery campaign ${campaignRunId} is not running`);
    }
    const statistics: Record<string, unknown> = { ...run.statistics };
    if (patch.inspectionRunIds !== undefined) {
      statistics.inspectionRunIds = [
        ...new Set([
          ...statisticStringArray(run.statistics, 'inspectionRunIds'),
          ...patch.inspectionRunIds.filter((value) => value.length > 0),
        ]),
      ];
    }
    if (patch.structuredSourceRequestCount !== undefined) {
      statistics.structuredSourceRequestCount = patch.structuredSourceRequestCount;
    }
    if (patch.sourceScanRunId !== undefined) statistics.sourceScanRunId = patch.sourceScanRunId;
    if (patch.sourceScanPhysicalRequestCount !== undefined) {
      statistics.sourceScanPhysicalRequestCount = patch.sourceScanPhysicalRequestCount;
    }
    await transaction.update(scanRuns).set({ statistics }).where(eq(scanRuns.id, campaignRunId));
  });
}

export async function getCompanyDiscoveryCampaignProgress(
  database: Database,
  campaignRunId: string,
): Promise<CompanyDiscoveryCampaignProgress> {
  const [run] = await database
    .select({
      command: scanRuns.command,
      status: scanRuns.status,
      statistics: scanRuns.statistics,
      startedAt: scanRuns.startedAt,
      finishedAt: scanRuns.finishedAt,
    })
    .from(scanRuns)
    .where(eq(scanRuns.id, campaignRunId))
    .limit(1);
  if (run?.command !== COMPANY_DISCOVERY_CAMPAIGN_COMMAND) {
    throw new Error(`Company discovery campaign ${campaignRunId} does not exist`);
  }

  const [totals] = await database
    .select({
      totalSponsors: sql<number>`count(*)`,
      pendingSponsors: sql<number>`count(*) filter (where ${companyDiscoveryCampaignItems.state} = 'pending')`,
      terminalSponsors: sql<number>`count(*) filter (where ${companyDiscoveryCampaignItems.state} = 'terminal')`,
      networkAttemptedSponsors: sql<number>`count(*) filter (where ${companyDiscoveryCampaignItems.networkAttempted} = true)`,
      pagesAttempted: sql<number>`coalesce(sum(${companyDiscoveryCampaignItems.pagesAttempted}), 0)`,
      pagesFetched: sql<number>`coalesce(sum(${companyDiscoveryCampaignItems.pagesFetched}), 0)`,
      physicalRequestCount: sql<number>`coalesce(sum(${companyDiscoveryCampaignItems.physicalRequestCount}), 0)`,
    })
    .from(companyDiscoveryCampaignItems)
    .where(eq(companyDiscoveryCampaignItems.campaignRunId, campaignRunId));
  const [outcomeRows, reasonRows] = await Promise.all([
    database
      .select({ outcome: companyDiscoveryCampaignItems.outcome, count: count() })
      .from(companyDiscoveryCampaignItems)
      .where(
        and(
          eq(companyDiscoveryCampaignItems.campaignRunId, campaignRunId),
          eq(companyDiscoveryCampaignItems.state, 'terminal'),
        ),
      )
      .groupBy(companyDiscoveryCampaignItems.outcome),
    database
      .select({ reasonCode: companyDiscoveryCampaignItems.reasonCode, count: count() })
      .from(companyDiscoveryCampaignItems)
      .where(
        and(
          eq(companyDiscoveryCampaignItems.campaignRunId, campaignRunId),
          eq(companyDiscoveryCampaignItems.state, 'terminal'),
        ),
      )
      .groupBy(companyDiscoveryCampaignItems.reasonCode),
  ]);
  const normalizedTotals: ProgressTotals = {
    totalSponsors: numeric(totals?.totalSponsors),
    pendingSponsors: numeric(totals?.pendingSponsors),
    terminalSponsors: numeric(totals?.terminalSponsors),
    networkAttemptedSponsors: numeric(totals?.networkAttemptedSponsors),
    pagesAttempted: numeric(totals?.pagesAttempted),
    pagesFetched: numeric(totals?.pagesFetched),
    physicalRequestCount: numeric(totals?.physicalRequestCount),
  };
  const structuredSourceRequestCount = numeric(run.statistics.structuredSourceRequestCount);
  const sourceScanPhysicalRequestCount = numeric(run.statistics.sourceScanPhysicalRequestCount);
  return {
    campaignRunId,
    runStatus: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    expectedSponsors: numeric(run.statistics.expectedSponsors),
    totalSponsors: normalizedTotals.totalSponsors,
    pendingSponsors: normalizedTotals.pendingSponsors,
    terminalSponsors: normalizedTotals.terminalSponsors,
    siteInspectionAttemptedSponsors: normalizedTotals.networkAttemptedSponsors,
    sitePagesAttempted: normalizedTotals.pagesAttempted,
    sitePagesFetched: normalizedTotals.pagesFetched,
    sitePhysicalRequestCount: normalizedTotals.physicalRequestCount,
    structuredSourceRequestCount,
    sourceScanRunId: statisticString(run.statistics, 'sourceScanRunId'),
    sourceScanPhysicalRequestCount,
    totalPhysicalRequestCount:
      normalizedTotals.physicalRequestCount +
      structuredSourceRequestCount +
      sourceScanPhysicalRequestCount,
    outcomeCounts: Object.fromEntries(
      outcomeRows.flatMap((row) =>
        row.outcome === null ? [] : [[row.outcome, numeric(row.count)] as const],
      ),
    ),
    reasonCounts: Object.fromEntries(
      reasonRows.flatMap((row) =>
        row.reasonCode === null ? [] : [[row.reasonCode, numeric(row.count)] as const],
      ),
    ),
  };
}

/** Commits up to 100 final outcomes. Replaying identical data is idempotent. */
export async function completeCompanyDiscoveryCampaignItems(
  database: Database,
  campaignRunId: string,
  inputs: readonly CompleteCompanyDiscoveryCampaignItemInput[],
): Promise<CompleteCompanyDiscoveryCampaignItemsResult> {
  if (inputs.length > COMPANY_DISCOVERY_CAMPAIGN_OUTCOME_BATCH_LIMIT) {
    throw new RangeError(
      `Campaign outcome batch cannot exceed ${COMPANY_DISCOVERY_CAMPAIGN_OUTCOME_BATCH_LIMIT} sponsors`,
    );
  }
  const normalized = inputs.map((input) => normalizeCompletionInput(input));
  const sponsorIds = normalized.map((input) => input.sponsorId);
  if (new Set(sponsorIds).size !== sponsorIds.length) {
    throw new Error('Campaign outcome batch contains a duplicate sponsor id');
  }
  if (normalized.length === 0) {
    return {
      completed: 0,
      unchanged: 0,
      progress: await getCompanyDiscoveryCampaignProgress(database, campaignRunId),
    };
  }

  const counters = await withTransaction(database, async (transaction) => {
    const [run] = await transaction
      .select({
        command: scanRuns.command,
        status: scanRuns.status,
        finishedAt: scanRuns.finishedAt,
        statistics: scanRuns.statistics,
      })
      .from(scanRuns)
      .where(eq(scanRuns.id, campaignRunId))

      .limit(1);
    if (
      run?.command !== COMPANY_DISCOVERY_CAMPAIGN_COMMAND ||
      run.status !== 'running' ||
      run.finishedAt !== null
    ) {
      throw new Error(`Company discovery campaign ${campaignRunId} is not running`);
    }
    const currentRows = await transaction
      .select()
      .from(companyDiscoveryCampaignItems)
      .where(
        and(
          eq(companyDiscoveryCampaignItems.campaignRunId, campaignRunId),
          inArray(companyDiscoveryCampaignItems.sponsorId, sponsorIds),
        ),
      );
    const currentBySponsor = new Map(currentRows.map((row) => [row.sponsorId, row]));
    const missing = sponsorIds.filter((sponsorId) => !currentBySponsor.has(sponsorId));
    if (missing.length > 0) {
      throw new Error(`Campaign outcome sponsors are outside the snapshot: ${missing.join(', ')}`);
    }

    let completed = 0;
    let unchanged = 0;
    for (const input of normalized) {
      const current = currentBySponsor.get(input.sponsorId);
      if (current === undefined) throw new Error(`Campaign sponsor ${input.sponsorId} disappeared`);
      if (current.state === 'terminal') {
        if (!sameCompletion(current, input)) {
          throw new Error(`Conflicting terminal outcome for campaign sponsor ${input.sponsorId}`);
        }
        unchanged += 1;
        continue;
      }
      const updated = await transaction
        .update(companyDiscoveryCampaignItems)
        .set({
          state: 'terminal',
          finalPhase: input.finalPhase,
          outcome: input.outcome,
          reasonCode: input.reasonCode,
          networkAttempted: input.networkAttempted,
          pagesAttempted: input.pagesAttempted,
          pagesFetched: input.pagesFetched,
          physicalRequestCount: input.physicalRequestCount,
          httpStatus: input.httpStatus,
          details: input.details,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        })
        .where(
          and(
            eq(companyDiscoveryCampaignItems.campaignRunId, campaignRunId),
            eq(companyDiscoveryCampaignItems.sponsorId, input.sponsorId),
            eq(companyDiscoveryCampaignItems.state, 'pending'),
          ),
        )
        .returning({ sponsorId: companyDiscoveryCampaignItems.sponsorId });
      if (updated.length !== 1) {
        throw new Error(`Campaign sponsor ${input.sponsorId} was not updated exactly once`);
      }
      completed += 1;
    }

    const [totals] = await transaction
      .select({
        totalSponsors: sql<number>`count(*)`,
        pendingSponsors: sql<number>`count(*) filter (where ${companyDiscoveryCampaignItems.state} = 'pending')`,
        terminalSponsors: sql<number>`count(*) filter (where ${companyDiscoveryCampaignItems.state} = 'terminal')`,
        networkAttemptedSponsors: sql<number>`count(*) filter (where ${companyDiscoveryCampaignItems.networkAttempted} = true)`,
        pagesAttempted: sql<number>`coalesce(sum(${companyDiscoveryCampaignItems.pagesAttempted}), 0)`,
        pagesFetched: sql<number>`coalesce(sum(${companyDiscoveryCampaignItems.pagesFetched}), 0)`,
        physicalRequestCount: sql<number>`coalesce(sum(${companyDiscoveryCampaignItems.physicalRequestCount}), 0)`,
      })
      .from(companyDiscoveryCampaignItems)
      .where(eq(companyDiscoveryCampaignItems.campaignRunId, campaignRunId));
    const normalizedTotals: ProgressTotals = {
      totalSponsors: numeric(totals?.totalSponsors),
      pendingSponsors: numeric(totals?.pendingSponsors),
      terminalSponsors: numeric(totals?.terminalSponsors),
      networkAttemptedSponsors: numeric(totals?.networkAttemptedSponsors),
      pagesAttempted: numeric(totals?.pagesAttempted),
      pagesFetched: numeric(totals?.pagesFetched),
      physicalRequestCount: numeric(totals?.physicalRequestCount),
    };
    await transaction
      .update(scanRuns)
      .set({
        statistics: {
          ...run.statistics,
          ...statisticsFromTotals(normalizedTotals.totalSponsors, normalizedTotals),
        },
      })
      .where(eq(scanRuns.id, campaignRunId));
    return { completed, unchanged };
  });

  return {
    ...counters,
    progress: await getCompanyDiscoveryCampaignProgress(database, campaignRunId),
  };
}

export async function finalizeCompanyDiscoveryCampaign(
  database: Database,
  campaignRunId: string,
  finishedAt = new Date(),
): Promise<CompanyDiscoveryCampaignProgress> {
  await withTransaction(database, async (transaction) => {
    const [run] = await transaction
      .select({
        command: scanRuns.command,
        status: scanRuns.status,
        finishedAt: scanRuns.finishedAt,
        statistics: scanRuns.statistics,
      })
      .from(scanRuns)
      .where(eq(scanRuns.id, campaignRunId))

      .limit(1);
    if (run?.command !== COMPANY_DISCOVERY_CAMPAIGN_COMMAND) {
      throw new Error(`Company discovery campaign ${campaignRunId} does not exist`);
    }
    if (run.status !== 'running' || run.finishedAt !== null) {
      if (run.finishedAt !== null && (run.status === 'succeeded' || run.status === 'partial')) return;
      throw new Error(`Company discovery campaign ${campaignRunId} cannot be finalized`);
    }
    const [totals] = await transaction
      .select({
        totalSponsors: sql<number>`count(*)`,
        pendingSponsors: sql<number>`count(*) filter (where ${companyDiscoveryCampaignItems.state} = 'pending')`,
        terminalSponsors: sql<number>`count(*) filter (where ${companyDiscoveryCampaignItems.state} = 'terminal')`,
        networkAttemptedSponsors: sql<number>`count(*) filter (where ${companyDiscoveryCampaignItems.networkAttempted} = true)`,
        pagesAttempted: sql<number>`coalesce(sum(${companyDiscoveryCampaignItems.pagesAttempted}), 0)`,
        pagesFetched: sql<number>`coalesce(sum(${companyDiscoveryCampaignItems.pagesFetched}), 0)`,
        physicalRequestCount: sql<number>`coalesce(sum(${companyDiscoveryCampaignItems.physicalRequestCount}), 0)`,
        partialOutcomes: sql<number>`count(*) filter (where ${companyDiscoveryCampaignItems.outcome} in ('needs_domain', 'candidate_ready', 'unsupported', 'blocked', 'manual_review', 'error'))`,
      })
      .from(companyDiscoveryCampaignItems)
      .where(eq(companyDiscoveryCampaignItems.campaignRunId, campaignRunId));
    const normalizedTotals: ProgressTotals = {
      totalSponsors: numeric(totals?.totalSponsors),
      pendingSponsors: numeric(totals?.pendingSponsors),
      terminalSponsors: numeric(totals?.terminalSponsors),
      networkAttemptedSponsors: numeric(totals?.networkAttemptedSponsors),
      pagesAttempted: numeric(totals?.pagesAttempted),
      pagesFetched: numeric(totals?.pagesFetched),
      physicalRequestCount: numeric(totals?.physicalRequestCount),
    };
    if (normalizedTotals.pendingSponsors !== 0) {
      throw new Error(
        `Company discovery campaign ${campaignRunId} still has ${normalizedTotals.pendingSponsors} pending sponsors`,
      );
    }
    const status = numeric(totals?.partialOutcomes) > 0 ? 'partial' : 'succeeded';
    await transaction
      .update(scanRuns)
      .set({
        status,
        finishedAt,
        statistics: {
          ...run.statistics,
          ...statisticsFromTotals(normalizedTotals.totalSponsors, normalizedTotals),
        },
      })
      .where(eq(scanRuns.id, campaignRunId));
  });
  return getCompanyDiscoveryCampaignProgress(database, campaignRunId);
}

export async function listCompanyDiscoveryCampaignItemsForExport(
  database: Database,
  campaignRunId: string,
): Promise<CompanyDiscoveryCampaignExportRow[]> {
  const progress = await getCompanyDiscoveryCampaignProgress(database, campaignRunId);
  const rows = await database
    .select({
      campaignRunId: companyDiscoveryCampaignItems.campaignRunId,
      ordinal: companyDiscoveryCampaignItems.ordinal,
      sponsorId: companyDiscoveryCampaignItems.sponsorId,
      sourceIdentityKey: companyDiscoveryCampaignItems.sourceIdentityKeySnapshot,
      legalName: companyDiscoveryCampaignItems.legalNameSnapshot,
      kvkNumber: companyDiscoveryCampaignItems.kvkNumberSnapshot,
      state: companyDiscoveryCampaignItems.state,
      finalPhase: companyDiscoveryCampaignItems.finalPhase,
      outcome: companyDiscoveryCampaignItems.outcome,
      reasonCode: companyDiscoveryCampaignItems.reasonCode,
      networkAttempted: companyDiscoveryCampaignItems.networkAttempted,
      pagesAttempted: companyDiscoveryCampaignItems.pagesAttempted,
      pagesFetched: companyDiscoveryCampaignItems.pagesFetched,
      physicalRequestCount: companyDiscoveryCampaignItems.physicalRequestCount,
      httpStatus: companyDiscoveryCampaignItems.httpStatus,
      details: companyDiscoveryCampaignItems.details,
      completedAt: companyDiscoveryCampaignItems.completedAt,
      createdAt: companyDiscoveryCampaignItems.createdAt,
      updatedAt: companyDiscoveryCampaignItems.updatedAt,
    })
    .from(companyDiscoveryCampaignItems)
    .where(eq(companyDiscoveryCampaignItems.campaignRunId, campaignRunId))
    .orderBy(asc(companyDiscoveryCampaignItems.ordinal));
  if (rows.length !== progress.totalSponsors) {
    throw new Error(
      `Campaign ${campaignRunId} export mismatch: expected ${progress.totalSponsors}, found ${rows.length}`,
    );
  }
  return rows;
}

export function isPartialCompanyDiscoveryCampaignOutcome(
  outcome: CompanyDiscoveryCampaignOutcome,
): boolean {
  return PARTIAL_OUTCOMES.has(outcome);
}
