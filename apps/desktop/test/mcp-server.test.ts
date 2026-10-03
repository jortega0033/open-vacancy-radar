// @vitest-environment node
import * as http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { startMcpServer, type McpServerHandle } from '../electron/mcp-server.js';
import { EMPTY_CV_SOURCE } from '../electron/workspace/cv-source-schema.js';
import { FULL_JD } from './fixtures/job-description.js';

/**
 * Exercises the real local MCP endpoint (#421) against a real HTTP server on a real port and a
 * real SQLite file -- not mocks. The first describe block covers the transport/auth/audit gate
 * every tool call passes through (Origin/Host rejection, per-grant credential auth, size/shape
 * limits, a real `@modelcontextprotocol/sdk` client completing the MCP handshake). The second
 * drives the actual tool surface end to end through that same real client -- the "real client
 * interoperability" proof #421's own phase-3 line asks for.
 */

const CV = {
  name: 'Resume',
  kind: 'manual' as const,
  profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
};
const SOURCE = {
  ...EMPTY_CV_SOURCE,
  summary: 'Original summary.',
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - Present', engagement: 'employment' as const, client: '', bullets: ['Built things.'] },
  ],
};
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

let dir: string;
let db: WorkspaceDb;
let closeDb: (() => void) | undefined;
let handle: McpServerHandle;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-mcp-test-'));
  const opened = createWorkspaceDb(dir);
  db = opened.db;
  closeDb = opened.close;
  handle = await startMcpServer(async () => db);
});

afterEach(async () => {
  await handle.close();
  closeDb?.();
  rmSync(dir, { recursive: true, force: true });
});

function createGrant(overrides: { expiresAt?: string; withSource?: boolean; canReadFinalSnapshot?: boolean } = {}) {
  const cv = workspace.createCvDocument(db, { ...CV, ...(overrides.withSource ? { source: SOURCE } : {}) });
  const { grant, credential } = workspace.createMcpClientGrant(db, {
    name: 'Test client',
    scopeType: 'source_cv',
    sourceCvId: cv.id,
    expiresAt: overrides.expiresAt ?? FUTURE,
    canReadFinalSnapshot: overrides.canReadFinalSnapshot ?? false,
  });
  return { cv, grant, credential };
}

