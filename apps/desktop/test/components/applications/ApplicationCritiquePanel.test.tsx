/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures mutate loosely-typed critic JSON on purpose */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationCritiqueBridge } from '../../../electron/application-critique-types.js';
import type { CritiqueGenerateResult } from '../../../electron/application-critique-service.js';

/**
 * "Review this application" as a person meets it. The REAL attempt drawer renders the panel, which reads
 * `window.applicationCritique`: the REAL `electron/preload.ts` (in front of a stubbed ipcRenderer) in
 * front of the REAL IPC handlers, critique service, preparation pipeline, staging + document acceptance
 * and migrated SQLite. Stood in for: Chromium's printToPDF and the model session (a scripted reviewer that
 * records every call). `agentDock` throws if touched and `fetch` fails: the review needs neither.
 */

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
let exposedApis: Record<string, unknown>;
vi.mock('electron', async () => {
  const { htmlToPdf } = await import('../../application-critique-fixtures.js');
  return {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => void (exposedApis[name] = api) },
    ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
    BrowserWindow: class {
      #html = '';
      webContents = { printToPDF: async (): Promise<Buffer> => Buffer.from(htmlToPdf(this.#html)) };
      async loadURL(url: string): Promise<void> {
        this.#html = decodeURIComponent(url.replace(/^data:text\/html;charset=utf-8,/u, ''));
      }
      destroy(): void {}
    },
  };
});
vi.mock('../../../electron/application-view.js', () => ({ createApplicationView: vi.fn() }));

vi.setConfig({ testTimeout: 30_000 });

const { createWorkspaceDb } = await import('../../../electron/workspace/client.js');
const workspace = await import('../../../electron/workspace/repository.js');
const pipeline = await import('../../../electron/application-pipeline.js');
const store = await import('../../../electron/workspace/application-critique-store.js');
const { applicationAttempts } = await import('../../../electron/workspace/schema.js');
const { ApplicationDataResetGate } = await import('../../../electron/application-data-reset-gate.js');
const { ApplicationAttemptDrawer } = await import('../../../src/components/applications/ApplicationAttemptDrawer.js');
const fx = await import('../../application-critique-fixtures.js');
import type { WorkspaceDb } from '../../../electron/workspace/client.js';
import type { ApplicationAttemptRecord } from '../../../electron/workspace/types.js';

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let generate: ReturnType<typeof vi.fn>;
let attemptId: string;
const gate = new ApplicationDataResetGate();
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

async function installBridge(): Promise<void> {
  const { createApplicationCritiqueHandlers } = await import('../../../electron/application-critique-ipc.js');
  const handlers = createApplicationCritiqueHandlers({
    service: async () => ({
      db,
      storageRoot: join(dir, 'artifacts'),
      now: () => new Date(),
      generate: generate as never,
      loadCompanyEvidence: () => [],
      provider: 'claude',
    }),
    mutate: (task) => gate.runMutation(task),
  });
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`unexpected channel ${channel}`);
    return JSON.parse(JSON.stringify(await handler(JSON.parse(JSON.stringify(payload)))));
  });
  vi.resetModules();
  exposedApis = {};
  await import('../../../electron/preload.js');
  (window as unknown as { applicationCritique: ApplicationCritiqueBridge }).applicationCritique = exposedApis.applicationCritique as ApplicationCritiqueBridge;
}

async function prepare(): Promise<string> {
  const cvId = workspace.createCvDocument(db, {
    name: 'Main CV',
    kind: 'manual',
    text: 'Jamie Rivera, Senior Engineer at Redwood Software.',
    profile: { title: 'Senior Engineer', location: 'Amsterdam', skills: fx.PROFILE_SKILLS, summary: fx.SOURCE.summary, years: '8', languages: 'English' },
    source: fx.SOURCE,
    isDefault: true,
  }).id;
  const attempt = workspace.createApplicationAttempt(db, {
    vacancyKey: 'vac-1',
    canonicalUrl: fx.APPLY_URL,
    company: fx.COMPANY,
    role: fx.ROLE,
    sourceCvId: cvId,
    sourceCvContentHash: sha(workspace.listCvDocuments(db)[0]!.text),
    jdSnapshot: fx.JD,
    jdSnapshotHash: sha(fx.JD),
    jdComplete: true,
    workflowVersion: pipeline.APPLICATION_PIPELINE_WORKFLOW_VERSION,
    checkpoint: 'queued',
  });
  await pipeline.runApplicationAttempt(
    {
      db,
      storageRoot: join(dir, 'artifacts'),
      queue: { enqueue: async () => undefined, acquireLease: async () => null, release: async () => undefined, entryState: async () => 'active' },
      generateFieldMap: async () => {
        throw new Error('no form here');
      },
      generateTailoredResume: async () => ({ ok: true, text: fx.tailoredResumeReply() }),
      generateCoverLetter: async () => ({ ok: true, text: fx.LETTER_SELECTION_REPLY }),
      loadProfile: async () => null,
      now: () => new Date(),
    },
    attempt.id,
  );
  return attempt.id;
}

