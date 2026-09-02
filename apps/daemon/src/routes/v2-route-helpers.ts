import type { FastifyReply } from 'fastify';
import { AuditCapacityError, AuditUnavailableError, type AuditStore } from '../audit-store.js';
import { InvalidWorkspacePathError, UncWorkspacePathError } from '../workspace-identity.js';

/**
 * The two pieces of refusal machinery that `routes/v2-workspaces.ts` and
 * `routes/v2-sessions-create.ts` must agree on exactly, extracted here so they cannot drift.
 *
 * Both were originally private to `v2-workspaces.ts`. ADI-13 needed the same behavior in a second
 * route, and the alternative -- copying them -- is the specific failure this file exists to prevent:
 * two routes that answer the same filesystem condition with two different codes are two different
 * contracts, and the desktop app's main process maps those codes onto the closed table of messages
 * it is willing to show a user (see `DAEMON_REFUSAL_MESSAGES` in apps/desktop/electron/main.ts). A
 * code that exists in one route and not the other degrades silently to a vague message.
 */

/**
 * The complete, closed set of ways an audit write can be reported to a caller.
 *
 * Every field here is a literal written in this file. No part of it is derived from an exception, a
 * path, or anything else the filesystem produced -- see `appendAudit` for why that matters. The
 * three cases are kept distinct because the operator action differs: archive the log, restart the
 * daemon, or look at the daemon log.
 */
export const AUDIT_FAILURES = {
  audit_log_full: {
    status: 507,
    code: 'audit_log_full',
    message: 'the workspace audit log is full, so this action was refused rather than performed unrecorded',
  },
  audit_unavailable: {
    status: 503,
    code: 'audit_unavailable',
    message: 'the workspace audit log is not writable, so this action was refused rather than performed unrecorded',
  },
  audit_write_failed: {
    status: 500,
    code: 'audit_write_failed',
    message: 'the workspace audit log could not be written',
  },
} as const;

export type AuditFailure = (typeof AUDIT_FAILURES)[keyof typeof AUDIT_FAILURES];

/**
 * Appends one audit entry, reporting a failure as a **closed code plus a fixed message**.
 *
 * The closed set is the point. An audit-store failure's own `Error.message` quotes whatever the
 * filesystem said, and that text carries the daemon's log path (`appendDurably`'s own error names
 * the file, and an ordinary EACCES/ENOSPC/EPERM from Node names it too). These responses are
 * relayed by the desktop app's main process and end up in front of the renderer, which is the one
 * process in this system that is never told where anything lives -- so nothing derived from a
 * filesystem error may appear in them. The daemon's own log keeps the real cause (`AuditStore` logs
 * it at the point of failure), which is where an operator can act on it.
 */
export function appendAudit(
  auditStore: AuditStore,
  entry: Parameters<AuditStore['append']>[0],
): Promise<AuditFailure | undefined> {
  return auditStore.append(entry).then(
    () => undefined,
    (err: unknown) => {
      if (err instanceof AuditCapacityError) return AUDIT_FAILURES.audit_log_full;
      if (err instanceof AuditUnavailableError) return AUDIT_FAILURES.audit_unavailable;
      return AUDIT_FAILURES.audit_write_failed;
    },
  );
}

/**
 * Writes one audit entry and reports whether the caller may proceed.
 *
 * The contract is deliberately blunt: **if this returns false, deny.** An audit log that is
 * "best-effort" is not an audit log, so a capacity error and a latched-unhealthy store both stop the
 * action rather than being logged past. The two are distinguished in the response only because one
 * is recoverable by archiving a file and the other needs a restart.
 *
 * Two callers must not use this and call `appendAudit` directly instead: workspace revocation, which
 * has to attempt the write and then tear the workspace down regardless of the answer, and any
 * *denial* path, which already has an error to return and must not have it replaced by a bookkeeping
 * failure.
 */
export async function writeAudit(
  auditStore: AuditStore,
  reply: FastifyReply,
  entry: Parameters<AuditStore['append']>[0],
): Promise<boolean> {
  const failure = await appendAudit(auditStore, entry);
  if (!failure) return true;
  reply.code(failure.status).send({ error: failure.message, code: failure.code });
  return false;
}

/**
 * Translates an identity-resolution failure into a client-visible refusal.
 *
 * The UNC case gets its own code and its own full message (D6): "network locations are not
 * supported" is actionable, whereas the generic invalid-path error would leave a user retrying the
 * same share forever. Returns `true` when it handled the error, so the caller can `return`.
 */
export function replyForIdentityError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof UncWorkspacePathError) {
    reply.code(400).send({ error: err.message, code: err.code });
    return true;
  }
  if (err instanceof InvalidWorkspacePathError) {
    reply.code(400).send({ error: err.message, code: err.code });
    return true;
  }
  return false;
}
