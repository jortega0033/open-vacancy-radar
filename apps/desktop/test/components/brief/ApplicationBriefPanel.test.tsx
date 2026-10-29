import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationBriefBridge } from '../../../electron/application-brief.js';
import { createApplicationBriefHandlers } from '../../../electron/application-brief-ipc.js';
import { hashReviewedSource, pinForAttempt } from '../../../electron/application-brief-service.js';
import { ApplicationDataResetGate } from '../../../electron/application-data-reset-gate.js';
import { createWorkspaceDb, type WorkspaceDb } from '../../../electron/workspace/client.js';
import * as briefStore from '../../../electron/workspace/application-brief-store.js';
import * as workspace from '../../../electron/workspace/repository.js';
import { vacancyKeyFor } from '../../../electron/workspace/cv-evidence-schema.js';
import { ApplicationBriefPanel } from '../../../src/components/brief/ApplicationBriefPanel.js';
import { ApplicationAttemptDrawer } from '../../../src/components/applications/ApplicationAttemptDrawer.js';
import { SavedJobDrawer } from '../../../src/components/saved/SavedJobDrawer.js';
import {
  AGG_URL,
  ATS_URL,
  ELIGIBILITY,
  JD_V1,
  JD_V2,
  SOURCE,
  makeDeps,
  makeWorld,
  requirement,
  scanRow,
  setScan,
  type BriefWorld,
} from '../../application-brief-fixtures.js';