const ok = (value: unknown): CritiqueGenerateResult => ({ ok: true, text: JSON.stringify(value), usage: { inputTokens: 900, outputTokens: 60 } });
const attemptRecord = (): ApplicationAttemptRecord => workspace.getApplicationAttempt(db, attemptId);

function renderDrawer(onChanged = vi.fn()) {
  const view = render(<ApplicationAttemptDrawer attempt={attemptRecord()} onClose={vi.fn()} onChanged={onChanged} />);
  return { ...view, onChanged };
}
const panel = () => screen.findByRole('region', { name: 'Independent review' });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-critique-ui-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  generate = vi.fn(async () => ok({ findings: [] }));
  attemptId = await prepare();
  (window as any).agentDock = {
    createSession: vi.fn(() => {
      throw new Error('the review must not use the renderer session API');
    }),
  };
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('no network for the review');
  }));
  (window as any).workspace = { listApplicationArtifacts: async () => [] };
  await installBridge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as any).applicationCritique;
  delete (window as any).workspace;
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('opening the drawer', () => {
  it('shows what will be read and what the action costs, and starts nothing', async () => {
    renderDrawer();
    const region = await panel();
    expect(within(region).getByText(/Reads: CV \(version 1\)/u)).toBeInTheDocument();
    expect(within(region).getByText(/It uses one AI request/u)).toBeInTheDocument();
    expect(within(region).getByText(/cannot add skills, achievements, metrics or dates/u)).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: 'Review this application' })).toBeEnabled();
    expect(generate).not.toHaveBeenCalled();
    expect((window as any).agentDock.createSession).not.toHaveBeenCalled();
  });
});

describe('a clean package', () => {
  it('says so plainly, offers nothing to accept, and leaves every document alone', async () => {
    const files = workspace.listApplicationArtifacts(db, attemptId).map((a) => a.contentHash);
    renderDrawer();
    fireEvent.click(within(await panel()).getByRole('button', { name: 'Review this application' }));
    const region = await panel();
    expect(await within(region).findByText(/No problems found\. Your documents were left exactly as they are\./u)).toBeInTheDocument();
    expect(within(region).getByText(/1 AI request · 900 tokens in, 60 out \(as reported\)/u)).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: /^Use this/u })).toBeNull();
    expect(within(region).getByRole('button', { name: 'Review again' })).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(workspace.listApplicationArtifacts(db, attemptId).map((a) => a.contentHash)).toEqual(files);
  });
});

describe('findings and suggestions', () => {
  async function reviewWithRevision(revision: unknown) {
    generate.mockImplementation(async () => ok({ findings: [fx.OMISSION_FINDING], revisions: { cv: revision } }));
    const view = renderDrawer();
    fireEvent.click(within(await panel()).getByRole('button', { name: 'Review this application' }));
    const region = await panel();
    await within(region).findByText('Requirement the draft leaves out');
    return { region, ...view };
  }

  it('shows the requirement, where it came from, and the reviewed fact it should use', async () => {
    const { region } = await reviewWithRevision(fx.validCvRevision());
    expect(within(region).getByText(/From the job description: “Experience with Kubernetes is required\.”/u)).toBeInTheDocument();
    expect(within(region).getByText(/Your reviewed CV says: “Maintained Kubernetes clusters for internal tools\.”/u)).toBeInTheDocument();
    expect(within(region).getByText('Adds the role "Software Engineer at Blue Harbor Systems".')).toBeInTheDocument();
    fireEvent.click(within(region).getByText('Read the revised CV'));
    expect(within(region).getByText(/Maintained Kubernetes clusters for internal tools\./u, { selector: 'pre' })).toBeInTheDocument();
  });

  it('applies a suggestion only when the person says so, as a new version, and tells the page', async () => {
    const { region, onChanged } = await reviewWithRevision(fx.validCvRevision());
    expect(store.currentDrafts(db, attemptId).find((d) => d.kind === 'cv')!.version).toBe(1);
    fireEvent.click(within(region).getByRole('button', { name: 'Use this CV' }));
    expect(await within(await panel()).findByText(/Applied as version 2\. The earlier version is kept\./u)).toBeInTheDocument();
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('revised'));
    expect(store.currentDrafts(db, attemptId).find((d) => d.kind === 'cv')).toMatchObject({ version: 2, origin: 'critique_revision' });
    // The finding described the CV as it was, and the panel says so instead of re-stamping it current.
    expect(within(await panel()).getByText('Earlier version')).toBeInTheDocument();
    expect(within(await panel()).queryByRole('button', { name: 'Use this CV' })).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('declining changes nothing but the suggestion', async () => {
    const { region } = await reviewWithRevision(fx.validCvRevision());
    fireEvent.click(within(region).getByRole('button', { name: 'Not now' }));
    expect(await within(await panel()).findByText(/You declined this suggestion\. Nothing was changed\./u)).toBeInTheDocument();
    expect(store.currentDrafts(db, attemptId).find((d) => d.kind === 'cv')!.version).toBe(1);
  });

  it('never offers a suggestion that tried to add a skill the reviewed CV does not hold', async () => {
    const revision = fx.validCvRevision() as Record<string, any>;
    revision.skills.push('Terraform');
    const { region } = await reviewWithRevision(revision);
    expect(within(region).getByText(/was not offered because it did not pass the checks/u)).toBeInTheDocument();
    expect(within(region).getByText(/Terraform/u)).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: /^Use this/u })).toBeNull();
    // The finding itself, which is backed by evidence, is still shown.
    expect(within(region).getByText('Requirement the draft leaves out')).toBeInTheDocument();
  });

  it('lists what could not be checked instead of hiding it', async () => {
    generate.mockImplementation(async () => ok({ findings: [{ ...fx.OMISSION_FINDING, evidence: [{ source: 'jd', quote: 'Experience with Terraform is required.' }, { source: 'cv_fact', id: 'experience-2-bullet-1' }] }] }));
    renderDrawer();
    fireEvent.click(within(await panel()).getByRole('button', { name: 'Review this application' }));
    const region = await panel();
    expect(await within(region).findByText(/No finding could be backed by evidence the app can check/u)).toBeInTheDocument();
    fireEvent.click(within(region).getByText(/Left out because it could not be checked \(1\)/u));
    expect(within(region).getByText(/its quote is not in the text it names/u)).toBeInTheDocument();
  });
});

