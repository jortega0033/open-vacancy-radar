import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationBriefBridge } from '../../../electron/application-brief.js';
import { createApplicationBriefHandlers } from '../../../electron/application-brief-ipc.js';
import { ApplicationDataResetGate } from '../../../electron/application-data-reset-gate.js';
import { createWorkspaceDb, type WorkspaceDb } from '../../../electron/workspace/client.js';
import * as workspace from '../../../electron/workspace/repository.js';
import { SavedJobsPage } from '../../../src/components/saved/index.js';
import { installBridges, type InstalledBridges } from '../../cv-bridges.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';
import { SOURCE, makeDeps, makeWorld, scanRow, setScan, type BriefWorld } from '../../application-brief-fixtures.js';

/**
 * The Saved jobs page with its REAL selection, confirmation and progress UI in front of the REAL
 * `window.applicationBrief` (the real preload bridge, IPC handlers, service and migrated SQLite store).
 * Only the model session is scripted, through the same `window.agentDock` seam every other AI feature
 * uses, so every `createSession` call is a counted, explicit model request.
 */

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
let exposedApis: Record<string, unknown>;

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      exposedApis[name] = api;
    },
  },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
}));

vi.setConfig({ testTimeout: 30_000 });

const JD = (n: number) =>
  `Northwind Freight is hiring role ${n}. You have ${n}+ years of TypeScript experience. Experience with Kubernetes is required for role ${n}.`;
const ANSWER = (n: number) =>
  JSON.stringify({
    requirements: [
      { text: 'TypeScript', jdAnchor: `You have ${n}+ years of TypeScript experience.`, classification: 'required', evidenceClass: 'direct', anchorParentId: 'experience-1' },
      { text: 'Kubernetes', jdAnchor: `Experience with Kubernetes is required for role ${n}.`, classification: 'required', evidenceClass: 'unsupported', anchorParentId: '' },
    ],
    hasMore: false,
  });

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let world: BriefWorld;
let bridges: InstalledBridges;
let sessions: { id: string; prompt: string }[];
/** What each model request does after it is created. */
let behaviour: (index: number) => 'answer' | 'hang' | 'fail';
const gate = new ApplicationDataResetGate();

async function installBriefBridge(): Promise<void> {
  const handlers = createApplicationBriefHandlers({ service: async () => makeDeps(db, world), mutate: (task) => gate.runMutation(task) });
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`unexpected channel ${channel}`);
    return JSON.parse(JSON.stringify(await handler(JSON.parse(JSON.stringify(payload)))));
  });
  vi.resetModules();
  exposedApis = {};
  await import('../../../electron/preload.js');
  (window as unknown as { applicationBrief: ApplicationBriefBridge }).applicationBrief = exposedApis.applicationBrief as ApplicationBriefBridge;
}

function seedJobs(count: number): void {
  const rows = Array.from({ length: count }, (_, index) =>
    scanRow({ key: `gh:200${index + 1}`, url: `https://job-boards.greenhouse.io/northwind/jobs/200${index + 1}`, title: `Platform Engineer ${index + 1}`, description: JD(index + 1) }),
  );
  setScan(world, rows, '2026-10-19T08:00:00.000Z');
  for (const row of rows) {
    workspace.createSavedJob(db, { role: row.title, company: row.company, location: row.location, vacancyKey: row.key, sourceUrl: row.url, status: 'considering' });
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-assess-ui-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  world = makeWorld();
  sessions = [];
  behaviour = () => 'answer';
  workspace.createCvDocument(db, { name: 'Main CV', kind: 'manual', text: 'Jamie Rivera.', profile: { title: 'Senior Engineer' }, source: SOURCE, isDefault: true });

  bridges = installBridges({
    agentDock: {
      createSession: vi.fn(async (input: { prompt: string }) => {
        const id = `sess-${sessions.length + 1}`;
        const index = sessions.length;
        sessions.push({ id, prompt: input.prompt });
        const n = Number(/role (\d)/u.exec(input.prompt)?.[1] ?? '1');
        const mode = behaviour(index);
        // Events arrive after the session id is known, like the real daemon stream.
        setTimeout(() => {
          if (mode === 'answer') {
            bridges.emit(id, { type: 'assistant.message', text: ANSWER(n) } as never);
            bridges.emit(id, { type: 'session.completed' } as never);
          } else if (mode === 'fail') {
            bridges.emit(id, { type: 'session.failed', message: 'provider unavailable' } as never);
          }
        }, 0);
        return { id, provider: 'claude' as const, cwd: '/x', prompt: 'p', status: 'starting' as const, startedAt: new Date().toISOString() };
      }),
    },
  });
  await installBriefBridge();
  seedJobs(3);
  installWorkspaceBridge({
    listSavedJobs: vi.fn(async () => workspace.listSavedJobs(db)),
    listCvDocuments: vi.fn(async () => workspace.listCvDocuments(db)),
    listApplicationAttempts: vi.fn(async () => []),
    listApplications: vi.fn(async () => []),
  });
});

afterEach(() => {
  delete (window as unknown as { applicationBrief?: unknown }).applicationBrief;
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function openPage() {
  render(<SavedJobsPage />);
  await screen.findByText('Platform Engineer 1');
}

const tick = (box: string) => fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`Select ${box} at Northwind Freight for assessment`, 'u') }));

