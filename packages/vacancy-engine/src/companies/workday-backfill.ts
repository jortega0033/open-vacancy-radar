import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { detectWorkdaySource } from '../ats/detection.js';
import { safeErrorClassification } from '../crawler/errors.js';
import { withTransaction, type Database } from '../db/client.js';
import {
  companyDiscoveryAttempts,
  indSponsors,
  sponsorDiscovery,
} from '../db/schema.js';
import { finishOperationalRun, recordScanError, startScanRun } from '../scans/repository.js';
import {
  canonicalizeSupportedDiscoverySource,
  promoteDiscoveredCareerSources,
  validatePromotionProvenance,
  type DiscoveryPromotionResult,
  type PromotionDiscoveryState,
} from './discovery-promotion.js';

export const MAX_WORKDAY_BACKFILL_BATCH_SIZE = 50;
export const WORKDAY_EVIDENCE_RECLASSIFICATION_POLICY_VERSION =
  'workday-evidence-reclassification-v1';

const WORKDAY_BACKFILL_COMMAND = 'companies:workday:backfill';
const RECLASSIFICATION_DIAGNOSTIC =
  'Workday source reclassified from preserved official-site evidence without a network request';

type CandidateRow = {
  sponsorId: string;
  legalName: string;
  officialUrl: string | null;
  officialHostname: string | null;
  candidateSource: string | null;
  candidateVersion: string | null;
  candidateHash: string | null;
  candidateVerifiedAt: Date | null;
  confidence: PromotionDiscoveryState['confidence'];
  brandName: string | null;
  careersUrl: string | null;
  provider: string | null;
};

type AttemptRow = {
  id: string;
  outcome: string;
  officialUrl: string;
  candidateSource: string;
  candidateVersion: string;
  candidateHash: string;
  inspectionPolicyVersion: string;
  pagesInspected: number;
  physicalRequestCount: number;
  result: Record<string, unknown>;
  createdAt: Date;
};

export type WorkdayEvidenceReclassification = {
  selected: number;
  reclassified: number;
  alreadyReclassified: number;
  changedBeforeLock: number;
  failed: number;
  sponsorIds: string[];
  failureSponsorIds: string[];
};

