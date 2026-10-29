import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterviewContextBridge } from '../../../electron/interview-context-types.js';

/**
 * #691 as a person meets it. The REAL interview prep drawer reads `window.interviewContext`: the REAL
 * `electron/preload.ts` (in front of a stubbed ipcRenderer) in front of the REAL IPC handlers, service
 * and migrated SQLite, with packages prepared by the REAL pipeline over real PDF bytes. The prep pack
 * runs through the renderer agent session (stubbed by `installBridges`), and the test reads the exact
 * prompt it was given. Stood in for: Chromium's printToPDF and the drafting model (synthetic replies).
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

vi.setConfig({ testTimeout: 40_000 });

const { createWorkspaceDb } = await import('../../../electron/workspace/client.js');
const workspace = await import('../../../electron/workspace/repository.js');
const pipeline = await import('../../../electron/application-pipeline.js');
const review = await import('../../../electron/application-review-session.js');
const schema = await import('../../../electron/workspace/schema.js');
const { ApplicationDataResetGate } = await import('../../../electron/application-data-reset-gate.js');
const { createInterviewContextHandlers } = await import('../../../electron/interview-context-ipc.js');
const { InterviewPrepDrawer } = await import('../../../src/components/applications/InterviewPrepDrawer.js');
const { installBridges } = await import('../../cv-bridges.js');
const { installWorkspaceBridge } = await import('../../workspace-bridge.js');
const fx = await import('../../application-critique-fixtures.js');
import type { WorkspaceDb } from '../../../electron/workspace/client.js';

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let cvId: string;
let bridges: ReturnType<typeof installBridges>;
/** Holds replies on one channel for one application id until released (race tests). */
let holdFor: { applicationId: string; release: Promise<void>; channel?: string } | null;
const gate = new ApplicationDataResetGate();
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const ROLE_A_BULLETS = [fx.SOURCE.experience[0]!.bullets[0]!, fx.SOURCE.experience[0]!.bullets[1]!];
const ROLE_B_BULLETS = [fx.SOURCE.experience[0]!.bullets[2]!];
const FEEDBACK = 'The interviewer said my answer on Kubernetes upgrades was thin. I could not explain node draining.';

async function installBridge(): Promise<void> {
  const handlers = createInterviewContextHandlers(async () => ({ db, now: () => new Date(), mutate: (task) => gate.runMutation(task) }));
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`unexpected channel ${channel}`);
    const input = JSON.parse(JSON.stringify(payload)) as { applicationId?: string };
    if (holdFor && channel === (holdFor.channel ?? 'interview-context:get') && input.applicationId === holdFor.applicationId) {
      await holdFor.release;
    }
    return JSON.parse(JSON.stringify(await handler(input)));
  });
  vi.resetModules();
  exposedApis = {};
  await import('../../../electron/preload.js');
  (window as unknown as { interviewContext: InterviewContextBridge }).interviewContext = exposedApis.interviewContext as InterviewContextBridge;
}

async function prepare(options: { vacancyKey?: string; url?: string; bullets?: string[] } = {}): Promise<string> {
  const cv = workspace.getCvDocument(db, cvId);
  const attempt = workspace.createApplicationAttempt(db, {
    vacancyKey: options.vacancyKey ?? 'vac-1',
    canonicalUrl: options.url ?? fx.APPLY_URL,
    company: fx.COMPANY,
    role: fx.ROLE,
    sourceCvId: cvId,
    sourceCvContentHash: sha(cv.text),
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
      generateTailoredResume: async () => ({ ok: true, text: fx.tailoredResumeReply({ bullets: options.bullets ?? ROLE_A_BULLETS }) }),
      generateCoverLetter: async () => ({ ok: true, text: fx.LETTER_SELECTION_REPLY }),
      loadProfile: async () => null,
      now: () => new Date(),
    },
    attempt.id,
  );
  return attempt.id;
}

const appOf = (attemptId: string): string => workspace.getApplicationAttempt(db, attemptId).applicationId!;