describe('when inputs change', () => {
  it('marks the review out of date, with the reason, and withdraws the buttons', async () => {
    generate.mockImplementation(async () => ok({ findings: [fx.OMISSION_FINDING], revisions: { cv: fx.validCvRevision() } }));
    const view = renderDrawer();
    fireEvent.click(within(await panel()).getByRole('button', { name: 'Review this application' }));
    await within(await panel()).findByRole('button', { name: 'Use this CV' });
    db.update(applicationAttempts)
      .set({ jdSnapshot: `${fx.JD}\nMore.`, jdSnapshotHash: sha(`${fx.JD}\nMore.`) })
      .where(eq(applicationAttempts.id, attemptId))
      .run();
    view.rerender(<ApplicationAttemptDrawer attempt={{ ...attemptRecord(), updatedAt: new Date(Date.now() + 5000).toISOString() }} onClose={vi.fn()} />);
    const region = await panel();
    expect(await within(region).findByText('Out of date')).toBeInTheDocument();
    expect(within(region).getAllByText(/the job description/u).length).toBeGreaterThan(0);
    expect(within(region).queryByRole('button', { name: 'Use this CV' })).toBeNull();
    expect(within(region).getByText(/may no longer apply/u)).toBeInTheDocument();
  });
});

describe('when the review does not finish', () => {
  it.each([
    ["You've hit your usage limit. Your limit resets 5pm.", /hit a usage limit\. Your documents were not changed/u],
    ['no response after 240s: the session was stopped', /did not answer in time\. Your documents were not changed/u],
  ])('says so and keeps the package (%s)', async (error, message) => {
    generate.mockImplementation(async () => ({ ok: false, text: '', error }));
    const files = workspace.listApplicationArtifacts(db, attemptId).map((a) => a.contentHash);
    renderDrawer();
    fireEvent.click(within(await panel()).getByRole('button', { name: 'Review this application' }));
    expect(await within(await panel()).findByText(message)).toBeInTheDocument();
    expect(within(await panel()).getByRole('button', { name: 'Review this application' })).toBeEnabled();
    expect(generate).toHaveBeenCalledTimes(1); // no automatic retry
    expect(workspace.listApplicationArtifacts(db, attemptId).map((a) => a.contentHash)).toEqual(files);
  });

  it('can be cancelled while it runs', async () => {
    generate.mockImplementation(
      (_prompt: string, signal: AbortSignal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, text: '', error: 'the document generation session was cancelled' }))),
    );
    renderDrawer();
    fireEvent.click(within(await panel()).getByRole('button', { name: 'Review this application' }));
    const region = await panel();
    expect(await within(region).findByText(/Reviewing your application/u)).toBeInTheDocument();
    await waitFor(() => expect(generate).toHaveBeenCalled());
    fireEvent.click(within(region).getByRole('button', { name: 'Cancel review' }));
    expect(await within(await panel()).findByText(/The review was cancelled\. Your documents were not changed\./u)).toBeInTheDocument();
    expect(within(await panel()).getByRole('button', { name: 'Review this application' })).toBeEnabled();
  });

  it('shows a plain failure, not stored text, when the main process answers with something malformed', async () => {
    invoke.mockImplementation(async (channel: string) => (channel === 'application-critique:get' ? { ok: true, view: { attemptId, junk: true } } : { ok: false }));
    renderDrawer();
    expect(await screen.findByText(/Something went wrong\. Your documents were not changed\./u)).toBeInTheDocument();
  });
});

describe('a package that was already sent', () => {
  it('says it cannot be reviewed and offers no action', async () => {
    workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'submitted', submittedAt: new Date().toISOString(), submissionMode: 'manual' });
    renderDrawer();
    const region = await panel();
    expect(await within(region).findByText(/already sent\. Its documents stay exactly as they were/u)).toBeInTheDocument();
    expect(within(region).queryByRole('button')).toBeNull();
    await act(async () => undefined);
    expect(generate).not.toHaveBeenCalled();
  });
});
