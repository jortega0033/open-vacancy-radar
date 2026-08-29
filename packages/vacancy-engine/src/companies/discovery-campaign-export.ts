import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Database } from '../db/client.js';
import {
  getCompanyDiscoveryCampaignProgress,
  listCompanyDiscoveryCampaignItemsForExport,
  type CompanyDiscoveryCampaignExportRow,
  type CompanyDiscoveryCampaignProgress,
} from './discovery-campaign-repository.js';

export type CompanyDiscoveryCampaignExportFiles = {
  outputDirectory: string;
  ndjson: string;
  csv: string;
  summary: string;
};

export type WriteCompanyDiscoveryCampaignExportResult = {
  files: CompanyDiscoveryCampaignExportFiles;
  progress: CompanyDiscoveryCampaignProgress;
  exportedRows: number;
};

export type WriteCompanyDiscoveryCampaignExportOptions = {
  projectRoot?: string;
  outputDirectory?: string;
  generatedAt?: Date;
};

type SerializableCampaignRow = Omit<
  CompanyDiscoveryCampaignExportRow,
  | 'completedAt'
  | 'createdAt'
  | 'updatedAt'
  | 'networkAttempted'
  | 'pagesAttempted'
  | 'pagesFetched'
  | 'physicalRequestCount'
> & {
  siteInspectionAttempted: boolean;
  sitePagesAttempted: number;
  sitePagesFetched: number;
  sitePhysicalRequestCount: number;
  sourceScanOutcomeRecorded: boolean;
  sourceScanNetworkAttempted: boolean;
  sourceScanRequestCount: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const CSV_HEADERS = [
  'campaignRunId',
  'ordinal',
  'sponsorId',
  'sourceIdentityKey',
  'legalName',
  'kvkNumber',
  'state',
  'finalPhase',
  'outcome',
  'reasonCode',
  'siteInspectionAttempted',
  'sitePagesAttempted',
  'sitePagesFetched',
  'sitePhysicalRequestCount',
  'sourceScanOutcomeRecorded',
  'sourceScanNetworkAttempted',
  'sourceScanRequestCount',
  'httpStatus',
  'completedAt',
  'createdAt',
  'updatedAt',
  'details',
] as const;

function sourceScanAudit(details: Record<string, unknown>): {
  outcomeRecorded: boolean;
  requestCount: number;
} {
  const sources = details.sources;
  if (!Array.isArray(sources)) return { outcomeRecorded: false, requestCount: 0 };
  let outcomeRecorded = false;
  let requestCount = 0;
  for (const value of sources) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const sourceOutcome = (value as Record<string, unknown>).sourceOutcome;
    if (typeof sourceOutcome !== 'object' || sourceOutcome === null || Array.isArray(sourceOutcome)) {
      continue;
    }
    outcomeRecorded = true;
    const rawRequestCount = (sourceOutcome as Record<string, unknown>).requestCount;
    if (typeof rawRequestCount === 'number' && Number.isInteger(rawRequestCount) && rawRequestCount > 0) {
      requestCount += rawRequestCount;
    }
  }
  return { outcomeRecorded, requestCount };
}

