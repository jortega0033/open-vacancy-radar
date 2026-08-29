import { eq } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { scanErrors, scanRuns, scanSourceOutcomes } from '../db/schema.js';
import type { ScanErrorCategory } from '../domain/models.js';
import type { ReportStatistics } from '../reporting/report.js';

export type ScanStatus = 'succeeded' | 'partial' | 'failed';

export type RecordScanErrorInput = {
  scanRunId?: string;
  companyId?: string;
  careerSourceId?: string;
  category: ScanErrorCategory;
  message: string;
  httpStatus?: number;
  context?: Record<string, unknown>;
};

const sensitiveKeyPattern = /api[-_]?key|authorization|cookie|credential|password|secret|token/iu;

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveKeyPattern.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString();
  } catch {
    return value;
  }
}

function sanitizeDiagnosticString(value: string): string {
  const secretsRedacted = value
    .replace(
      /((?:api[-_]?key|authorization|cookie|credential|password|secret|token)\s*[:=]\s*)([^\s,;&]+)/giu,
      '$1[REDACTED]',
    )
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]');
  return secretsRedacted.replace(/https?:\/\/[^\s"'<>]+/giu, (match) => redactUrl(match));
}

function sanitizeDiagnosticValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeDiagnosticString(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeDiagnosticValue(entry));
  if (value && typeof value === 'object') {
    return sanitizeDiagnosticContext(value as Record<string, unknown>);
  }
  return value;
}

export function sanitizeDiagnosticContext(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => {
      if (sensitiveKeyPattern.test(key)) return [key, '[REDACTED]'];
      return [key, sanitizeDiagnosticValue(value)];
    }),
  );
}

export async function startScanRun(database: Database, command: string, aiEnabled: boolean): Promise<string> {
  const [run] = await database
    .insert(scanRuns)
    .values({ command, aiEnabled, status: 'running' })
    .returning({ id: scanRuns.id });
  if (!run) throw new Error('Scan run insert did not return an id');
  return run.id;
}

export async function finishScanRun(
  database: Database,
  scanRunId: string,
  status: ScanStatus,
  statistics: ReportStatistics,
): Promise<void> {
  await finishOperationalRun(database, scanRunId, status, statistics);
}

/** Finalizes non-report operational runs whose counters are command-specific. */
export async function finishOperationalRun(
  database: Database,
  scanRunId: string,
  status: ScanStatus,
  statistics: Record<string, number>,
): Promise<void> {
  await database
    .update(scanRuns)
    .set({ status, statistics, finishedAt: new Date() })
    .where(eq(scanRuns.id, scanRunId));
}

export async function recordScanError(database: Database, input: RecordScanErrorInput): Promise<void> {
  await database.insert(scanErrors).values({
    ...(input.scanRunId ? { scanRunId: input.scanRunId } : {}),
    ...(input.companyId ? { companyId: input.companyId } : {}),
    ...(input.careerSourceId ? { careerSourceId: input.careerSourceId } : {}),
    category: input.category,
    message: sanitizeDiagnosticString(input.message).slice(0, 4000),
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    context: sanitizeDiagnosticContext(input.context ?? {}),
  });
}

export async function recordSourceOutcome(
  database: Database,
  input: {
    scanRunId: string;
    careerSourceId: string;
    status: 'succeeded' | 'blocked' | 'manual_review' | 'unsupported' | 'failed';
    complete: boolean;
    vacanciesSeen: number;
    requestCount: number;
    durationMs: number;
  },
): Promise<void> {
  await database
    .insert(scanSourceOutcomes)
    .values(input)
    .onConflictDoUpdate({
      target: [scanSourceOutcomes.scanRunId, scanSourceOutcomes.careerSourceId],
      set: {
        status: input.status,
        complete: input.complete,
        vacanciesSeen: input.vacanciesSeen,
        requestCount: input.requestCount,
        durationMs: input.durationMs,
      },
    });
}