async function connectedClient(credential: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${credential}` } },
    }),
  );
  return client;
}

/** `callTool` resolves even when the tool threw (the SDK converts it to `isError: true`), so
 * callers that expect a *successful* call assert on `.isError` rather than relying on a rejection. */
function toolJson<T = unknown>(result: Record<string, unknown>): T {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as T;
}

/** Raw `node:http` rather than `fetch`: the Host-header test specifically needs a client that
 * will send whatever `Host` value it is given, which the Fetch API forbids overriding. */
function rawRequest(headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: handle.port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString('utf8');
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('local MCP endpoint transport and auth gate (#421)', () => {
  it('rejects any request carrying an Origin header, browser-authored or not', async () => {
    const { credential } = createGrant();
    const res = await rawRequest({ origin: 'http://evil.example', authorization: `Bearer ${credential}` }, '{}');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/browser-originated/);
  });

  it('rejects a mismatched Host header (DNS rebinding)', async () => {
    const { credential } = createGrant();
    const res = await rawRequest({ host: 'evil.example:9999', authorization: `Bearer ${credential}` }, '{}');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/Host/);
  });

  it('rejects a request with no credential at all', async () => {
    const res = await rawRequest({}, '{}');
    expect(res.status).toBe(401);
  });

  it('rejects an unknown credential', async () => {
    const res = await rawRequest({ authorization: 'Bearer not-a-real-credential' }, '{}');
    expect(res.status).toBe(401);
  });

  it('rejects an expired grant\'s credential', async () => {
    const { credential } = createGrant({ expiresAt: PAST });
    const res = await rawRequest({ authorization: `Bearer ${credential}` }, '{}');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/expired/);
  });

  it('rejects a revoked grant\'s credential immediately', async () => {
    const { grant, credential } = createGrant();
    workspace.revokeMcpClientGrant(db, grant.id);
    const res = await rawRequest({ authorization: `Bearer ${credential}` }, '{}');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/revoked/);
  });

  it('rejects an oversized body before parsing it', async () => {
    const { credential } = createGrant();
    const res = await rawRequest({ authorization: `Bearer ${credential}` }, 'x'.repeat(2_000_000));
    expect(res.status).toBe(413);
  });

  it('rejects a malformed JSON body from an otherwise-authorized caller', async () => {
    const { credential } = createGrant();
    const res = await rawRequest({ authorization: `Bearer ${credential}` }, '{not valid json');
    expect(res.status).toBe(400);
  });

  it('records every attempt in the audit trail, successful or not', async () => {
    const { credential } = createGrant();
    await rawRequest({ authorization: 'Bearer wrong' }, '{}');
    await rawRequest({ origin: 'http://evil.example', authorization: `Bearer ${credential}` }, '{}');
    const entries = workspace.listMcpAuditLogEntries(db);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((e) => e.outcome === 'denied')).toBe(true);
  });

  it('completes a real MCP handshake for a properly authorized client, listing all ten tools', async () => {
    const { credential } = createGrant();
    const client = await connectedClient(credential);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'start_tailoring_case',
        'get_tailoring_case',
        'propose_requirements',
        'propose_evidence_link',
        'propose_clarification_question',
        'propose_fact',
        'propose_wording',
        'get_tailoring_status',
        'read_approved_resume',
      ].sort(),
    );
    await client.close();
  });

  it('a second client authenticates independently of the first, on the same running endpoint', async () => {
    const { credential: credentialA } = createGrant();
    const { credential: credentialB } = createGrant();

    const clientA = new Client({ name: 'client-a', version: '1.0.0' });
    await clientA.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${credentialA}` } },
      }),
    );
    await clientA.close();

    const clientB = new Client({ name: 'client-b', version: '1.0.0' });
    await clientB.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${credentialB}` } },
      }),
    );
    // Both handshakes completed without error, each under its own credential -- a ping proves the
    // connection is actually live, not just that `connect()` resolved.
    await expect(clientB.ping()).resolves.toBeDefined();
    await clientB.close();
  });
});

describe('local MCP endpoint tool surface (#421)', () => {
  it('starts a case from a pasted JD, and the grant earns coverage of it', async () => {
    const { credential } = createGrant({ withSource: true });
    const client = await connectedClient(credential);

    const started = toolJson<{ caseId: string; caseRevision: string; gaps: string[] }>(
      await client.callTool({ name: 'start_tailoring_case', arguments: { manualJd: { role: 'Frontend Engineer', company: 'Acme', jdText: 'We need a frontend engineer.' } } }),
    );
    expect(started.caseId).toBeTruthy();
    // Vacuously gap-free: there are no requirements at all yet to be unreviewed. Gaps appear once
    // something is proposed and accepted -- see the pagination test below.
    // A job description this short is flagged, so the case reports that gap from the start.
    expect(started.gaps).toEqual(
      expect.arrayContaining([expect.stringMatching(/looks incomplete/), expect.stringMatching(/not been read and confirmed/)]),
    );

    // Coverage was earned by this call, not pre-granted: a second tool call against the same
    // caseId from the same grant succeeds.
    const status = toolJson(await client.callTool({ name: 'get_tailoring_status', arguments: { caseId: started.caseId } }));
    expect(status).toMatchObject({ caseId: started.caseId });
    await client.close();
  });

  it('refuses to start a case from both a vacancy and a manual JD, or from neither', async () => {
    const { credential } = createGrant({ withSource: true });
    const client = await connectedClient(credential);
    const neither = await client.callTool({ name: 'start_tailoring_case', arguments: {} });
    expect(neither.isError).toBe(true);
    const both = await client.callTool({
      name: 'start_tailoring_case',
      arguments: {
        vacancy: { title: 'x', company: 'y', postingText: 'z' },
        manualJd: { role: 'x', company: 'y', jdText: 'z' },
      },
    });
    expect(both.isError).toBe(true);
    await client.close();
  });

  it('refuses to start a new case for a case_ids-scoped grant', async () => {
    const { cv } = createGrant({ withSource: true });
    const overlay = workspace.createCvEvidenceOverlay(db, { cvId: cv.id, vacancyKey: 'v-1', sourceCvContentHash: 'a'.repeat(64), jdSnapshotHash: 'b'.repeat(64) });
    const { credential } = workspace.createMcpClientGrant(db, { name: 'Narrow', scopeType: 'case_ids', caseIds: [overlay.id], expiresAt: FUTURE });
    const client = await connectedClient(credential);
    const result = await client.callTool({ name: 'start_tailoring_case', arguments: { manualJd: { role: 'x', company: 'y', jdText: 'z' } } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('a grant cannot touch a case outside its scope', async () => {
    const { credential: credentialA } = createGrant({ withSource: true });
    const clientA = await connectedClient(credentialA);
    const { caseId } = toolJson<{ caseId: string }>(
      await clientA.callTool({ name: 'start_tailoring_case', arguments: { manualJd: { role: 'x', company: 'y', jdText: 'z' } } }),
    );
    await clientA.close();

    const { credential: credentialB } = createGrant({ withSource: true });
    const clientB = await connectedClient(credentialB);
    const denied = await clientB.callTool({ name: 'get_tailoring_status', arguments: { caseId } });
    expect(denied.isError).toBe(true);
    await clientB.close();
  });

  it('get_tailoring_case paginates the JD and reports requirements, facts, and pending proposals', async () => {
    const { credential } = createGrant({ withSource: true });
    const client = await connectedClient(credential);
    const { caseId } = toolJson<{ caseId: string }>(
      await client.callTool({ name: 'start_tailoring_case', arguments: { manualJd: { role: 'x', company: 'y', jdText: 'Short JD text.' } } }),
    );
    await client.callTool({
      name: 'propose_requirements',
      arguments: { caseId, text: 'React experience', jdAnchor: '', classification: 'required', evidenceClass: 'needs_verification', anchorParentId: '' },
    });

    const page = toolJson<{ jd: { text: string; totalPages: number; isLastPage: boolean }; requirements: unknown[]; pendingProposals: unknown[] }>(
      await client.callTool({ name: 'get_tailoring_case', arguments: { caseId, page: 0 } }),
    );
    expect(page.jd.text).toBe('Short JD text.');
    expect(page.jd.totalPages).toBe(1);
    expect(page.jd.isLastPage).toBe(true);
    expect(page.pendingProposals).toHaveLength(1);
    await client.close();
  });

  it('propose_fact rejects a parentId that does not resolve in the reviewed source', async () => {
    const { credential } = createGrant({ withSource: true });
    const client = await connectedClient(credential);
    const { caseId } = toolJson<{ caseId: string }>(
      await client.callTool({ name: 'start_tailoring_case', arguments: { manualJd: { role: 'x', company: 'y', jdText: 'z' } } }),
    );
    const result = await client.callTool({
      name: 'propose_fact',
      arguments: { caseId, parentId: 'invented-entry', parentType: 'experience', activity: 'Did a thing' },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('propose_fact accepted later becomes an unreviewed fact, never the candidate\'s testimony from the client\'s own claim', async () => {
    const { credential } = createGrant({ withSource: true });
    const client = await connectedClient(credential);
    const { caseId } = toolJson<{ caseId: string }>(
      await client.callTool({ name: 'start_tailoring_case', arguments: { manualJd: { role: 'x', company: 'y', jdText: 'z' } } }),
    );
    const proposed = toolJson<{ proposalId: string }>(
      await client.callTool({ name: 'propose_fact', arguments: { caseId, parentId: 'experience-1', parentType: 'experience', activity: 'Shipped the redesign' } }),
    );
    await client.close();

    // Acceptance is the app's own action, never the MCP tool's -- there is no "approve" tool.
    const { overlay } = workspace.acceptCvTailoringProposal(db, proposed.proposalId);
    expect(overlay.facts[0]).toMatchObject({ activity: 'Shipped the redesign', verification: 'unreviewed', sourceKind: 'mcp_proposal', approval: 'proposed' });
  });

  it('read_approved_resume refuses without the separate final-snapshot permission, even within scope', async () => {
    const { credential } = createGrant({ withSource: true, canReadFinalSnapshot: false });
    const client = await connectedClient(credential);
    const { caseId } = toolJson<{ caseId: string }>(
      await client.callTool({ name: 'start_tailoring_case', arguments: { manualJd: { role: 'x', company: 'y', jdText: 'z' } } }),
    );
    const result = await client.callTool({ name: 'read_approved_resume', arguments: { caseId } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('read_approved_resume returns the frozen snapshot once approved, for a grant with the permission', async () => {
    const { credential } = createGrant({ withSource: true, canReadFinalSnapshot: true });
    const client = await connectedClient(credential);
    const { caseId } = toolJson<{ caseId: string }>(
      await client.callTool({ name: 'start_tailoring_case', arguments: { manualJd: { role: 'x', company: 'y', jdText: FULL_JD } } }),
    );

    const notApprovedYet = await client.callTool({ name: 'read_approved_resume', arguments: { caseId } });
    expect(notApprovedYet.isError).toBe(true);

    // The candidate confirms the (empty) requirement list for this JD, which approval requires.
    workspace.updateCvEvidenceOverlay(db, caseId, { requirementCoverage: { status: 'complete', batches: 1 } });
    const overlay = workspace.getCvEvidenceOverlayById(db, caseId);
    workspace.approveCvEvidenceOverlay(db, caseId, overlay.caseRevision);

    const snapshot = toolJson<{ resume: { summary: string }; digest: string }>(
      await client.callTool({ name: 'read_approved_resume', arguments: { caseId } }),
    );
    expect(snapshot.resume.summary).toBe('Original summary.');
    expect(snapshot.digest).toBeTruthy();
    await client.close();
  });

  it('every tool call is audited with the real tool name and case id', async () => {
    const { credential } = createGrant({ withSource: true });
    const client = await connectedClient(credential);
    const { caseId } = toolJson<{ caseId: string }>(
      await client.callTool({ name: 'start_tailoring_case', arguments: { manualJd: { role: 'x', company: 'y', jdText: 'z' } } }),
    );
    await client.close();

    const entries = workspace.listMcpAuditLogEntries(db);
    expect(entries.some((e) => e.toolName === 'start_tailoring_case' && e.caseId === caseId && e.outcome === 'success')).toBe(true);
  });

  it('a second grant on the same source CV cannot inherit coverage of a vacancy case the first grant started', async () => {
    const cv = workspace.createCvDocument(db, { ...CV, source: SOURCE });
    const { credential: credentialA } = workspace.createMcpClientGrant(db, { name: 'A', scopeType: 'source_cv', sourceCvId: cv.id, expiresAt: FUTURE });
    const { credential: credentialB } = workspace.createMcpClientGrant(db, { name: 'B', scopeType: 'source_cv', sourceCvId: cv.id, expiresAt: FUTURE });
    const vacancy = { title: 'Frontend Engineer', company: 'Acme', postingText: 'We need a frontend engineer.' };

    const clientA = await connectedClient(credentialA);
    const { caseId } = toolJson<{ caseId: string }>(await clientA.callTool({ name: 'start_tailoring_case', arguments: { vacancy } }));
    await clientA.close();

    const clientB = await connectedClient(credentialB);
    const result = await clientB.callTool({ name: 'start_tailoring_case', arguments: { vacancy } });
    expect(result.isError).toBe(true);
    await clientB.close();

    // Grant B never earned coverage of A's case.
    const stillDenied = await (await connectedClient(credentialB)).callTool({ name: 'get_tailoring_status', arguments: { caseId } });
    expect(stillDenied.isError).toBe(true);

    const entries = workspace.listMcpAuditLogEntries(db);
    expect(entries.some((e) => e.toolName === 'start_tailoring_case' && e.caseId === caseId && e.outcome === 'denied')).toBe(true);
  });

  it('get_tailoring_case, get_tailoring_status, and read_approved_resume are audited on both success and denial', async () => {
    const { credential } = createGrant({ withSource: true, canReadFinalSnapshot: true });
    const client = await connectedClient(credential);
    const { caseId } = toolJson<{ caseId: string }>(
      await client.callTool({ name: 'start_tailoring_case', arguments: { manualJd: { role: 'x', company: 'y', jdText: 'z' } } }),
    );
    await client.callTool({ name: 'get_tailoring_case', arguments: { caseId } });
    await client.callTool({ name: 'get_tailoring_status', arguments: { caseId } });
    await client.callTool({ name: 'read_approved_resume', arguments: { caseId } }); // not approved yet -- denied
    await client.callTool({ name: 'get_tailoring_case', arguments: { caseId: 'nonexistent' } }); // denied (no coverage)
    await client.close();

    const entries = workspace.listMcpAuditLogEntries(db);
    const outcomesFor = (toolName: string) => entries.filter((e) => e.toolName === toolName).map((e) => e.outcome);
    expect(outcomesFor('get_tailoring_case')).toEqual(expect.arrayContaining(['success', 'denied']));
    expect(outcomesFor('get_tailoring_status')).toContain('success');
    expect(outcomesFor('read_approved_resume')).toContain('denied');
  });

  it('a denied propose_* call is still audited, even though its proposal write rolled back', async () => {
    const { credential } = createGrant({ withSource: true });
    const client = await connectedClient(credential);
    const result = await client.callTool({ name: 'propose_fact', arguments: { caseId: 'nonexistent', parentId: 'experience-1', parentType: 'experience', activity: 'x' } });
    expect(result.isError).toBe(true);
    await client.close();

    const entries = workspace.listMcpAuditLogEntries(db);
    expect(entries.some((e) => e.toolName === 'propose_fact' && e.outcome === 'denied')).toBe(true);
  });
});