/**
 * The brief as a person meets it: the REAL saved-job drawer and the REAL application drawer render the
 * panel, which reads `window.applicationBrief`. That bridge is the REAL `electron/preload.ts` (against a
 * stubbed ipcRenderer) in front of the REAL IPC handlers, service and migrated SQLite store, so what is
 * asserted here crosses every production boundary except the Electron process wall. Nothing starts a
 * model session (`agentDock` throws if touched) and `fetch` is stubbed to fail.
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

vi.setConfig({ testTimeout: 20_000 });

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let world: BriefWorld;
let agentDock: { createSession: ReturnType<typeof vi.fn> };
let fetchSpy: ReturnType<typeof vi.fn>;
let savedProfilePatches: unknown[];
const gate = new ApplicationDataResetGate();

function deps() {
  return makeDeps(db, world, {
    async saveProfilePatch(patch) {
      savedProfilePatches.push(patch);
      const constraints = patch.constraints as Record<string, unknown>;
      world.profile = {
        ...world.profile!,
        profileVersion: `candidate-profile-${savedProfilePatches.length + 1}`,
        constraints: { ...world.profile!.constraints, ...constraints },
      };
    },
  });
}

async function installBridge(): Promise<ApplicationBriefBridge> {
  const handlers = createApplicationBriefHandlers({ service: async () => deps(), mutate: (task) => gate.runMutation(task) });
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`unexpected channel ${channel}`);
    // What crosses the Electron boundary is structured-cloned JSON.
    return JSON.parse(JSON.stringify(await handler(JSON.parse(JSON.stringify(payload)))));
  });
  vi.resetModules();
  exposedApis = {};
  await import('../../../electron/preload.js');
  const bridge = exposedApis.applicationBrief as ApplicationBriefBridge | undefined;
  if (!bridge) throw new Error('preload.ts did not expose applicationBrief');
  (window as unknown as { applicationBrief: ApplicationBriefBridge }).applicationBrief = bridge;
  return bridge;
}

function seedCv() {
  return workspace.createCvDocument(db, { name: 'Main CV', kind: 'manual', text: 'Jamie Rivera.', profile: { title: 'Senior Engineer' }, source: SOURCE, isDefault: true });
}

function saveJob(row = world.rows.get('gh:1001')!) {
  return workspace.createSavedJob(db, {
    role: row.title, company: row.company, location: row.location, vacancyKey: row.key, matchPercent: row.profileScore, sourceUrl: row.url, status: 'considering',
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-brief-ui-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  world = makeWorld();
  setScan(world, [scanRow({ key: 'gh:1001', url: ATS_URL })], '2026-10-19T08:00:00.000Z');
  savedProfilePatches = [];
  agentDock = {
    createSession: vi.fn(() => {
      throw new Error('the brief must never start an AI session');
    }),
  };
  (window as unknown as { agentDock: unknown }).agentDock = agentDock;
  fetchSpy = vi.fn(() => {
    throw new Error('network is not available to the application brief');
  });
  vi.stubGlobal('fetch', fetchSpy);
  await installBridge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { applicationBrief?: unknown }).applicationBrief;
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function brief() {
  return screen.getByRole('region', { name: 'Application brief' });
}

describe('the saved-job drawer shows the persisted brief', () => {
  it('shows relevance, three DIFFERENT states, provenance and the sources, without any AI or network call', async () => {
    seedCv();
    setScan(world, [scanRow({ key: 'gh:1001', url: ATS_URL, eligibility: { ...ELIGIBILITY, candidateWorkCountry: { ...ELIGIBILITY.candidateWorkCountry, answer: 'no', detail: 'Only candidates in the US.' } } })], '2026-10-19T08:00:00.000Z');
    const job = saveJob();
    render(<SavedJobDrawer job={job} onSave={vi.fn()} onClose={vi.fn()} />);

    const region = await screen.findByRole('region', { name: 'Application brief' });
    await within(region).findByText(/Search score 78 out of 100/u);
    expect(within(region).getByText(/Search scan 2026-10-19/u)).toBeInTheDocument();
    expect(within(region).getByText(/does not compare your CV/u)).toBeInTheDocument();
    expect(within(region).getByText('TypeScript, Kubernetes', { exact: false })).toBeInTheDocument();

    // Known mismatch, not known yet, and not assessed are three separate things on screen.
    expect(within(region).getByText(/Known mismatch \(/u)).toBeInTheDocument();
    expect(within(region).getByText(/Only candidates in the US\./u)).toBeInTheDocument();
    expect(within(region).getByText(/Not known yet \(/u)).toBeInTheDocument();
    expect(within(region).getByText('Not assessed yet')).toBeInTheDocument();
    expect(within(region).getByText(/That is not a low fit/u)).toBeInTheDocument();

    // Source provenance: the original link, the provider, no invented data.
    fireEvent.click(within(region).getByText(/Where this came from/u));
    const link = within(region).getByRole('link', { name: ATS_URL });
    expect(link).toHaveAttribute('href', ATS_URL);
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    expect(agentDock.createSession).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('survives navigation and a restart: close the drawer, drop the scan, reopen the database, the brief is still there', async () => {
    const job = saveJob();
    const first = render(<SavedJobDrawer job={job} onSave={vi.fn()} onClose={vi.fn()} />);
    await within(await screen.findByRole('region', { name: 'Application brief' })).findByText(/Search score 78/u);
    first.unmount();

    closeDb();
    ({ db, close: closeDb } = createWorkspaceDb(dir));
    world.rows = new Map(); // the next scan no longer has this job
    await installBridge();
    render(<SavedJobDrawer job={workspace.listSavedJobs(db)[0]!} onSave={vi.fn()} onClose={vi.fn()} />);
    const region = await screen.findByRole('region', { name: 'Application brief' });
    await within(region).findByText(/Search score 78 out of 100/u);
    expect(within(region).getByText(/Where this came from \(1\)/u)).toBeInTheDocument();
  });

  it('shows a matching grounded assessment with its evidence, and flags it out of date with the reason when the posting changes', async () => {
    const cv = seedCv();
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    const overlay = workspace.createCvEvidenceOverlay(db, {
      cvId: cv.id,
      vacancyKey: vacancyKeyFor({ title: row.title, company: row.company, location: row.location, url: row.url }),
      sourceCvContentHash: hashReviewedSource(workspace.getCvDocument(db, cv.id).source),
      jdSnapshot: JD_V1,
      jdSnapshotHash: briefStore.sha256(JD_V1),
    });
    workspace.updateCvEvidenceOverlay(db, overlay.id, {
      requirements: [
        requirement({ requirementId: 'r-ts', text: '5+ years of TypeScript', jdAnchor: 'You have 5+ years of TypeScript experience.' }),
        requirement({ requirementId: 'r-k8s', text: 'Kubernetes', jdAnchor: 'Experience with Kubernetes is required.', evidenceClass: 'unsupported', anchorParentId: '' }),
      ],
      requirementCoverage: { status: 'complete', batches: 1 },
    });
    const view = render(<SavedJobDrawer job={job} onSave={vi.fn()} onClose={vi.fn()} />);
    const region = await screen.findByRole('region', { name: 'Application brief' });
    await within(region).findByText('Up to date');
    expect(within(region).getByText('5+ years of TypeScript')).toBeInTheDocument();
    expect(within(region).getByText(/Evidence: Senior Engineer at Redwood Software/u)).toBeInTheDocument();
    expect(within(region).getByText('Kubernetes')).toBeInTheDocument();
    expect(within(region).getByText(/Material gaps/u)).toBeInTheDocument();

    view.unmount();
    world.clock = new Date('2026-10-22T09:00:00.000Z');
    setScan(world, [scanRow({ key: 'gh:1001', url: ATS_URL, description: JD_V2 })], '2026-10-22T08:00:00.000Z');
    render(<SavedJobDrawer job={job} onSave={vi.fn()} onClose={vi.fn()} />);
    const after = await screen.findByRole('region', { name: 'Application brief' });
    await within(after).findByText('Out of date');
    expect(within(after).getAllByText(/The job description changed on 2026-10-22, so the earlier assessment no longer describes this posting\./u).length).toBeGreaterThan(0);
    expect(within(after).getByText(/Earlier result \(it may no longer apply\)/u)).toBeInTheDocument();
    // What changed is also kept as a note.
    expect(within(after).getByRole('status', { name: 'What changed' })).toHaveTextContent('job description changed');
  });

  it('lets the person correct a preference: preferences change, the employer’s own statements and the stored facts do not', async () => {
    const job = saveJob();
    render(<SavedJobDrawer job={job} onSave={vi.fn()} onClose={vi.fn()} />);
    const region = await screen.findByRole('region', { name: 'Application brief' });
    const correction = await within(region).findByLabelText('Correct my preferences');
    const factsBefore = JSON.stringify(briefStore.listBriefs(db).map((row) => row.facts));
    expect(factsBefore).toContain('We cannot sponsor visas.');
    expect(correction).toHaveTextContent('changes your own preferences only');

    fireEvent.change(within(correction).getByLabelText(/Would you relocate/u), { target: { value: 'yes' } });
    fireEvent.click(within(correction).getByRole('button', { name: 'Save my preference' }));

    await waitFor(() => expect(savedProfilePatches).toEqual([{ constraints: { relocationWilling: true } }]));
    // The reason is shown on the section and kept in the "What changed" note.
    expect((await within(region).findAllByText(/You changed your relocation preference after these answers were worked out/u)).length).toBeGreaterThanOrEqual(2);
    expect(within(region).getAllByText(/employer’s own statements below are unchanged/u).length).toBeGreaterThan(0);
    expect(within(region).getByText('We cannot sponsor visas.')).toBeInTheDocument();
    expect(JSON.stringify(briefStore.listBriefs(db).map((row) => row.facts))).toBe(factsBefore);
  });
});

describe('the application drawer (the preparation flow) carries the brief and what was known at the start', () => {
  it('renders the live brief, the pinned copy and the submission evidence, and the pin never changes', async () => {
    const cv = seedCv();
    const row = world.rows.get('gh:1001')!;
    saveJob(row);
    const attempt = workspace.createApplicationAttempt(db, {
      vacancyKey: row.key, canonicalUrl: ATS_URL, company: row.company, role: row.title, sourceCvId: cv.id, sourceCvContentHash: 'x', jdSnapshot: JD_V1, jdSnapshotHash: 'j', checkpoint: 'submitted',
    });
    workspace.createApplicationSubmissionReceipt(db, { attemptId: attempt.id, outcome: 'user_reported', source: 'user_reported', evidenceKind: 'user_statement', detail: 'I applied myself.' });
    await pinForAttempt(deps(), attempt.id);
    const pinBefore = JSON.stringify(briefStore.getPin(db, attempt.id));

    // Later the posting and the score change.
    world.clock = new Date('2026-10-23T09:00:00.000Z');
    setScan(world, [scanRow({ key: 'gh:1001', url: ATS_URL, description: JD_V2, profileScore: 41 })], '2026-10-23T08:00:00.000Z');

    render(<ApplicationAttemptDrawer attempt={workspace.getApplicationAttempt(db, attempt.id)} onClose={vi.fn()} />);
    const region = await screen.findByRole('region', { name: 'Application brief' });
    await within(region).findByText(/Search score 41 out of 100/u); // the live brief moved on
    expect(within(region).getByText(/Sent \(the app observed a receipt\)/u)).toBeInTheDocument();
    const pinned = within(region).getByText('What you knew when you started preparing');
    fireEvent.click(pinned);
    expect(within(region).getByText(/Search score: 78 out of 100/u)).toBeInTheDocument(); // the pinned one did not
    expect(within(region).getByText(/Posting then: Not checked again/u)).toBeInTheDocument();
    expect(JSON.stringify(briefStore.getPin(db, attempt.id))).toBe(pinBefore);
    expect(agentDock.createSession).not.toHaveBeenCalled();
  });
});

describe('reading is guarded against stale answers', () => {
  it('never paints a slow answer for a job the panel has moved away from', async () => {
    const other = scanRow({ key: 'gh:1002', url: 'https://job-boards.greenhouse.io/northwind/jobs/1002', title: 'Data Engineer' });
    setScan(world, [world.rows.get('gh:1001')!, other], '2026-10-19T08:00:00.000Z');
    const a = saveJob(world.rows.get('gh:1001')!);
    const b = saveJob(other);

    const real = window.applicationBrief.get;
    let releaseA: (() => void) | undefined;
    window.applicationBrief.get = (async (target: Parameters<typeof real>[0]) => {
      if ('savedJobId' in target && target.savedJobId === a.id) await new Promise<void>((resolve) => (releaseA = resolve));
      return real(target);
    }) as typeof real;

    const view = render(<ApplicationBriefPanel target={{ savedJobId: a.id }} />);
    view.rerender(<ApplicationBriefPanel target={{ savedJobId: b.id }} />);
    await screen.findByText(/Search score 78/u);
    expect(briefRegionText()).not.toContain('Platform Engineer');
    await act(async () => {
      releaseA?.();
    });
    // The late answer for job A is dropped: the panel still describes job B.
    expect(briefRegionText()).toContain('Search score 78');
    expect(briefStore.listBriefs(db)).toHaveLength(2);
    expect(brief()).toBeInTheDocument();
  });

  it('says nothing (not an error) when the bridge is missing, so an older build never breaks the drawer', () => {
    delete (window as unknown as { applicationBrief?: unknown }).applicationBrief;
    const { container } = render(<ApplicationBriefPanel target={{ savedJobId: 'x' }} />);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows a plain failure for a job that no longer exists', async () => {
    render(<ApplicationBriefPanel target={{ savedJobId: 'gone' }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer in your list');
  });
});

function briefRegionText(): string {
  return screen.queryByRole('region', { name: 'Application brief' })?.textContent ?? '';
}

// A second source copy proves the panel lists provenance per copy.
describe('source copies in one brief', () => {
  it('lists every original source reference with its provider label', async () => {
    const merged = scanRow({
      key: 'remotive:77',
      url: AGG_URL,
      sources: [
        { provider: 'remotive', key: 'remotive:77', url: AGG_URL },
        { provider: 'ats_roster_greenhouse', key: 'gh:1001', url: ATS_URL },
      ],
    });
    setScan(world, [merged], '2026-10-19T08:00:00.000Z');
    const job = saveJob(merged);
    render(<ApplicationBriefPanel target={{ savedJobId: job.id }} />);
    const region = await screen.findByRole('region', { name: 'Application brief' });
    await within(region).findByText(/Search score/u);
    fireEvent.click(within(region).getByText(/Where this came from/u));
    expect(within(region).getByText('Remotive')).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: AGG_URL })).toBeInTheDocument();
    expect(within(region).getByRole('link', { name: ATS_URL })).toBeInTheDocument();
  });
});
