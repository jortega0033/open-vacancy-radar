/**
 * #421's local MCP endpoint: the local HTTP transport, authentication, audit layer (slice 2), and
 * the tool surface itself (slice 3) -- `start_tailoring_case`, `get_tailoring_case`, the six
 * `propose_*` tools, `get_tailoring_status`, and `read_approved_resume`, each a thin wrapper around
 * the main-process case service `electron/workspace/repository.ts` already exposes to the renderer.
 * No tool here writes approval state directly or bypasses `approveCvEvidenceOverlay` -- see that
 * function's own doc comment, and `createCvTailoringProposal`'s, for why.
 *
 * Bound to `127.0.0.1` on a dynamic port, only while explicitly enabled (`appSettings
 * .mcpEndpointEnabled`) and only for the app's own lifetime -- there is no persistence across
 * restarts, matching the ticket's own requirement that a client must reconnect using the current
 * endpoint rather than a cached port. This is the first inbound listener Electron main has ever
 * hosted; see SECURITY.md for the fuller threat-model writeup this module's existence requires.
 *
 * Deliberately independent of `apps/daemon`'s own Fastify server, even though the hardening ideas
 * below (reject any `Origin` header, reject a mismatched `Host`, compare credentials in constant
 * time, never leak internal errors) mirror its `server.ts`/`auth-token.ts` almost exactly. The
 * ticket requires this endpoint's identity, credentials, and audit trail to be entirely separate
 * from the daemon's own discovery token and `/mcp/*` vacancy-source routes -- sharing the
 * implementation would risk sharing state next.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as workspace from './workspace/repository.js';
import { cvArtifactStatus } from './workspace/cv-artifact-status.js';
import type { WorkspaceDb } from './workspace/client.js';
import { describeMcpGrantBlockers, mcpGrantCoversCase } from './workspace/mcp-grant-schema.js';
import { CV_EVIDENCE_LIMITS, describeCvEvidenceOverlayGaps, mintManualCaseKey, vacancyKeyFor } from './workspace/cv-evidence-schema.js';
import { CV_PROPOSAL_LIMITS, type CvProposalPayload } from './workspace/cv-proposal-schema.js';
import type { McpClientGrantRecord } from './workspace/types.js';
import { LIMITS } from './workspace/validate.js';

/** The JD text a `get_tailoring_case` call reads one page of at a time -- a page count and an
 * explicit `isLastPage` marker so truncation is never mistaken for complete coverage (#421). */
const JD_PAGE_SIZE = 4_000;

/** Generous for a real MCP JSON-RPC payload (tool arguments, JD text excerpts in a future slice),
 * finite against a hostile or malfunctioning caller -- the same two-tier reasoning
 * `CV_EVIDENCE_LIMITS` already states for database fields, applied here to a request body instead. */
const MAX_BODY_BYTES = 1_000_000;

export interface McpServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

/** name+version identify this endpoint to a connecting client; bumped only when the tool surface
 * itself changes, not on every unrelated release. */
const SERVER_INFO = { name: 'open-vacancy-radar-cv-assistant', version: '0.1.0' };

function auditTool(
  db: WorkspaceDb,
  grant: McpClientGrantRecord,
  toolName: string,
  caseId: string,
  outcome: 'success' | 'denied' | 'error',
  revision = '',
): void {
  workspace.appendMcpAuditLogEntry(db, { grantId: grant.id, toolName, caseId, outcome, revision });
}