function serializableRow(row: CompanyDiscoveryCampaignExportRow): SerializableCampaignRow {
  const {
    networkAttempted,
    pagesAttempted,
    pagesFetched,
    physicalRequestCount,
    ...rest
  } = row;
  const sourceScan = sourceScanAudit(row.details);
  return {
    ...rest,
    siteInspectionAttempted: networkAttempted,
    sitePagesAttempted: pagesAttempted,
    sitePagesFetched: pagesFetched,
    sitePhysicalRequestCount: physicalRequestCount,
    sourceScanOutcomeRecorded: sourceScan.outcomeRecorded,
    sourceScanNetworkAttempted: sourceScan.requestCount > 0,
    sourceScanRequestCount: sourceScan.requestCount,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'boolean') text = value ? 'true' : 'false';
  else if (typeof value === 'object') text = JSON.stringify(value);
  else if (typeof value === 'symbol') text = value.description ?? '';
  else text = '';
  if (/^\s*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializeCompanyDiscoveryCampaignNdjson(
  rows: readonly CompanyDiscoveryCampaignExportRow[],
): string {
  if (rows.length === 0) return '';
  return `${rows.map((row) => JSON.stringify(serializableRow(row))).join('\n')}\n`;
}

export function serializeCompanyDiscoveryCampaignCsv(
  rows: readonly CompanyDiscoveryCampaignExportRow[],
): string {
  const lines = [CSV_HEADERS.map((header) => csvCell(header)).join(',')];
  for (const rawRow of rows) {
    const row = serializableRow(rawRow);
    lines.push(
      [
        row.campaignRunId,
        row.ordinal,
        row.sponsorId,
        row.sourceIdentityKey,
        row.legalName,
        row.kvkNumber,
        row.state,
        row.finalPhase,
        row.outcome,
        row.reasonCode,
        row.siteInspectionAttempted,
        row.sitePagesAttempted,
        row.sitePagesFetched,
        row.sitePhysicalRequestCount,
        row.sourceScanOutcomeRecorded,
        row.sourceScanNetworkAttempted,
        row.sourceScanRequestCount,
        row.httpStatus,
        row.completedAt,
        row.createdAt,
        row.updatedAt,
        row.details,
      ]
        .map((value) => csvCell(value))
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function serializeCompanyDiscoveryCampaignSummary(
  progress: CompanyDiscoveryCampaignProgress,
  exportedRows: number,
  generatedAt = new Date(),
): string {
  return `${JSON.stringify(
    {
      generatedAt: generatedAt.toISOString(),
      exportedRows,
      ...progress,
      startedAt: progress.startedAt.toISOString(),
      finishedAt: progress.finishedAt?.toISOString() ?? null,
    },
    null,
    2,
  )}\n`;
}

function safeOutputDirectory(
  projectRoot: string,
  campaignRunId: string,
  requestedOutputDirectory: string | undefined,
): string {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedOutput = path.resolve(
    resolvedRoot,
    requestedOutputDirectory ?? path.join('reports', 'company-discovery', campaignRunId),
  );
  const relative = path.relative(resolvedRoot, resolvedOutput);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Company discovery export must remain inside the project');
  }
  return resolvedOutput;
}

/** Writes three individually atomic snapshots; summary is published last. */
export async function writeCompanyDiscoveryCampaignExportSnapshot(
  progress: CompanyDiscoveryCampaignProgress,
  rows: readonly CompanyDiscoveryCampaignExportRow[],
  options: WriteCompanyDiscoveryCampaignExportOptions = {},
): Promise<WriteCompanyDiscoveryCampaignExportResult> {
  if (progress.pendingSponsors !== 0 || progress.finishedAt === null) {
    throw new Error('Company discovery campaign must be finalized before export');
  }
  if (rows.length !== progress.totalSponsors) {
    throw new Error(
      `Campaign ${progress.campaignRunId} export mismatch: expected ${progress.totalSponsors}, found ${rows.length}`,
    );
  }
  rows.forEach((row, index) => {
    if (row.campaignRunId !== progress.campaignRunId || row.ordinal !== index + 1) {
      throw new Error('Campaign export rows must use the campaign id and contiguous stable ordinals');
    }
  });

  const projectRoot = options.projectRoot ?? process.cwd();
  const outputDirectory = safeOutputDirectory(
    projectRoot,
    progress.campaignRunId,
    options.outputDirectory,
  );
  await mkdir(outputDirectory, { recursive: true });
  const files = {
    outputDirectory,
    ndjson: path.join(outputDirectory, 'outcomes.ndjson'),
    csv: path.join(outputDirectory, 'outcomes.csv'),
    summary: path.join(outputDirectory, 'summary.json'),
  } satisfies CompanyDiscoveryCampaignExportFiles;
  const suffix = `.tmp-${process.pid}-${randomUUID()}`;
  const temporaryFiles = {
    ndjson: `${files.ndjson}${suffix}`,
    csv: `${files.csv}${suffix}`,
    summary: `${files.summary}${suffix}`,
  };
  try {
    await Promise.all([
      writeFile(temporaryFiles.ndjson, serializeCompanyDiscoveryCampaignNdjson(rows), 'utf8'),
      writeFile(temporaryFiles.csv, serializeCompanyDiscoveryCampaignCsv(rows), 'utf8'),
      writeFile(
        temporaryFiles.summary,
        serializeCompanyDiscoveryCampaignSummary(
          progress,
          rows.length,
          options.generatedAt,
        ),
        'utf8',
      ),
    ]);
    await rename(temporaryFiles.ndjson, files.ndjson);
    await rename(temporaryFiles.csv, files.csv);
    await rename(temporaryFiles.summary, files.summary);
  } finally {
    await Promise.all(Object.values(temporaryFiles).map((file) => rm(file, { force: true })));
  }
  return { files, progress, exportedRows: rows.length };
}

export async function writeCompanyDiscoveryCampaignExport(
  database: Database,
  campaignRunId: string,
  options: WriteCompanyDiscoveryCampaignExportOptions = {},
): Promise<WriteCompanyDiscoveryCampaignExportResult> {
  const progress = await getCompanyDiscoveryCampaignProgress(database, campaignRunId);
  if (progress.pendingSponsors !== 0 || progress.finishedAt === null) {
    throw new Error('Company discovery campaign must be finalized before export');
  }
  const rows = await listCompanyDiscoveryCampaignItemsForExport(database, campaignRunId);
  return writeCompanyDiscoveryCampaignExportSnapshot(progress, rows, options);
}
