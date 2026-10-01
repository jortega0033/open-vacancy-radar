/**
 * #421: named local-client grants for the local MCP endpoint, and the audit trail every call
 * through it writes to.
 *
 * Deliberately not part of `cv-evidence-schema.ts`: a grant and an audit entry are about *who may
 * act*, while that module is about *what a tailoring case is*. Keeping them apart means #419's
 * module never has to know a client or a credential exists, and this module never has to know what
 * a fact or a wording variant is -- it only ever asks "does this grant cover this case id".
 *
 * Same "no runtime imports" discipline `cv-evidence-schema.ts` and `cv-source-schema.ts` already
 * follow: this file is read by the renderer (the Settings panel that lists and revokes grants) and
 * by Electron main (the MCP server that checks them against every call), so it must never touch an
 * Electron- or Node-only API.
 */

/**
 * Which of the two ways a grant may name what it covers. #421's own text: (a) "permission to start
 * cases from a specified reviewed source CV", (b) "permission to work on specified case IDs".
 * They converge on the same check (`mcpGrantCoversCase` reads `caseIds` either way) but differ in
 * how that list is populated and in what the grant may do at all: a `source_cv` grant may create a
 * new case (appending its id to `caseIds` as a side effect, not by the candidate pre-listing it);
 * a `case_ids` grant may only ever work on the cases the candidate named at creation, and may never
 * create a new one. "A source-CV grant also covers only the cases that this client creates from
 * that CV, not other cases linked to the same CV" (#421) is exactly why `source_cv`'s `caseIds`
 * starts empty rather than being computed from every case that CV happens to have.
 */
export type McpGrantScopeType = 'source_cv' | 'case_ids';

export const MCP_GRANT_SCOPE_TYPES: readonly McpGrantScopeType[] = ['source_cv', 'case_ids'];

/** Every call attempt through the endpoint is recorded, successful or not -- #421's own
 * requirement. Kept to a small closed set rather than a free-text reason: the audit trail's job is
 * "what happened", the specific validation failure (a stale revision, an unknown tool, a bad host
 * header) is already surfaced to the caller in the HTTP response itself and never needs a second,
 * separately-maintained text field here. */
export type McpAuditOutcome = 'success' | 'denied' | 'error';

export const MCP_AUDIT_OUTCOMES: readonly McpAuditOutcome[] = ['success', 'denied', 'error'];

export const MCP_GRANT_LIMITS = {
  name: 200,
  caseIdsPerGrant: 200,
  toolName: 200,
} as const;

export interface McpClientGrant {
  id: string;
  /** Candidate-chosen label for this client, shown back to the candidate in Settings and recorded
   * in the audit trail by `grantId` (never a value the client itself supplied at call time). */
  name: string;
  scopeType: McpGrantScopeType;
  /** A `CvDocumentRecord.id`. Set only when `scopeType === 'source_cv'`; `''` otherwise. */
  sourceCvId: string;
  /** The exact `CvEvidenceOverlayRecord.id`s this grant covers. For a `case_ids` grant, fixed at
   * creation by the candidate. For a `source_cv` grant, starts `[]` and grows only as this grant's
   * own `start_tailoring_case` calls succeed -- see this type's own doc comment above. */
  caseIds: string[];
  /** Reading case inputs and submitting proposals is the default a grant carries; reading the
   * final approved snapshot is a separate, strictly higher permission #421 requires be granted
   * explicitly, never implied by the scope alone. */
  canReadFinalSnapshot: boolean;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601 */
  expiresAt: string;
  /** ISO-8601, or `''` while the grant is active. Never deleted once revoked -- the same
   * "durable record of an explicit withdrawal" reasoning `automationGrants.revokedAt` already
   * documents. */
  revokedAt: string;
}

/** Every reason this grant cannot authorize a call right now, in the candidate's terms -- reasons,
 * not a boolean, the same discipline `describeCvEvidenceOverlayGaps` already follows. `now` is
 * supplied by the caller (this file has no runtime clock import). */
export function describeMcpGrantBlockers(grant: McpClientGrant, now: string): string[] {
  const reasons: string[] = [];
  if (grant.revokedAt) reasons.push('this grant was revoked');
  if (grant.expiresAt <= now) reasons.push('this grant has expired');
  return reasons;
}

/** Whether an active, unexpired `grant` covers `caseId` at all -- callers still need
 * `describeMcpGrantBlockers` separately for *why not*, and a tool-specific check (this says
 * nothing about whether `canReadFinalSnapshot` covers the specific call being made). */
export function mcpGrantCoversCase(grant: McpClientGrant, caseId: string): boolean {
  return grant.caseIds.includes(caseId);
}

export interface McpAuditLogEntry {
  id: string;
  /** `''` when no grant could be matched at all -- an unauthenticated, expired, or revoked-credential
   * call is still recorded, per #421's own requirement that every attempt is auditable. */
  grantId: string;
  toolName: string;
  /** `''` when no case was involved (a call rejected before any case lookup happened at all). */
  caseId: string;
  outcome: McpAuditOutcome;
  /** The case's `caseRevision` at the time of this call, or `''` when not applicable. */
  revision: string;
  /** ISO-8601 */
  createdAt: string;
}
