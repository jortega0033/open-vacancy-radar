import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuthStatus } from '@agent-dock/shared';
import { appendDurably } from '../durable-store/atomic-fs.js';
import type { LiveSmokeEvidenceRecord, LiveSmokeResultCode, LiveSmokeTransportId } from './types.js';

/** Mirrors `ProviderStatus.authenticated`'s own three-value union (`provider.ts`) -- this repo has
 * no separate exported list of them to import, so it's named here once and reused by the
 * validation below rather than repeating the three literals inline. */
const KNOWN_AUTH_STATUSES: ReadonlySet<AuthStatus> = new Set(['authenticated', 'unauthenticated', 'unknown']);

/**
 * Requires at least a `major.minor` numeric shape before any suffix -- every real pinned version
 * in `compatibility-manifest.ts` looks like this (`2.1.228`, `0.147.0`). Deliberately tighter than
 * "any CLI-output-shaped token": a detector bug that captures an error string or an account-ish
 * identifier (`claude_user_123`, `api-key-abcd`) starts with a letter, not a digit, so it's
 * rejected here rather than recorded as if it were a real version. The optional pre-release/build
 * suffix (`-beta.1`, `+a1b2c3d`) is capped at 16 characters -- long enough for a real semver tag or
 * short git-describe suffix, short enough that this can't become a channel for smuggling a
 * secret-shaped token past the redaction boundary this function exists to enforce.
 */
const VERSION_PATTERN = /^\d+(\.\d+){1,3}([-+][A-Za-z0-9.]{1,16})?$/;

export class LiveSmokeRedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveSmokeRedactionError';
  }
}

export interface BuildEvidenceRecordInput {
  commit: string;
  os: NodeJS.Platform;
  provider: LiveSmokeEvidenceRecord['provider'];
  transport: LiveSmokeTransportId;
  providerVersion: string | undefined;
  authStatus: AuthStatus;
  resultCode: LiveSmokeResultCode;
  durationMs: number;
  now?: () => Date;
}

/**
 * The one place a smoke case's result becomes a publishable evidence row. Every field is
 * validated against a narrow, safe shape before it's accepted -- this is the redaction boundary
 * ADI-19 requires ("no credential, account identifier, raw prompt/output, or private path"),
 * enforced structurally rather than by convention: a caller cannot smuggle free text through any
 * field here, even by bypassing TypeScript with `as`.
 */
export function buildEvidenceRecord(input: BuildEvidenceRecordInput): LiveSmokeEvidenceRecord {
  if (!/^[0-9a-f]{7,40}$/i.test(input.commit)) {
    throw new LiveSmokeRedactionError('commit does not look like a git SHA, refusing to record it verbatim');
  }
  if (input.providerVersion !== undefined && !VERSION_PATTERN.test(input.providerVersion)) {
    throw new LiveSmokeRedactionError('providerVersion does not look like a version string, refusing to record it verbatim');
  }
  if (!KNOWN_AUTH_STATUSES.has(input.authStatus)) {
    throw new LiveSmokeRedactionError('unknown auth status, refusing to record it verbatim');
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new LiveSmokeRedactionError('durationMs must be a non-negative finite number');
  }
  const timestamp = (input.now?.() ?? new Date()).toISOString();
  return {
    schemaVersion: 1,
    commit: input.commit,
    os: input.os,
    provider: input.provider,
    transport: input.transport,
    providerVersion: input.providerVersion,
    authStatus: input.authStatus,
    resultCode: input.resultCode,
    durationMs: input.durationMs,
    timestamp,
  };
}

/**
 * Durable, append-only JSONL evidence log. Reuses `appendDurably` (durable-store/atomic-fs.ts) --
 * the same short-write-safe, `O_NOFOLLOW`-guarded, fsync-before-return primitive `AuditStore` is
 * built on -- rather than a second, weaker hand-rolled version of the same discipline. Being
 * synchronous under the hood also means two calls from this process can never interleave their
 * writes, even if a future change parallelizes the smoke cases that call this.
 */
export async function appendEvidenceRecord(filePath: string, record: LiveSmokeEvidenceRecord): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  appendDurably(filePath, JSON.stringify(record));
}