describe('Assess selected jobs is an explicit, bounded action', () => {
  it('starts nothing on render, on navigation or on selecting: only an explicit confirmation sends a request', async () => {
    await openPage();
    expect(bridges.agentDock.createSession).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Assess selected jobs' })).toBeNull();

    tick('Platform Engineer 1');
    tick('Platform Engineer 2');
    const region = screen.getByRole('region', { name: 'Assess selected jobs' });
    expect(within(region).getByText(/2 selected\./u)).toBeInTheDocument();
    expect(bridges.agentDock.createSession).not.toHaveBeenCalled();

    // The confirmation names what is sent and every limit; cancelling it sends nothing.
    fireEvent.click(within(region).getByRole('button', { name: /Assess selected jobs \(2\)/u }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('sends each job');
    expect(dialog).toHaveTextContent('reviewed CV details to Claude Code');
    expect(dialog).toHaveTextContent('At most 2 requests per job (4 at most in total)');
    expect(dialog).toHaveTextContent('Each request stops after 4 minutes, and no new job starts after 15 minutes');
    expect(dialog).toHaveTextContent('cancel at any time');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(bridges.agentDock.createSession).not.toHaveBeenCalled();
  });

  it('refuses a selection over the cap in the page itself', async () => {
    workspace.createSavedJob(db, { role: 'Platform Engineer 4', company: 'Northwind Freight', location: 'Remote', status: 'considering' });
    workspace.createSavedJob(db, { role: 'Platform Engineer 5', company: 'Northwind Freight', location: 'Remote', status: 'considering' });
    workspace.createSavedJob(db, { role: 'Platform Engineer 6', company: 'Northwind Freight', location: 'Remote', status: 'considering' });
    await openPage();
    for (const n of [1, 2, 3, 4, 5, 6]) tick(`Platform Engineer ${n}`);
    const region = screen.getByRole('region', { name: 'Assess selected jobs' });
    expect(within(region).getByText(/You can assess up to 5 jobs at a time\. Untick 1\./u)).toBeInTheDocument();
    expect(within(region).getByRole('button', { name: /Assess selected jobs \(6\)/u })).toBeDisabled();
    expect(bridges.agentDock.createSession).not.toHaveBeenCalled();
  });

  it('runs one job at a time, shows per-job progress, and reports a full success only when every job is assessed', async () => {
    await openPage();
    tick('Platform Engineer 1');
    tick('Platform Engineer 2');
    fireEvent.click(screen.getByRole('button', { name: /Assess selected jobs \(2\)/u }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Start assessment' }));

    const region = screen.getByRole('region', { name: 'Assess selected jobs' });
    await within(region).findByText('Finished: 2 of 2 assessed.');
    const list = within(region).getByRole('list', { name: 'Assessment progress' });
    expect(within(list).getAllByText('Assessed')).toHaveLength(2);
    expect(within(region).getByText(/Requests used: 2 of up to 10/u)).toBeInTheDocument();
    expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(2);
    // Both assessments really were saved: they read back through the real brief bridge as current.
    const saved = workspace.listSavedJobs(db).filter((job) => ['Platform Engineer 1', 'Platform Engineer 2'].includes(job.role));
    expect(saved).toHaveLength(2);
    for (const job of saved) {
      const result = await window.applicationBrief.get({ savedJobId: job.id });
      expect(result.ok && result.view.assessment.state).toBe('current');
    }
    fireEvent.click(within(region).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('region', { name: 'Assess selected jobs' })).toBeNull();
  });

  it('cancel stops the live request, saves nothing for the interrupted job, and says which jobs were not finished', async () => {
    behaviour = (index) => (index === 0 ? 'answer' : 'hang');
    await openPage();
    tick('Platform Engineer 1');
    tick('Platform Engineer 2');
    tick('Platform Engineer 3');
    fireEvent.click(screen.getByRole('button', { name: /Assess selected jobs \(3\)/u }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Start assessment' }));
    const region = screen.getByRole('region', { name: 'Assess selected jobs' });
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(2));

    await act(async () => {
      fireEvent.click(within(region).getByRole('button', { name: 'Cancel assessment' }));
    });
    await within(region).findByText('Stopped: 1 of 3 assessed, 2 not finished.');
    expect(bridges.agentDock.cancelSession).toHaveBeenCalledWith('sess-2');
    expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(2); // the third job was never started
    expect(within(region).getByText(/Nothing was saved for it/u)).toBeInTheDocument();
    expect(workspace.listCvEvidenceOverlays(db, workspace.listCvDocuments(db)[0]!.id)).toHaveLength(1);
  });

  it('shows a failed job plainly and does not call the batch finished', async () => {
    behaviour = (index) => (index === 0 ? 'fail' : 'answer');
    await openPage();
    tick('Platform Engineer 1');
    tick('Platform Engineer 2');
    fireEvent.click(screen.getByRole('button', { name: /Assess selected jobs \(2\)/u }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Start assessment' }));
    const region = screen.getByRole('region', { name: 'Assess selected jobs' });
    await within(region).findByText('Finished with gaps: 1 of 2 assessed, 1 failed.');
    expect(within(region).getByText(/provider unavailable/u)).toBeInTheDocument();
    expect(within(region).getByText('Failed')).toBeInTheDocument();
  });

  it('leaving the page stops a live request instead of letting it run unattended', async () => {
    behaviour = () => 'hang';
    const view = render(<SavedJobsPage />);
    await screen.findByText('Platform Engineer 1');
    tick('Platform Engineer 1');
    fireEvent.click(screen.getByRole('button', { name: /Assess selected jobs \(1\)/u }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Start assessment' }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    view.unmount();
    await waitFor(() => expect(bridges.agentDock.cancelSession).toHaveBeenCalledWith('sess-1'));
  });
});