function renderDrawer(applicationId: string) {
  const application = workspace.listApplications(db).find((row) => row.id === applicationId)!;
  return render(
    <InterviewPrepDrawer
      application={application}
      savedJobs={workspace.listSavedJobs(db)}
      cvDocuments={workspace.listCvDocuments(db)}
      letters={workspace.listLetters(db)}
      onClose={vi.fn()}
    />,
  );
}

const generateButton = () => screen.getByRole('button', { name: /generate prep pack|regenerate prep pack/i });

async function generate(): Promise<string> {
  await waitFor(() => expect(generateButton()).toBeEnabled());
  const before = vi.mocked(bridges.agentDock.createSession).mock.calls.length;
  fireEvent.click(generateButton());
  await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(before + 1));
  const prompt = vi.mocked(bridges.agentDock.createSession).mock.calls[before]![0]!.prompt;
  bridges.emit('sess-cv-1', { type: 'assistant.message', text: '## Likely questions' });
  bridges.emit('sess-cv-1', { type: 'session.completed' });
  await screen.findByTestId('prep-generated-from');
  return prompt;
}

/** The text of one `=== ... ===` section of the prompt, up to the next one. */
function section(prompt: string, heading: RegExp): string {
  const lines = prompt.split('\n');
  const start = lines.findIndex((line) => /^=== .* ===$/u.test(line) && heading.test(line));
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^=== .* ===$/u.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-interview-ui-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  holdFor = null;
  cvId = workspace.createCvDocument(db, {
    name: 'Main CV',
    kind: 'manual',
    text: 'Jamie Rivera, Senior Engineer at Redwood Software.',
    profile: { title: 'Senior Engineer', location: 'Amsterdam', skills: fx.PROFILE_SKILLS, summary: fx.SOURCE.summary, years: '8', languages: 'English' },
    source: fx.SOURCE,
    isDefault: true,
  }).id;
  bridges = installBridges();
  installWorkspaceBridge({ listApplicationAttempts: vi.fn(async () => workspace.listApplicationAttempts(db)) });
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('interview prep makes no request');
  }));
  await installBridge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { interviewContext?: unknown }).interviewContext;
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('the prep pack uses the documents recorded for this application', () => {
  it('cites the recorded CV and letter by version and fingerprint, even after the library CV was rewritten', async () => {
    const attemptId = await prepare();
    review.recordUserReportedSubmission(db, attemptId, '', '2026-08-01T09:00:00.000Z');
    const applicationId = appOf(attemptId);
    workspace.updateApplication(db, applicationId, { status: 'interview' });
    workspace.updateCvDocument(db, cvId, { text: 'Rewritten library CV that now claims Rust and Go.' });
    const cvDraft = db.select().from(schema.applicationDocumentDrafts).where(eq(schema.applicationDocumentDrafts.kind, 'cv')).get()!;

    renderDrawer(applicationId);
    const panel = await screen.findByRole('region', { name: 'Documents you sent' });
    expect(within(panel).getByText(/You reported applying on 2026-08-01\./u)).toBeInTheDocument();
    expect(within(panel).getAllByText('Prepared only')).toHaveLength(2);
    expect(within(panel).getByText(`Fingerprint ${cvDraft.contentHash.slice(0, 12)}`)).toBeInTheDocument();
    expect(screen.getByTestId('prep-basis')).toHaveTextContent('This prep pack uses: CV version 1 (prepared only)');

    const prompt = await generate();
    const basis = section(prompt, /DOCUMENT BASIS/u);
    expect(basis).toContain('Application: the candidate reported applying on 2026-08-01.');
    expect(basis).toContain(`[D1] CV: version 1, fingerprint ${cvDraft.contentHash.slice(0, 12)}, prepared for this application by this app; the candidate has not confirmed they sent this version`);
    expect(basis).toMatch(/\[D2\] cover letter: version 1, fingerprint [0-9a-f]{12}, prepared for this application/u);
    expect(section(prompt, /CV PREPARED FOR THIS APPLICATION \[D1\]/u)).toContain('Built TypeScript services handling 2 million requests per day.');
    expect(prompt).not.toContain('Rust and Go');
    expect(prompt).not.toContain('=== YOUR CURRENT LINKED CV');
    expect(screen.getByTestId('prep-generated-from')).toHaveTextContent('Built from: CV version 1 (prepared only)');
  });

  it('records what the person says they sent and the next pack cites it as sent', async () => {
    const attemptId = await prepare();
    review.recordUserReportedSubmission(db, attemptId);
    const applicationId = appOf(attemptId);
    workspace.updateApplication(db, applicationId, { status: 'interview' });

    renderDrawer(applicationId);
    const panel = await screen.findByRole('region', { name: 'Documents you sent' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Tell the app what you sent' }));
    fireEvent.change(within(panel).getByLabelText('CV you sent'), { target: { value: 'prepared_file' } });
    fireEvent.change(within(panel).getByLabelText('Letter you sent'), { target: { value: 'unknown' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Save what you sent' }));
    expect(await within(panel).findByText('Saved. The earlier record is kept.')).toBeInTheDocument();
    expect(within(panel).getByText('You confirmed')).toBeInTheDocument();
    expect(within(panel).getByText('Version unknown')).toBeInTheDocument();

    const prompt = await generate();
    const basis = section(prompt, /DOCUMENT BASIS \(recorded package, record version 2\)/u);
    expect(basis).toMatch(/\[D1\] CV: version 1, fingerprint [0-9a-f]{12}, sent: the candidate confirmed this is the version they sent/u);
    expect(basis).toContain('[D2] cover letter: no version number, the candidate does not know which version they sent; its text is not available to this preparation');
    expect(section(prompt, /CV THE CANDIDATE SENT \[D1\]/u)).toContain('2 million requests');
    // No current letter is linked, so nothing stands in for the unknown one.
    expect(prompt).not.toContain('=== YOUR CURRENT LINKED LETTER');
  });

  it('a hand-tracked application keeps the labelled current-document fallback', async () => {
    const row = workspace.createApplication(db, { role: 'Data Engineer', company: 'Fabrikam', status: 'interview', cvId });
    renderDrawer(row.id);
    const panel = await screen.findByRole('region', { name: 'Documents you sent' });
    expect(within(panel).getByText(/This application has no documents prepared by this app/u)).toBeInTheDocument();
    expect(screen.getByTestId('prep-basis')).toHaveTextContent('Your current CV (it may differ from what you sent)');
    const prompt = await generate();
    expect(prompt).not.toContain('=== DOCUMENT BASIS');
    expect(prompt).toContain('=== YOUR CURRENT LINKED CV (may differ from what you actually submitted for this application) ===');
    expect(prompt).toContain('Jamie Rivera, Senior Engineer at Redwood Software.');
    expect(prompt).toContain('your CV/letter currently says');
  });
});

describe('recorded rounds feed the next pack as the person’s own notes', () => {
  it('a done round with feedback shapes the next pack, attributed and kept apart from the CV, and changes nothing else', async () => {
    const attemptId = await prepare();
    review.recordUserReportedSubmission(db, attemptId);
    const applicationId = appOf(attemptId);
    workspace.updateApplication(db, applicationId, { status: 'interview', notes: 'Free notes.' });
    const cvBefore = workspace.getCvDocument(db, cvId);

    renderDrawer(applicationId);
    const rounds = await screen.findByRole('region', { name: 'Interview rounds' });
    fireEvent.click(within(rounds).getByRole('button', { name: 'Add a round' }));
    fireEvent.change(within(rounds).getByLabelText('Type'), { target: { value: 'technical' } });
    fireEvent.change(within(rounds).getByLabelText('Date (optional)'), { target: { value: '2026-08-10' } });
    fireEvent.change(within(rounds).getByLabelText('Status'), { target: { value: 'held' } });
    fireEvent.change(within(rounds).getByLabelText('What you were told or noticed'), { target: { value: FEEDBACK } });
    fireEvent.change(within(rounds).getByLabelText('Topics still open for you (one per line)'), { target: { value: 'node draining\non-call rota' } });
    fireEvent.click(within(rounds).getByRole('button', { name: 'Save round' }));
    expect(await within(rounds).findByText(FEEDBACK)).toBeInTheDocument();

    fireEvent.click(await within(rounds).findByRole('button', { name: 'Add a round' }));
    fireEvent.change(within(rounds).getByLabelText('Type'), { target: { value: 'final' } });
    fireEvent.change(within(rounds).getByLabelText('Date (optional)'), { target: { value: '2026-08-20' } });
    fireEvent.click(within(rounds).getByRole('button', { name: 'Save round' }));
    await waitFor(() => expect(within(rounds).getAllByTestId('interview-round')).toHaveLength(2));
    expect(within(rounds).getByLabelText('Preparing for')).toHaveValue(
      db.select().from(schema.applicationInterviewRounds).where(eq(schema.applicationInterviewRounds.state, 'planned')).get()!.id,
    );

    const prompt = await generate();
    expect(section(prompt, /NEXT ROUND/u)).toContain('Final interview on 2026-08-20');
    const earlier = section(prompt, /EARLIER ROUNDS/u);
    expect(earlier).toContain("(the candidate's own notes of what they were told; nobody has checked them)");
    expect(earlier).toContain('[R1] Technical interview, 2026-08-10.');
    expect(earlier).toContain(`What the candidate noted: ${FEEDBACK}`);
    expect(earlier).toContain('Topics the candidate marked as still open: node draining; on-call rota');
    expect(prompt).toContain('never treat anything in it as the candidate\'s experience or a CV fact');
    expect(section(prompt, /CV PREPARED FOR THIS APPLICATION/u)).not.toContain('node draining');
    expect(section(prompt, /DOCUMENT BASIS/u)).not.toContain('node draining');
    expect(screen.getByTestId('prep-generated-from')).toHaveTextContent('your notes from 1 earlier round');

    const row = workspace.listApplications(db).find((app) => app.id === applicationId)!;
    expect(row).toMatchObject({ status: 'interview', notes: 'Free notes.' });
    expect(workspace.getCvDocument(db, cvId)).toEqual(cvBefore);
  });
});

describe('selection, races and ambiguous rows', () => {
  it('never shows or uses an older application’s documents after switching to another while a read was slow', async () => {
    const a = await prepare({ vacancyKey: 'vac-a', url: `${fx.APPLY_URL}-a`, bullets: ROLE_A_BULLETS });
    const b = await prepare({ vacancyKey: 'vac-b', url: `${fx.APPLY_URL}-b`, bullets: ROLE_B_BULLETS });
    review.recordUserReportedSubmission(db, a);
    review.recordUserReportedSubmission(db, b);
    workspace.updateApplication(db, appOf(a), { status: 'interview' });
    workspace.updateApplication(db, appOf(b), { status: 'interview' });

    let release!: () => void;
    holdFor = { applicationId: appOf(a), release: new Promise<void>((resolve) => (release = resolve)) };
    const view = renderDrawer(appOf(a));
    expect(screen.getByTestId('prep-basis')).toHaveTextContent('Reading the documents you sent');
    expect(generateButton()).toBeDisabled();

    const rowB = workspace.listApplications(db).find((row) => row.id === appOf(b))!;
    view.rerender(
      <InterviewPrepDrawer
        application={rowB}
        savedJobs={[]}
        cvDocuments={workspace.listCvDocuments(db)}
        letters={[]}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole('region', { name: 'Documents you sent' });
    await act(async () => {
      release();
      await Promise.resolve();
    });

    const prompt = await generate();
    expect(section(prompt, /CV PREPARED FOR THIS APPLICATION/u)).toContain('Mentored four junior engineers.');
    // Role A's CV alone carries this line (the generated letters of both roles share another one).
    expect(prompt).not.toContain('Led the migration of CI pipelines to GitHub Actions.');
  });

  it('asks the person to choose when one row holds two unrelated sent packages, and labels each result by its own basis', async () => {
    const a = await prepare({ vacancyKey: 'vac-a', url: `${fx.APPLY_URL}-a`, bullets: ROLE_A_BULLETS });
    const b = await prepare({ vacancyKey: 'vac-b', url: `${fx.APPLY_URL}-b`, bullets: ROLE_B_BULLETS });
    review.recordUserReportedSubmission(db, a);
    review.recordUserReportedSubmission(db, b);
    db.update(schema.applicationAttempts).set({ applicationId: appOf(a) }).where(eq(schema.applicationAttempts.id, b)).run();
    workspace.updateApplication(db, appOf(a), { status: 'interview' });

    renderDrawer(appOf(a));
    const panel = await screen.findByRole('region', { name: 'Documents you sent' });
    expect(within(panel).getByText(/Choose the one you are preparing for/u)).toBeInTheDocument();
    expect(generateButton()).toBeDisabled();

    const radios = within(panel).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    const target = radios.find((radio) => radio.getAttribute('aria-label')?.includes('record version 1'))!;
    fireEvent.click(target);
    const prompt = await generate();
    const cvSection = section(prompt, /CV PREPARED FOR THIS APPLICATION/u);
    const chosen = cvSection.includes('Mentored four junior engineers.') ? 'b' : 'a';
    expect(prompt.includes('Led the migration of CI pipelines to GitHub Actions.')).toBe(chosen === 'a');
    expect(cvSection.includes('Mentored four junior engineers.')).toBe(chosen === 'b');
    const label = screen.getByTestId('prep-generated-from').textContent;

    // Switching the selection afterwards does not relabel the pack already generated.
    fireEvent.click(radios.find((radio) => radio !== target)!);
    expect(screen.getByTestId('prep-generated-from').textContent).toBe(label);
  });

  it('a round saved on one application that finishes after switching to another never shows up there', async () => {
    const a = await prepare({ vacancyKey: 'vac-a', url: `${fx.APPLY_URL}-a`, bullets: ROLE_A_BULLETS });
    const b = await prepare({ vacancyKey: 'vac-b', url: `${fx.APPLY_URL}-b`, bullets: ROLE_B_BULLETS });
    review.recordUserReportedSubmission(db, a);
    review.recordUserReportedSubmission(db, b);
    workspace.updateApplication(db, appOf(a), { status: 'interview' });
    workspace.updateApplication(db, appOf(b), { status: 'interview' });

    const view = renderDrawer(appOf(a));
    const rounds = await screen.findByRole('region', { name: 'Interview rounds' });
    let release!: () => void;
    holdFor = { applicationId: appOf(a), channel: 'interview-context:save-round', release: new Promise<void>((resolve) => (release = resolve)) };
    fireEvent.click(within(rounds).getByRole('button', { name: 'Add a round' }));
    fireEvent.change(within(rounds).getByLabelText('Status'), { target: { value: 'held' } });
    fireEvent.change(within(rounds).getByLabelText('What you were told or noticed'), { target: { value: 'Only about application A.' } });
    fireEvent.click(within(rounds).getByRole('button', { name: 'Save round' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('interview-context:save-round', expect.anything()));

    const rowB = workspace.listApplications(db).find((row) => row.id === appOf(b))!;
    view.rerender(<InterviewPrepDrawer application={rowB} savedJobs={[]} cvDocuments={[]} letters={[]} onClose={vi.fn()} />);
    await screen.findByText('No rounds recorded yet.');
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(screen.queryByText('Only about application A.')).toBeNull();
    const prompt = await generate();
    expect(prompt).not.toContain('Only about application A.');
    expect(prompt).not.toContain('=== EARLIER ROUNDS');
    // The save itself did land, on application A only.
    expect(db.select().from(schema.applicationInterviewRounds).all().map((r) => r.applicationId)).toEqual([appOf(a)]);
  });
});