function toolTextResult(value: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** Shared by every `propose_*` tool and `get_tailoring_case`/`get_tailoring_status`/
 * `read_approved_resume`: a grant that does not cover `caseId` gets exactly the same denial a
 * nonexistent case would, never a hint that the case exists but is out of scope. */
function requireCoverage(grant: McpClientGrantRecord, caseId: string): void {
  if (!mcpGrantCoversCase(grant, caseId)) throw new Error('this grant does not cover this case');
}

const requirementProposalShape = {
  caseId: z.string().min(1),
  text: z.string().min(1).max(CV_EVIDENCE_LIMITS.requirementText),
  jdAnchor: z.string().max(CV_EVIDENCE_LIMITS.shortField).default(''),
  classification: z.enum(['required', 'preferred', 'unclear']),
  evidenceClass: z.enum(['direct', 'transferable', 'unsupported', 'needs_verification']),
  anchorParentId: z.string().max(CV_EVIDENCE_LIMITS.shortField).default(''),
};

const evidenceLinkProposalShape = {
  caseId: z.string().min(1),
  requirementId: z.string().min(1),
  anchorParentId: z.string().max(CV_EVIDENCE_LIMITS.shortField).default(''),
  evidenceClass: z.enum(['direct', 'transferable', 'unsupported', 'needs_verification']),
};

const clarificationQuestionProposalShape = {
  caseId: z.string().min(1),
  requirementId: z.string().min(1),
  question: z.string().min(1).max(CV_PROPOSAL_LIMITS.question),
};

const factProposalShape = {
  caseId: z.string().min(1),
  parentId: z.string().min(1),
  parentType: z.enum(['experience', 'project']),
  client: z.string().max(CV_EVIDENCE_LIMITS.shortField).default(''),
  activity: z.string().min(1).max(CV_EVIDENCE_LIMITS.activity),
  mechanism: z.string().max(CV_EVIDENCE_LIMITS.mechanism).default(''),
  result: z.string().max(CV_EVIDENCE_LIMITS.result).default(''),
  ownership: z.enum(['sole', 'shared', 'unknown']).default('unknown'),
  sourceReference: z.string().max(CV_EVIDENCE_LIMITS.shortField).default(''),
  metricValue: z.string().max(CV_EVIDENCE_LIMITS.shortField).default(''),
  metricUnit: z.string().max(CV_EVIDENCE_LIMITS.shortField).default(''),
  metricBasis: z.string().max(CV_EVIDENCE_LIMITS.shortField).default(''),
};

const wordingProposalShape = {
  caseId: z.string().min(1),
  targetField: z.enum(['summary', 'skill', 'experience_bullet', 'project_description']),
  parentId: z.string().max(CV_EVIDENCE_LIMITS.shortField).default(''),
  text: z.string().min(1).max(CV_EVIDENCE_LIMITS.wordingText),
  factIds: z.array(z.string()).max(CV_PROPOSAL_LIMITS.factIdsPerProposal).default([]),
};

/**
 * Registers one `propose_*` tool. Every proposal write and its audit entry happen in the same
 * transaction (#421: "a failed audit write blocks a mutating call") -- `createCvTailoringProposal`
 * itself re-validates every id the payload cites against the case's current state, so this
 * function's own job is only the grant-scope check and wiring the payload through unchanged.
 */
function registerProposalTool(
  server: McpServer,
  db: WorkspaceDb,
  grant: McpClientGrantRecord,
  toolName: string,
  kind: CvProposalPayload['kind'],
  shape: Record<string, z.ZodTypeAny>,
  description: string,
): void {
  server.registerTool(toolName, { description, inputSchema: shape }, async (rawArgs) => {
    const { caseId, ...data } = rawArgs as { caseId: string } & Record<string, unknown>;
    try {
      return db.transaction((tx) => {
        requireCoverage(grant, caseId);
        const proposal = workspace.createCvTailoringProposal(tx, {
          caseId,
          grantId: grant.id,
          payload: { kind, data } as unknown as CvProposalPayload,
        });
        auditTool(tx, grant, toolName, caseId, 'success', proposal.caseRevisionAtProposal);
        return toolTextResult({ proposalId: proposal.id, status: proposal.status });
      });
    } catch (err) {
      // A throw inside the transaction above rolls back any audit write attempted alongside it
      // (#421: "every attempt, not only successful ones") -- audit the denial here, against the
      // outer, un-rolled-back `db`, so a denied propose_* call is never silently lost.
      auditTool(db, grant, toolName, caseId, 'denied');
      throw err;
    }
  });
}

/**
 * Builds a fresh `McpServer` for one request, registering every #421 tool against this specific
 * `grant` and `db` -- fresh per request, matching `StreamableHTTPServerTransport`'s own stateless
 * usage pattern, and not merely a style choice: the underlying `Server.connect` throws ("Already
 * connected to a transport... use a separate Protocol instance per connection") if the same
 * `McpServer` is reconnected to a second transport, which a shared, reused instance would hit on
 * this server's very first follow-up request (the client's own `notifications/initialized` is a
 * second HTTP POST, hitting a second transport). Registering ten tools per request is cheap; there
 * is no per-client state worth keeping across requests that a fresh instance would lose.
 */
function createMcpServerInstance(db: WorkspaceDb, grant: McpClientGrantRecord): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    'start_tailoring_case',
    {
      description: 'Start a new CV tailoring case from an OVR vacancy reference or a pasted job description.',
      inputSchema: {
        vacancy: z
          .object({
            title: z.string().min(1).max(LIMITS.short),
            company: z.string().min(1).max(LIMITS.short),
            location: z.string().max(LIMITS.short).default(''),
            url: z.string().max(LIMITS.short).default(''),
            postingText: z.string().min(1).max(LIMITS.jdSnapshot),
          })
          .optional(),
        manualJd: z
          .object({
            role: z.string().min(1).max(LIMITS.short),
            company: z.string().min(1).max(LIMITS.short),
            jdText: z.string().min(1).max(LIMITS.jdSnapshot),
            url: z.string().max(LIMITS.short).default(''),
          })
          .optional(),
      },
    },
    async ({ vacancy, manualJd }) => {
      let deniedCaseId = '';
      try {
        if (!vacancy === !manualJd) throw new Error('provide exactly one of "vacancy" or "manualJd"');
        if (grant.scopeType !== 'source_cv') throw new Error('this grant cannot start new cases, only work on previously named ones');

        return db.transaction((tx) => {
          const doc = workspace.getCvDocument(tx, grant.sourceCvId);
          if (!doc.source) throw new Error('this CV has no reviewed source yet, so there is nothing to tailor from');
          const sourceCvContentHash = workspace.computeSourceCvContentHash(doc.source);

          const jdSnapshot = vacancy ? vacancy.postingText : (manualJd as NonNullable<typeof manualJd>).jdText;
          const jdSnapshotHash = createHash('sha256').update(jdSnapshot).digest('hex');
          const vacancyKey = vacancy ? vacancyKeyFor(vacancy) : mintManualCaseKey();

          // createCvEvidenceOverlay is idempotent per (cvId, vacancyKey): a second call for the
          // same vacancy returns the existing overlay rather than erroring. Without this check, a
          // second grant on the same source CV would silently inherit coverage of a case it never
          // created -- mcp-grant-schema.ts's own documented invariant is that a source_cv grant
          // covers only the cases *it* created, not every case linked to that CV.
          const existing = vacancy ? workspace.getCvEvidenceOverlay(tx, grant.sourceCvId, vacancyKey) : null;
          if (existing && !mcpGrantCoversCase(grant, existing.id)) {
            deniedCaseId = existing.id;
            throw new Error('a case for this vacancy already exists under a different client\'s grant');
          }

          const overlay = workspace.createCvEvidenceOverlay(tx, {
            cvId: grant.sourceCvId,
            vacancyKey,
            sourceCvContentHash,
            jdSnapshot,
            jdSnapshotHash,
            jdComplete: true,
            jdOrigin: vacancy ? 'found' : 'manual',
            origin: vacancy ? 'vacancy' : 'manual',
          });
          workspace.appendMcpClientGrantCaseId(tx, grant.id, overlay.id);
          auditTool(tx, grant, 'start_tailoring_case', overlay.id, 'success', overlay.caseRevision);

          return toolTextResult({
            caseId: overlay.id,
            caseRevision: overlay.caseRevision,
            gaps: describeCvEvidenceOverlayGaps(overlay, sourceCvContentHash),
          });
        });
      } catch (err) {
        auditTool(db, grant, 'start_tailoring_case', deniedCaseId, 'denied');
        throw err;
      }
    },
  );

  server.registerTool(
    'get_tailoring_case',
    {
      description: 'Read one page of a tailoring case: the JD text, requirements, reviewed evidence, and open proposals.',
      inputSchema: { caseId: z.string().min(1), page: z.number().int().min(0).default(0) },
    },
    async ({ caseId, page }) => {
      try {
        requireCoverage(grant, caseId);
        const overlay = workspace.getCvEvidenceOverlayById(db, caseId);
        const start = page * JD_PAGE_SIZE;
        const jdPage = overlay.jdSnapshot.slice(start, start + JD_PAGE_SIZE);
        const totalPages = Math.max(1, Math.ceil(overlay.jdSnapshot.length / JD_PAGE_SIZE));
        const pendingProposals = workspace.listCvTailoringProposals(db, caseId).filter((p) => p.status === 'pending');
        auditTool(db, grant, 'get_tailoring_case', caseId, 'success', overlay.caseRevision);

        return toolTextResult({
          caseId: overlay.id,
          caseRevision: overlay.caseRevision,
          state: overlay.state,
          jd: { page, totalPages, text: jdPage, isLastPage: page >= totalPages - 1, isComplete: overlay.jdComplete },
          requirements: overlay.requirements,
          facts: overlay.facts,
          pendingProposals,
        });
      } catch (err) {
        auditTool(db, grant, 'get_tailoring_case', caseId, 'denied');
        throw err;
      }
    },
  );

  registerProposalTool(server, db, grant, 'propose_requirements', 'requirement', requirementProposalShape, 'Propose a new JD requirement for this case.');
  registerProposalTool(server, db, grant, 'propose_evidence_link', 'evidence_link', evidenceLinkProposalShape, 'Propose linking an existing requirement to reviewed source evidence.');
  registerProposalTool(server, db, grant, 'propose_clarification_question', 'clarification_question', clarificationQuestionProposalShape, 'Propose a question for the candidate to answer about a requirement.');
  registerProposalTool(server, db, grant, 'propose_fact', 'fact', factProposalShape, 'Propose a claimed fact about the candidate\'s own work, for the candidate to confirm.');
  registerProposalTool(server, db, grant, 'propose_wording', 'wording', wordingProposalShape, 'Propose exact CV wording grounded in existing facts, for the candidate to approve.');

  server.registerTool(
    'get_tailoring_status',
    {
      description: 'Poll a tailoring case\'s current state without creating new work.',
      inputSchema: { caseId: z.string().min(1) },
    },
    async ({ caseId }) => {
      try {
        requireCoverage(grant, caseId);
        const overlay = workspace.getCvEvidenceOverlayById(db, caseId);
        const doc = workspace.getCvDocument(db, overlay.cvId);
        const currentSourceCvContentHash = doc.source ? workspace.computeSourceCvContentHash(doc.source) : '';
        const pendingProposalCount = workspace.listCvTailoringProposals(db, caseId).filter((p) => p.status === 'pending').length;
        auditTool(db, grant, 'get_tailoring_status', caseId, 'success', overlay.caseRevision);

        return toolTextResult({
          caseId: overlay.id,
          caseRevision: overlay.caseRevision,
          state: overlay.state,
          gaps: describeCvEvidenceOverlayGaps(overlay, currentSourceCvContentHash),
          pendingProposalCount,
          // Per-format status of the files exported from the approved snapshot (#419 step 9). `exported`
          // says a current file exists, not that it was accepted or that the vacancy is ready to apply.
          artifactStatus: { pdf: cvArtifactStatus(overlay, 'pdf'), docx: cvArtifactStatus(overlay, 'docx') },
          artifactState:
            overlay.state !== 'candidate_approved'
              ? 'not_approved'
              : (['pdf', 'docx'] as const).some((format) => ['awaiting_review', 'accepted'].includes(cvArtifactStatus(overlay, format)))
                ? 'exported'
                : 'approved_not_exported',
        });
      } catch (err) {
        auditTool(db, grant, 'get_tailoring_status', caseId, 'denied');
        throw err;
      }
    },
  );

  server.registerTool(
    'read_approved_resume',
    {
      description: 'Read the exact, immutable resume the candidate approved for this case, if still current.',
      inputSchema: { caseId: z.string().min(1) },
    },
    async ({ caseId }) => {
      try {
        if (!grant.canReadFinalSnapshot) throw new Error('this grant does not have permission to read the approved resume');
        requireCoverage(grant, caseId);
        const overlay = workspace.getCvEvidenceOverlayById(db, caseId);
        if (!overlay.approvedResumeSnapshot) throw new Error('this case has not been approved yet');
        if (overlay.state !== 'candidate_approved') {
          throw new Error('the case has changed since it was approved; the approved snapshot is no longer current');
        }
        auditTool(db, grant, 'read_approved_resume', caseId, 'success', overlay.caseRevision);
        return toolTextResult(overlay.approvedResumeSnapshot);
      } catch (err) {
        auditTool(db, grant, 'read_approved_resume', caseId, 'denied');
        throw err;
      }
    },
  );

  return server;
}

function extractBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) return undefined;
  return value.slice('Bearer '.length);
}

/** Port-agnostic hostname check against `127.0.0.1`/`localhost` -- DNS-rebinding protection for a
 * server without its own TLS, the same reasoning the MCP SDK's own `localhostHostValidation`
 * middleware documents (not used directly here since it is an Express `RequestHandler`, and this
 * server deliberately adds no framework dependency for a two-line check). */
function hasAllowedHost(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  const hostname = value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1).toLowerCase() : value.split(':')[0]?.toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new PayloadTooLargeError();
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new MalformedBodyError();
  }
}

class PayloadTooLargeError extends Error {}
class MalformedBodyError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Every request runs the same gate, in order, before anything MCP-specific happens: reject a
 * browser-authored request outright (any `Origin` header at all, the same policy the daemon's own
 * server.ts already documents), reject a mismatched `Host` (DNS rebinding), then authenticate
 * against a grant's credential. Each rejection is audited (#421: every attempt, not only
 * successful ones) before the response is sent, so a failed audit write can still block the call
 * by throwing -- there is no tool call to "block" yet in this slice, but the gate itself already
 * follows the same discipline slice 3's tool handlers will.
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse, getDb: () => Promise<WorkspaceDb>): Promise<void> {
  try {
    if (req.headers.origin !== undefined) {
      const db = await getDb();
      workspace.appendMcpAuditLogEntry(db, { grantId: '', toolName: '', outcome: 'denied' });
      sendJson(res, 403, { error: 'browser-originated requests are not allowed' });
      return;
    }
    if (!hasAllowedHost(req.headers.host)) {
      const db = await getDb();
      workspace.appendMcpAuditLogEntry(db, { grantId: '', toolName: '', outcome: 'denied' });
      sendJson(res, 403, { error: 'unexpected Host header' });
      return;
    }

    const db = await getDb();
    const credential = extractBearerToken(req.headers.authorization);
    const grant = credential ? workspace.findMcpClientGrantByCredential(db, credential) : null;
    if (!grant) {
      workspace.appendMcpAuditLogEntry(db, { grantId: '', toolName: '', outcome: 'denied' });
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const blockers = describeMcpGrantBlockers(grant, new Date().toISOString());
    if (blockers.length > 0) {
      workspace.appendMcpAuditLogEntry(db, { grantId: grant.id, toolName: '', outcome: 'denied' });
      sendJson(res, 403, { error: blockers.join('; ') });
      return;
    }

    let parsedBody: unknown;
    if (req.method === 'POST') {
      try {
        parsedBody = await readJsonBody(req, MAX_BODY_BYTES);
      } catch (err) {
        workspace.appendMcpAuditLogEntry(db, { grantId: grant.id, toolName: '', outcome: 'denied' });
        if (err instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: 'request body too large' });
        } else {
          sendJson(res, 400, { error: 'malformed JSON body' });
        }
        return;
      }
    }

    // No audit entry for the exchange itself beyond this point: `initialize`/`tools/list`/
    // notifications carry no case id or tool call worth recording, and every real tool call below
    // audits itself, atomically with whatever it writes.
    const mcpServer = createMcpServerInstance(db, grant);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch {
    // Never a stack trace or an internal message across this boundary -- the same "sanitize
    // anything without a known 4xx shape" discipline the daemon's own error handler documents.
    if (!res.headersSent) sendJson(res, 500, { error: 'internal server error' });
  }
}

/**
 * Starts the endpoint. Binds `127.0.0.1` on a dynamic port (`0`), so the caller (`main.ts`) always
 * reads the real port back from the returned handle rather than assuming one -- a fixed port
 * would collide across machines or a second launch attempt, the same reasoning the daemon's own
 * dynamic port already follows.
 */
export async function startMcpServer(getDb: () => Promise<WorkspaceDb>): Promise<McpServerHandle> {
  const httpServer: Server = createServer((req, res) => {
    void handleRequest(req, res, getDb);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    httpServer.close();
    throw new Error('MCP server failed to bind a TCP port');
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // A client that opened a standalone GET SSE stream (a normal MCP client behavior, even
        // with zero tools registered) holds an open keep-alive connection `close()`'s callback
        // would otherwise wait on forever, since Node's `Server.close` only fires once every
        // existing connection ends on its own. `closeAllConnections` ends them now -- correct
        // here because "closing OVR removes the endpoint" (#421) means immediately, not once
        // every open stream happens to end by itself.
        httpServer.closeAllConnections();
      }),
  };
}
