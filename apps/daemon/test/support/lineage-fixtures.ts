import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AgentSession, ProviderId } from '@agent-dock/shared';
import type { PersistedLaunchScope, PersistedSessionRecordV1 } from '../../src/persisted-session-schema.js';

/** The one launch scope every fixture uses, so a diff between two records is never about scope. */
export const FIXTURE_SCOPE: PersistedLaunchScope = {
  executablePath: '/usr/local/bin/claude',
  providerVersion: '2.1.228',
  authenticated: 'authenticated',
  platform: 'linux',
  accountEvidence: 'cli_owned',
};

export function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: randomUUID(),
    provider: 'claude',
    cwd: '/workspace',
    prompt: 'do the thing',
    status: 'starting',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

export interface SeedRecordOptions {
  id?: string;
  rootId?: string;
  provider?: ProviderId;
  status?: PersistedSessionRecordV1['session']['status'];
  terminalReason?: PersistedSessionRecordV1['session']['terminalReason'];
  acceptedWork?: 'unknown' | 'accepted';
  startedAt?: string;
  completedAt?: string;
  parentSessionId?: string;
  continuationKind?: 'fresh' | 'resume';
  providerSessionId?: string;
  eventCount?: number;
}

export function makeRecord(options: SeedRecordOptions = {}): PersistedSessionRecordV1 {
  const id = options.id ?? randomUUID();
  const startedAt = options.startedAt ?? new Date().toISOString();
  const status = options.status ?? 'completed';
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    session: {
      id,
      provider: options.provider ?? 'claude',
      cwd: '/workspace',
      status,
      ...(options.terminalReason === undefined ? {} : { terminalReason: options.terminalReason }),
      ...(options.providerSessionId === undefined ? {} : { providerSessionId: options.providerSessionId }),
      startedAt,
      ...(options.completedAt === undefined
        ? status === 'starting' || status === 'running'
          ? {}
          : { completedAt: startedAt }
        : { completedAt: options.completedAt }),
      acceptedWork: options.acceptedWork ?? 'unknown',
      transportId: 'legacy-one-shot',
      rootSessionId: options.rootId ?? id,
      ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
      continuationKind: options.continuationKind ?? 'fresh',
      earliestSequence: 0,
      eventCount: options.eventCount ?? 0,
      eventsTruncated: false,
      scope: FIXTURE_SCOPE,
      unknownFrames: [],
    },
  };
}

/** Writes a record (and optional raw event-log lines) straight to disk, bypassing the store. */
export function seedRecord(
  stateRoot: string,
  record: PersistedSessionRecordV1,
  eventLines: string[] = [],
): void {
  const lineageDir = join(stateRoot, 'sessions-v1', 'lineages', record.session.rootSessionId);
  mkdirSync(join(lineageDir, 'records'), { recursive: true });
  mkdirSync(join(lineageDir, 'events'), { recursive: true });
  writeFileSync(join(lineageDir, 'records', `${record.session.id}.json`), `${JSON.stringify(record)}\n`);
  if (eventLines.length > 0) {
    writeFileSync(join(lineageDir, 'events', `${record.session.id}.jsonl`), `${eventLines.join('\n')}\n`);
  }
}

export function seedManifest(stateRoot: string, value: unknown): void {
  const storeDir = join(stateRoot, 'sessions-v1');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, 'manifest.json'), `${JSON.stringify(value)}\n`);
}

/** One persisted event line, as the store would have written it. */
export function eventLine(sequence: number, type = 'assistant.message'): string {
  return JSON.stringify({
    v: 1,
    sequence,
    timestamp: new Date(2026, 0, 1, 0, 0, sequence).toISOString(),
    type,
    ...(type === 'assistant.message' || type === 'thinking.delta' ? { bytes: 3, sha256: 'a'.repeat(64) } : {}),
    ...(type === 'session.failed' ? { messageBytes: 3, messageSha256: 'a'.repeat(64) } : {}),
    ...(type === 'session.interrupted' ? { reason: 'daemon_restart' } : {}),
  });
}

export interface TreeEntry {
  path: string;
  content: string;
  mtimeMs: number;
}

/** A recursive content+mtime snapshot, used to prove "nothing was touched". */
export function snapshotTree(root: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        out.push({ path: relative(root, full), content: '<dir>', mtimeMs: stats.mtimeMs });
        walk(full);
      } else {
        out.push({ path: relative(root, full), content: readFileSync(full, 'utf8'), mtimeMs: stats.mtimeMs });
      }
    }
  }
  walk(root);
  return out;
}

/** Every file path under `root`, relative, sorted. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  }
  walk(root);
  return out.sort();
}

/** Concatenated contents of every file under `root`. Used by the redaction sentinel sweep. */
export function readAllText(root: string): string {
  return listFiles(root)
    .map((relPath) => readFileSync(join(root, relPath), 'utf8'))
    .join('\n');
}
