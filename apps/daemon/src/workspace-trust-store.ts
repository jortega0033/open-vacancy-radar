import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Logger } from '@agent-dock/agent-runtime';
import {
  providerIdSchema,
  workspaceDigestSchema,
  workspaceTrustStateSchema,
  type WorkspaceTrustState,
} from '@agent-dock/shared';
import { atomicWriteJson, quarantine } from './durable-store/atomic-fs.js';
import type { WorkspaceIdentity } from './workspace-identity.js';

/**
 * Which workspaces the user has approved, and at which incarnation.
 *
 * Ported in shape from upstream AgentDock's trust store (the `trusted`/`untrusted`/`revoking` state
 * set, the serialized-write discipline), with two substitutions this repo already had better answers
 * for: persistence goes through ADI-05's `atomicWriteJson` (temp-write, fsync, rename, fsync-parent)
 * instead of upstream's hand-rolled writer, and the state root comes from this repo's synchronous
 * `resolveStateDirectory` rather than upstream's async `ensureStateDirectory`.
 *
 * ## What is stored, and what deliberately is not
 *
 * A record is `{ workspaceId, incarnation, state, provider, updatedAt }`: two digests, an enum, a
 * provider id, and a timestamp. **No path.** ADI-05's "no content on disk" rule applies here for the
 * same reason it applies to session records: a directory path is the user's data (a project name, a
 * client name, an employer name), and a store that does not hold one cannot leak one. The
 * consequence is that this store cannot revalidate an identity by itself -- a caller must supply the
 * path it wants checked, which is exactly what `SessionManager.workspaceIsTrusted` requires.
 *
 * ## `incarnation` is part of the trust decision, not decoration
 *
 * Trust is keyed on `workspaceId`, but a record also pins the `incarnation` it was granted for. A
 * Git-keyed `workspaceId` covers a whole repository, so without the incarnation, approving
 * `repo/packages/a` would silently approve `repo/packages/b`. `matches()` requires both.
 */

const STORE_DIR = 'workspace-trust';
const TRUST_FILE = 'trust.json';
const QUARANTINE_DIR = 'quarantine';

const trustRecordSchema = z
  .object({
    workspaceId: workspaceDigestSchema,
    incarnation: workspaceDigestSchema,
    state: workspaceTrustStateSchema,
    provider: providerIdSchema,
    updatedAt: z.string().min(1).max(64),
  })
  .strict();

export type WorkspaceTrustRecord = z.infer<typeof trustRecordSchema>;

const trustFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaces: z.array(trustRecordSchema).max(10_000),
  })
  .strict();

/** Thrown by `setTrusted` for an identity the filesystem could not stably identify. */
export class NonReusableWorkspaceError extends Error {
  readonly code = 'workspace_not_reusable';

  constructor() {
    super(
      'this folder cannot be remembered as trusted: the filesystem does not report a stable identity ' +
        'for it (a network share or a virtual filesystem), so the app cannot verify later that it is ' +
        'still the same folder you approved.',
    );
    this.name = 'NonReusableWorkspaceError';
  }
}

export interface WorkspaceTrustStoreOptions {
  stateRoot: string;
  logger?: Logger;
  now?: () => Date;
}

export interface WorkspaceTrustInspection {
  state: WorkspaceTrustState;
  incarnation?: string;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class WorkspaceTrustStore {
  readonly root: string;
  readonly #filePath: string;
  readonly #quarantineDir: string;
  readonly #logger: Logger;
  readonly #now: () => Date;

  readonly #records = new Map<string, WorkspaceTrustRecord>();
  /**
   * The serialized-write tail, kept from upstream.
   *
   * Every mutation replaces the *whole* file, so two interleaved writes would not merge -- the
   * second would overwrite the first's record set with a snapshot taken before it. Chaining them
   * means the in-memory map and the file always agree, without a lock file.
   */
  #writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceTrustStoreOptions) {
    this.root = join(options.stateRoot, STORE_DIR);
    this.#filePath = join(this.root, TRUST_FILE);
    this.#quarantineDir = join(this.root, QUARANTINE_DIR);
    this.#logger = options.logger ?? noopLogger;
    this.#now = options.now ?? (() => new Date());

    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.#load();
  }