export type WorkdayEvidenceBackfillResult = {
  scanRunId: string;
  reclassification: WorkdayEvidenceReclassification;
  promotion: DiscoveryPromotionResult;
};

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredText(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} is missing ${key}`);
  }
  return value.trim();
}

function equivalentUrl(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString();
  } catch {
    return false;
  }
}

function promotionState(row: CandidateRow): PromotionDiscoveryState {
  if (
    row.officialUrl === null ||
    row.officialHostname === null ||
    row.candidateSource === null ||
    row.candidateVersion === null ||
    row.candidateHash === null ||
    row.candidateVerifiedAt === null ||
    row.brandName === null ||
    row.careersUrl === null ||
    row.provider !== 'workday'
  ) {
    throw new Error(`Unsupported Workday row ${row.sponsorId} violates its trusted candidate contract`);
  }
  const detected = detectWorkdaySource(row.careersUrl);
  if (detected === null) {
    throw new Error(`Unsupported Workday row ${row.sponsorId} does not identify an exact public board`);
  }
  return {
    sponsorId: row.sponsorId,
    officialUrl: row.officialUrl,
    officialHostname: row.officialHostname,
    candidateSource: row.candidateSource,
    candidateVersion: row.candidateVersion,
    candidateHash: row.candidateHash,
    candidateVerifiedAt: row.candidateVerifiedAt,
    confidence: row.confidence,
    brandName: row.brandName,
    careersUrl: row.careersUrl,
    provider: 'workday',
    sourceBaseUrl: detected.baseUrl,
    boardIdentifier: detected.boardIdentifier,
  };
}

function isDerivedAttempt(attempt: AttemptRow): boolean {
  const reclassification = recordOrNull(attempt.result.reclassification);
  return (
    attempt.outcome === 'careers_found' &&
    reclassification?.policyVersion === WORKDAY_EVIDENCE_RECLASSIFICATION_POLICY_VERSION
  );
}

export function deriveWorkdayCareersFoundEvidence(
  row: CandidateRow,
  sourceAttempt: AttemptRow,
): {
  state: PromotionDiscoveryState;
  result: Record<string, unknown>;
} {
  const state = promotionState(row);
  if (
    sourceAttempt.outcome !== 'unsupported' ||
    sourceAttempt.officialUrl !== state.officialUrl ||
    sourceAttempt.candidateSource !== state.candidateSource ||
    sourceAttempt.candidateVersion !== state.candidateVersion ||
    sourceAttempt.candidateHash !== state.candidateHash
  ) {
    throw new Error(`Latest evidence for sponsor ${row.sponsorId} is not its matching unsupported attempt`);
  }

  const sourceResult = sourceAttempt.result;
  if (
    sourceResult.status !== 'unsupported' ||
    sourceResult.provider !== 'workday' ||
    !equivalentUrl(requiredText(sourceResult, 'careersUrl', 'Unsupported result'), state.careersUrl)
  ) {
    throw new Error(`Unsupported evidence for sponsor ${row.sponsorId} is not a Workday observation`);
  }
  if (!Array.isArray(sourceResult.observations) || sourceResult.observations.length === 0) {
    throw new Error(`Unsupported evidence for sponsor ${row.sponsorId} has no URL-bearing observations`);
  }

  const officialOrigin = new URL(state.officialUrl).origin;
  const expectedCanonical = canonicalizeSupportedDiscoverySource({
    provider: 'workday',
    careersUrl: state.careersUrl,
    boardIdentifier: state.boardIdentifier,
  });
  const observations = sourceResult.observations.map((value) => {
    const observation = recordOrNull(value);
    if (observation?.provider !== 'workday') {
      throw new Error(`Unsupported evidence for sponsor ${row.sponsorId} contains a non-Workday observation`);
    }
    const observedUrl = requiredText(observation, 'observedUrl', 'Workday observation');
    const observedOnPage = requiredText(observation, 'observedOnPage', 'Workday observation');
    let observedPage: URL;
    try {
      observedPage = new URL(observedOnPage);
    } catch {
      throw new Error(`Workday observation for sponsor ${row.sponsorId} has an invalid source page`);
    }
    if (observedPage.origin !== officialOrigin) {
      throw new Error(`Workday observation for sponsor ${row.sponsorId} is not from its official origin`);
    }
    const detected = detectWorkdaySource(observedUrl);
    if (detected === null) {
      throw new Error(`Workday observation for sponsor ${row.sponsorId} is not an exact public board URL`);
    }
    const observedCanonical = canonicalizeSupportedDiscoverySource({
      provider: 'workday',
      careersUrl: observedUrl,
      boardIdentifier: detected.boardIdentifier,
    });
    if (observedCanonical.canonicalKey !== expectedCanonical.canonicalKey) {
      throw new Error(`Workday evidence for sponsor ${row.sponsorId} contains conflicting board identities`);
    }
    return {
      ...observation,
      provider: 'workday',
      sourceBaseUrl: detected.baseUrl,
      boardIdentifier: detected.boardIdentifier,
    };
  });

  const result = {
    ...sourceResult,
    status: 'careers_found',
    provider: 'workday',
    careersUrl: state.careersUrl,
    sourceBaseUrl: state.sourceBaseUrl,
    boardIdentifier: state.boardIdentifier,
    pagesInspected: 0,
    observations,
    reclassification: {
      policyVersion: WORKDAY_EVIDENCE_RECLASSIFICATION_POLICY_VERSION,
      sourceAttemptId: sourceAttempt.id,
      sourceInspectionPolicyVersion: sourceAttempt.inspectionPolicyVersion,
      sourceAttemptCreatedAt: sourceAttempt.createdAt.toISOString(),
      sourcePagesInspected: sourceAttempt.pagesInspected,
      sourcePhysicalRequestCount: sourceAttempt.physicalRequestCount,
      networkRequested: false,
    },
  } satisfies Record<string, unknown>;

  validatePromotionProvenance(state, {
    id: sourceAttempt.id,
    outcome: 'careers_found',
    officialUrl: sourceAttempt.officialUrl,
    candidateSource: sourceAttempt.candidateSource,
    candidateVersion: sourceAttempt.candidateVersion,
    candidateHash: sourceAttempt.candidateHash,
    result,
  });
  return { state, result };
}

async function reclassifyUnsupportedWorkdayDiscoveries(
  database: Database,
  scanRunId: string,
  limit: number,
  now: Date,
  logger: Logger,
): Promise<WorkdayEvidenceReclassification> {
  const rows: CandidateRow[] = await database
    .select({
      sponsorId: sponsorDiscovery.sponsorId,
      legalName: indSponsors.legalName,
      officialUrl: sponsorDiscovery.officialUrl,
      officialHostname: sponsorDiscovery.officialHostname,
      candidateSource: sponsorDiscovery.candidateSource,
      candidateVersion: sponsorDiscovery.candidateVersion,
      candidateHash: sponsorDiscovery.candidateHash,
      candidateVerifiedAt: sponsorDiscovery.candidateVerifiedAt,
      confidence: sponsorDiscovery.confidence,
      brandName: sponsorDiscovery.brandName,
      careersUrl: sponsorDiscovery.careersUrl,
      provider: sponsorDiscovery.provider,
    })
    .from(sponsorDiscovery)
    .innerJoin(
      indSponsors,
      and(eq(indSponsors.id, sponsorDiscovery.sponsorId), eq(indSponsors.active, true)),
    )
    .where(and(eq(sponsorDiscovery.status, 'unsupported'), eq(sponsorDiscovery.provider, 'workday')))
    .orderBy(asc(sponsorDiscovery.sponsorId))
    .limit(limit);

  const result: WorkdayEvidenceReclassification = {
    selected: rows.length,
    reclassified: 0,
    alreadyReclassified: 0,
    changedBeforeLock: 0,
    failed: 0,
    sponsorIds: [],
    failureSponsorIds: [],
  };
  for (const selectedRow of rows) {
    try {
      const disposition = await withTransaction(database, async (transaction) => {
        const [row] = await transaction
          .select({
            sponsorId: sponsorDiscovery.sponsorId,
            legalName: indSponsors.legalName,
            officialUrl: sponsorDiscovery.officialUrl,
            officialHostname: sponsorDiscovery.officialHostname,
            candidateSource: sponsorDiscovery.candidateSource,
            candidateVersion: sponsorDiscovery.candidateVersion,
            candidateHash: sponsorDiscovery.candidateHash,
            candidateVerifiedAt: sponsorDiscovery.candidateVerifiedAt,
            confidence: sponsorDiscovery.confidence,
            brandName: sponsorDiscovery.brandName,
            careersUrl: sponsorDiscovery.careersUrl,
            provider: sponsorDiscovery.provider,
          })
          .from(sponsorDiscovery)
          .innerJoin(
            indSponsors,
            and(eq(indSponsors.id, sponsorDiscovery.sponsorId), eq(indSponsors.active, true)),
          )
          .where(
            and(
              eq(sponsorDiscovery.sponsorId, selectedRow.sponsorId),
              eq(sponsorDiscovery.status, 'unsupported'),
              eq(sponsorDiscovery.provider, 'workday'),
            ),
          )

          .limit(1);
        if (row === undefined) return 'changed' as const;

        const [latestAttempt] = await transaction
          .select({
            id: companyDiscoveryAttempts.id,
            outcome: companyDiscoveryAttempts.outcome,
            officialUrl: companyDiscoveryAttempts.officialUrl,
            candidateSource: companyDiscoveryAttempts.candidateSource,
            candidateVersion: companyDiscoveryAttempts.candidateVersion,
            candidateHash: companyDiscoveryAttempts.candidateHash,
            inspectionPolicyVersion: companyDiscoveryAttempts.inspectionPolicyVersion,
            pagesInspected: companyDiscoveryAttempts.pagesInspected,
            physicalRequestCount: companyDiscoveryAttempts.physicalRequestCount,
            result: companyDiscoveryAttempts.result,
            createdAt: companyDiscoveryAttempts.createdAt,
          })
          .from(companyDiscoveryAttempts)
          .where(eq(companyDiscoveryAttempts.sponsorId, row.sponsorId))
          .orderBy(desc(companyDiscoveryAttempts.createdAt), desc(companyDiscoveryAttempts.id))
          .limit(1);
        if (latestAttempt === undefined) {
          throw new Error(`Unsupported Workday row ${row.sponsorId} has no append-only inspection evidence`);
        }
        if (isDerivedAttempt(latestAttempt)) {
          return 'already_reclassified' as const;
        }

        const derived = deriveWorkdayCareersFoundEvidence(row, latestAttempt);
        await transaction.insert(companyDiscoveryAttempts).values({
          scanRunId,
          sponsorId: row.sponsorId,
          officialUrl: derived.state.officialUrl,
          candidateSource: derived.state.candidateSource,
          candidateVersion: derived.state.candidateVersion,
          candidateHash: derived.state.candidateHash,
          inspectionPolicyVersion: WORKDAY_EVIDENCE_RECLASSIFICATION_POLICY_VERSION,
          outcome: 'careers_found',
          pagesInspected: 0,
          physicalRequestCount: 0,
          durationMs: 0,
          httpStatus: null,
          category: 'evidence_reclassification',
          diagnostic: RECLASSIFICATION_DIAGNOSTIC,
          result: derived.result,
          createdAt: now,
        });
        const updated = await transaction
          .update(sponsorDiscovery)
          .set({
            status: 'careers_found',
            sourceBaseUrl: derived.state.sourceBaseUrl,
            boardIdentifier: derived.state.boardIdentifier,
            diagnostic: RECLASSIFICATION_DIAGNOSTIC,
            attemptCount: sql`${sponsorDiscovery.attemptCount} + 1`,
            lastAttemptAt: now,
            nextCheckAt: null,
            lastHttpStatus: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(sponsorDiscovery.sponsorId, row.sponsorId),
              eq(sponsorDiscovery.status, 'unsupported'),
              eq(sponsorDiscovery.provider, 'workday'),
              eq(sponsorDiscovery.candidateHash, derived.state.candidateHash),
            ),
          )
          .returning({ sponsorId: sponsorDiscovery.sponsorId });
        if (updated.length !== 1) {
          throw new Error(`Workday discovery row ${row.sponsorId} changed during reclassification`);
        }
        return 'reclassified' as const;
      });
      if (disposition === 'reclassified') {
        result.reclassified += 1;
        result.sponsorIds.push(selectedRow.sponsorId);
      } else if (disposition === 'already_reclassified') {
        result.alreadyReclassified += 1;
      } else {
        result.changedBeforeLock += 1;
      }
    } catch (error) {
      result.failed += 1;
      result.failureSponsorIds.push(selectedRow.sponsorId);
      const classification = safeErrorClassification(error);
      logger.warn(
        { sponsorId: selectedRow.sponsorId, ...classification },
        'Preserved Workday evidence could not be reclassified; continuing',
      );
      try {
        await recordScanError(database, {
          scanRunId,
          category: 'company_mapping_error',
          message: `Workday evidence could not be reclassified (${classification.errorType})`,
          context: {
            stage: 'workday_evidence_reclassification',
            sponsorId: selectedRow.sponsorId,
            reason: error instanceof Error ? error.message : 'Unknown reclassification failure',
            policyVersion: WORKDAY_EVIDENCE_RECLASSIFICATION_POLICY_VERSION,
          },
        });
      } catch (recordError) {
        logger.warn(
          { sponsorId: selectedRow.sponsorId, ...safeErrorClassification(recordError) },
          'Per-sponsor Workday backfill failure could not be recorded',
        );
      }
    }
  }
  return result;
}

export async function runWorkdayEvidenceBackfill(
  database: Database,
  logger: Logger,
  options: { limit?: number; now?: Date } = {},
): Promise<WorkdayEvidenceBackfillResult> {
  const limit = options.limit ?? MAX_WORKDAY_BACKFILL_BATCH_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WORKDAY_BACKFILL_BATCH_SIZE) {
    throw new RangeError(
      `Workday backfill limit must be an integer from 1 through ${MAX_WORKDAY_BACKFILL_BATCH_SIZE}`,
    );
  }
  const now = options.now ?? new Date();
  const scanRunId = await startScanRun(database, WORKDAY_BACKFILL_COMMAND, false);
  let reclassification: WorkdayEvidenceReclassification = {
    selected: 0,
    reclassified: 0,
    alreadyReclassified: 0,
    changedBeforeLock: 0,
    failed: 0,
    sponsorIds: [],
    failureSponsorIds: [],
  };
  try {
    reclassification = await reclassifyUnsupportedWorkdayDiscoveries(
      database,
      scanRunId,
      limit,
      now,
      logger,
    );
    const promotion = await promoteDiscoveredCareerSources(database, logger, {
      limit,
      now,
      provider: 'workday',
    });
    const promotionFailures =
      promotion.errors +
      promotion.skippedUnsupported +
      promotion.skippedStale +
      promotion.skippedManualReview;
    await finishOperationalRun(
      database,
      scanRunId,
      reclassification.failed === 0 &&
        reclassification.changedBeforeLock === 0 &&
        promotionFailures === 0
        ? 'succeeded'
        : 'partial',
      {
        selected: reclassification.selected,
        reclassified: reclassification.reclassified,
        alreadyReclassified: reclassification.alreadyReclassified,
        changedBeforeLock: reclassification.changedBeforeLock,
        reclassificationFailures: reclassification.failed,
        promotionExamined: promotion.examined,
        promoted: promotion.promoted,
        promotionFailures,
        requestCount: 0,
      },
    );
    return { scanRunId, reclassification, promotion };
  } catch (error) {
    const classification = safeErrorClassification(error);
    try {
      await recordScanError(database, {
        scanRunId,
        category: 'company_mapping_error',
        message: `Workday evidence backfill failed (${classification.errorType})`,
        context: {
          stage: 'workday_evidence_reclassification',
          policyVersion: WORKDAY_EVIDENCE_RECLASSIFICATION_POLICY_VERSION,
        },
      });
    } catch (recordError) {
      logger.warn(
        { ...safeErrorClassification(recordError), scanRunId },
        'Workday backfill failure could not be recorded',
      );
    }
    await finishOperationalRun(database, scanRunId, 'failed', {
      selected: reclassification.selected,
      reclassified: reclassification.reclassified,
      alreadyReclassified: reclassification.alreadyReclassified,
      changedBeforeLock: reclassification.changedBeforeLock,
      reclassificationFailures: reclassification.failed,
      errorCount: 1,
      requestCount: 0,
    });
    throw error;
  }
}