  /**
   * Loads the trust file. A corrupt or unrecognized file is quarantined, never deleted, and the
   * store starts empty -- which means *nothing is trusted*, the fail-closed direction. Recovering a
   * partial record set from a damaged file would mean guessing which approvals the user actually
   * gave, and guessing wrong in the permissive direction is the one outcome to avoid.
   */
  #load(): void {
    if (!existsSync(this.#filePath)) return;
    try {
      const parsed = trustFileSchema.parse(JSON.parse(readFileSync(this.#filePath, 'utf8')));
      for (const record of parsed.workspaces) {
        // A record left in `revoking` by a crash mid-revocation is downgraded to `untrusted` on
        // load. Revocation is a one-way transition the user already asked for; resuming it as
        // "still trusted" would undo an explicit withdrawal because the daemon happened to die.
        const state: WorkspaceTrustState = record.state === 'revoking' ? 'untrusted' : record.state;
        this.#records.set(record.workspaceId, { ...record, state });
      }
    } catch (err) {
      try {
        quarantine(this.#filePath, this.#quarantineDir, 'unreadable-trust-file');
      } catch {
        // Nothing further to do: the map is empty, so every workspace reads as untrusted, and the
        // next successful write replaces the file atomically anyway.
      }
      this.#records.clear();
      this.#logger.warn('workspace trust state could not be read; starting with nothing trusted', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The current state of one workspace. Unknown ids read as `untrusted`, never as an error.
   *
   * Async even though the answer is in memory, and deliberately so: it matches upstream's shape, and
   * more importantly it keeps `SessionManager.workspaceIsTrusted`'s epoch-bracketing honest. That
   * method is written so that *every* await is followed by a re-check; an inspection that were
   * synchronous today would invite dropping the re-check around it, and the day this store grows a
   * real read (a reload, a second file) the missing re-check becomes a silent race.
   */
  inspect(workspaceId: string): Promise<WorkspaceTrustInspection> {
    return Promise.resolve(this.inspectSync(workspaceId));
  }

  /** Synchronous view of the same fact, for callers already inside an await-free critical section. */
  inspectSync(workspaceId: string): WorkspaceTrustInspection {
    const record = this.#records.get(workspaceId);
    if (!record) return { state: 'untrusted' };
    return { state: record.state, incarnation: record.incarnation };
  }

  /** True when this workspace is trusted **at this exact incarnation**. */
  matches(workspaceId: string, incarnation: string): boolean {
    const record = this.#records.get(workspaceId);
    return record?.state === 'trusted' && record.incarnation === incarnation;
  }

  /**
   * Marks a workspace trusted.
   *
   * The only caller is the daemon's own grant-consumption path (see `routes/v2-workspaces.ts`),
   * which reaches it *after* re-resolving the identity from the filesystem and matching it against
   * what a main-issued grant vouched for. There is no HTTP route that reaches this directly, and
   * that is D3: `PUT /v2/workspaces/:id/trust` cannot express `trusted` at all.
   *
   * A non-reusable identity is refused rather than stored, because storing it would be storing a
   * record that can never be honored: its random incarnation cannot match on any later resolution,
   * so the record would sit on disk claiming an approval that no check will ever accept.
   */
  async setTrusted(identity: WorkspaceIdentity, provider: WorkspaceTrustRecord['provider']): Promise<void> {
    if (!identity.reusable) throw new NonReusableWorkspaceError();
    await this.#mutate(() => {
      this.#records.set(identity.workspaceId, {
        workspaceId: identity.workspaceId,
        incarnation: identity.incarnation,
        state: 'trusted',
        provider,
        updatedAt: this.#now().toISOString(),
      });
    });
  }

  /**
   * Moves a workspace into `revoking`: no longer trusted for any new decision, but with its live
   * sessions not yet torn down. Callers pair this with `SessionManager.revokeWorkspace`, whose
   * synchronous half has already blocked the workspace before this write is even scheduled.
   */
  async beginRevocation(workspaceId: string): Promise<void> {
    await this.#mutate(() => {
      const record = this.#records.get(workspaceId);
      if (!record) return;
      this.#records.set(workspaceId, { ...record, state: 'revoking', updatedAt: this.#now().toISOString() });
    });
  }

  /** The terminal state. A workspace with no record at all is already untrusted, so this is a no-op there. */
  async setUntrusted(workspaceId: string): Promise<void> {
    await this.#mutate(() => {
      const record = this.#records.get(workspaceId);
      if (!record) return;
      this.#records.set(workspaceId, { ...record, state: 'untrusted', updatedAt: this.#now().toISOString() });
    });
  }

  /** Every record, for the daemon's startup log and for tests. */
  all(): readonly WorkspaceTrustRecord[] {
    return [...this.#records.values()];
  }

  /**
   * Applies `change` to the in-memory map and then persists the whole file, with both steps inside
   * the same queued task.
   *
   * The mutation happens before the write, not after, so an in-flight `matches()` from a concurrent
   * request sees the *new* state as soon as it is decided rather than after the fsync. That
   * direction is the safe one for revocation (revocation takes effect immediately, persistence
   * catches up) and it is the reason a failed write below does not roll the map back: a workspace
   * that was just revoked must stay revoked in memory even if the disk write failed. A failed write
   * for `setTrusted` is different -- it throws, and its caller (grant consumption) treats that as a
   * denial and revokes.
   */
  async #mutate(change: () => void): Promise<void> {
    const snapshot = this.#writeQueue.then(
      () => {
        change();
        atomicWriteJson(this.#filePath, { schemaVersion: 1, workspaces: [...this.#records.values()] });
      },
      () => {
        change();
        atomicWriteJson(this.#filePath, { schemaVersion: 1, workspaces: [...this.#records.values()] });
      },
    );
    this.#writeQueue = snapshot.then(
      () => undefined,
      () => undefined,
    );
    await snapshot;
  }
}
