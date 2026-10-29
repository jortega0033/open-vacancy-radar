import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationActionsBridge } from '../../../electron/application-actions-types.js';

/**
 * #692 as a person meets it: the REAL Applications page and follow-ups drawer, the REAL
 * `electron/preload.ts` (in front of a stubbed ipcRenderer), the REAL IPC handlers, service and a
 * migrated SQLite database. A model session or a network request would fail these tests: both are
 * spies that must stay untouched.
 */

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
let exposedApis: Record<string, unknown>;
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => void (exposedApis[name] = api) },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
}));

vi.setConfig({ testTimeout: 30_000 });

const { createWorkspaceDb } = await import('../../../electron/workspace/client.js');
const workspace = await import('../../../electron/workspace/repository.js');
const { ApplicationDataResetGate } = await import('../../../electron/application-data-reset-gate.js');
const { createApplicationActionsHandlers } = await import('../../../electron/application-actions-ipc.js');
const { ApplicationsPage } = await import('../../../src/components/applications/index.js');
const { installWorkspaceBridge } = await import('../../workspace-bridge.js');
import type { WorkspaceDb } from '../../../electron/workspace/client.js';

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
const gate = new ApplicationDataResetGate();
const createSession = vi.fn();
const fetchSpy = vi.fn();
let channelsSeen: string[];

const NEXT_STEP = 'Call Priya on Tuesday';
const NOTES = 'Line one\nLine two  \n';

async function installBridge(): Promise<ApplicationActionsBridge> {
  const handlers = createApplicationActionsHandlers(async () => ({ db, now: () => new Date(), mutate: (task) => gate.runMutation(task) }));
  invoke.mockImplementation(async (channel: string, payload: unknown) => {
    channelsSeen.push(channel);
    const handler = handlers[channel];
    if (!handler) throw new Error(`unexpected channel ${channel}`);
    return JSON.parse(JSON.stringify(await handler(JSON.parse(JSON.stringify(payload)))));
  });
  vi.resetModules();
  exposedApis = {};
  await import('../../../electron/preload.js');
  const bridge = exposedApis.applicationActions as ApplicationActionsBridge;
  (window as unknown as { applicationActions: ApplicationActionsBridge }).applicationActions = bridge;
  return bridge;
}

function row(over: Partial<Parameters<typeof workspace.createApplication>[1]> = {}): string {
  return workspace.createApplication(db, {
    role: 'Platform Engineer',
    company: 'Fabrikam',
    status: 'applied',
    appliedAt: '2026-10-12T09:00:00.000Z',
    nextStep: NEXT_STEP,
    notes: NOTES,
    ...over,
  }).id;
}

function renderPage() {
  installWorkspaceBridge({
    listApplications: vi.fn(async (filter: Parameters<typeof workspace.listApplications>[1]) => workspace.listApplications(db, filter)),
  });
  return render(<ApplicationsPage />);
}

const rowFor = async (company: string): Promise<HTMLElement> => {
  const cell = await screen.findByText(company, { selector: 'td' });
  return cell.closest('tr') as HTMLElement;
};

const openDrawer = async (company: string, role = 'Platform Engineer'): Promise<HTMLElement> => {
  const tr = await rowFor(company);
  fireEvent.click(within(tr).getByRole('button', { name: `Follow-ups for ${role} at ${company}` }));
  return screen.findByRole('dialog', { name: `Follow-ups for ${role} at ${company}` });
};

function fillWhen(dialog: HTMLElement, when: { date: string; time?: string; zone: string }): void {
  fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: when.date } });
  if (when.time) {
    fireEvent.click(within(dialog).getByLabelText('At a set time'));
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: when.time } });
  }
  fireEvent.change(within(dialog).getByLabelText('Time zone'), { target: { value: when.zone } });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-follow-ups-ui-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  channelsSeen = [];
  createSession.mockReset();
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  (window as unknown as { agentDock: unknown }).agentDock = { createSession, cancelSession: vi.fn(), onSessionEvent: vi.fn(() => () => {}) };
  await installBridge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('the Applications page shows follow-ups beside, never instead of, the person’s own text', () => {
  it('shows only truthful prompts: sent rows are offered a plan; draft, preparing and finished rows are not', async () => {
    row({ company: 'Sent Co' });
    row({ company: 'Draft Co', status: 'preparing', appliedAt: null });
    row({ company: 'Rejected Co', status: 'rejected' });
    row({ company: 'Interview Co', status: 'interview' });
    renderPage();
    expect(within(await rowFor('Sent Co')).getByTestId('follow-up-summary')).toHaveTextContent('No follow-up planned.');
    for (const company of ['Draft Co', 'Rejected Co', 'Interview Co']) {
      expect(within(await rowFor(company)).queryByTestId('follow-up-summary'), company).toBeNull();
    }
    // The person's own Next step text is still exactly what they wrote.
    expect(within(await rowFor('Sent Co')).getByText(NEXT_STEP)).toBeInTheDocument();
  });

  it('adds a timed follow-up through the form, with the zone and offset spelled out, and updates the row', async () => {
    const id = row();
    renderPage();
    const dialog = await openDrawer('Fabrikam');
    expect(within(dialog).getByTestId('follow-ups-empty')).toHaveTextContent('Nothing is scheduled or sent for you.');
    expect(within(dialog).getByTestId('follow-up-suggestion-line')).toHaveTextContent('no record of a reply');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Plan a follow-up' }));
    fireEvent.change(within(dialog).getByLabelText('Short title'), { target: { value: 'Ask about timing' } });
    fillWhen(dialog, { date: '2030-11-06', time: '09:30', zone: 'Europe/Amsterdam' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add follow-up' }));

    const card = await within(dialog).findByTestId('follow-up-action');
    expect(card).toHaveTextContent('Follow up: Ask about timing');
    expect(card).toHaveTextContent('09:30');
    expect(card).toHaveTextContent('Europe/Amsterdam (UTC+01:00)');
    expect(within(card).getByText('Upcoming')).toBeInTheDocument();
    expect(within(card).getByText(/Added from the follow-up prompt/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(within(screen.getByText('Fabrikam', { selector: 'td' }).closest('tr') as HTMLElement).getByTestId('follow-up-summary')).toHaveTextContent('1 upcoming'));
    expect(workspace.listApplications(db, 'all').find((r) => r.id === id)).toMatchObject({ nextStep: NEXT_STEP, notes: NOTES, status: 'applied' });
  });

  it('shows an overdue follow-up in the row and the page banner without changing the application status', async () => {
    const id = row();
    const handlers = createApplicationActionsHandlers(async () => ({ db, now: () => new Date(), mutate: (task) => gate.runMutation(task) }));
    await handlers['application-actions:create']!({
      applicationId: id,
      requestId: 'request-overdue-1',
      fields: { kind: 'follow_up', title: 'Chase', note: '', channel: 'email', contactDetail: '' },
      due: { kind: 'date', date: '2001-01-02', timeZone: 'UTC' },
      origin: 'user',
    });
    renderPage();
    const tr = await rowFor('Fabrikam');
    await waitFor(() => expect(within(tr).getByTestId('follow-up-summary')).toHaveTextContent('1 overdue'));
    expect(within(tr).getByTestId('follow-up-summary')).toHaveTextContent('was due');
    expect(screen.getByTestId('follow-ups-banner')).toHaveTextContent('1 overdue');
    expect(screen.getByTestId('follow-ups-banner')).toHaveTextContent('nothing was sent');
    expect(within(tr).getByRole('combobox', { name: /Status for/ })).toHaveValue('applied');
    expect(within(tr).getByText(NEXT_STEP)).toBeInTheDocument();
  });

  it('refuses a time the clocks skip, and asks which of two repeated times, without saving anything', async () => {
    row();
    renderPage();
    const dialog = await openDrawer('Fabrikam');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a follow-up' }));
    fillWhen(dialog, { date: '2030-03-31', time: '02:30', zone: 'Europe/Amsterdam' });
    // 2030-03-31 is the Amsterdam spring-forward day: 02:30 does not exist.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add follow-up' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('does not exist in this time zone');
    expect(within(dialog).getByTestId('follow-ups-empty')).toBeInTheDocument();

    fillWhen(dialog, { date: '2030-10-27', time: '02:30', zone: 'Europe/Amsterdam' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add follow-up' }));
    const choice = await within(dialog).findByRole('group', { name: 'Which time do you mean' });
    expect(choice).toHaveTextContent('The first time: 02:30 at UTC+02:00');
    expect(choice).toHaveTextContent('The second time: 02:30 at UTC+01:00');
    expect(within(dialog).getByTestId('follow-ups-empty')).toBeInTheDocument();

    fireEvent.click(within(choice).getByLabelText(/The second time/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add follow-up' }));
    const card = await within(dialog).findByTestId('follow-up-action');
    expect(card).toHaveTextContent('UTC+01:00');
    expect(card).toHaveTextContent('You chose the later of the two times');
  });

  it('reschedules, completes and dismisses with confirmation, keeping history', async () => {
    row();
    renderPage();
    let dialog = await openDrawer('Fabrikam');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a follow-up' }));
    fireEvent.change(within(dialog).getByLabelText('Short title'), { target: { value: 'First' } });
    fillWhen(dialog, { date: '2030-11-06', zone: 'Europe/Amsterdam' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add follow-up' }));
    await within(dialog).findByTestId('follow-up-action');
    expect(within(dialog).getByTestId('follow-up-action')).toHaveTextContent('whole day, Europe/Amsterdam');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reschedule: Follow up: First' }));
    fillWhen(dialog, { date: '2030-11-20', zone: 'Europe/Amsterdam' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(dialog).getByTestId('follow-up-action')).toHaveTextContent(/Nov(ember)? 20, 2030|20 Nov(ember)? 2030/));
    expect(within(dialog).getByTestId('follow-up-action')).toHaveTextContent('Moved 1 time');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a follow-up' }));
    fireEvent.change(within(dialog).getByLabelText('Short title'), { target: { value: 'Second' } });
    fillWhen(dialog, { date: '2030-12-01', zone: 'UTC' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add follow-up' }));
    await waitFor(() => expect(within(dialog).getAllByTestId('follow-up-action')).toHaveLength(2));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark done: Follow up: First' }));
    await waitFor(() => expect(within(dialog).getByText('History (1)')).toBeInTheDocument());

    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss: Follow up: Second' }));
    expect(within(dialog).getByText(/Dismiss it\? It stays in your history\./)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
    expect(within(dialog).getByRole('button', { name: 'Dismiss: Follow up: Second' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss: Follow up: Second' }));
    fireEvent.click(within(within(dialog).getByRole('group', { name: 'Confirm dismiss: Follow up: Second' })).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(within(dialog).getByText('History (2)')).toBeInTheDocument());
    expect(within(dialog).getByTestId('follow-ups-empty')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(within(screen.getByText('Fabrikam', { selector: 'td' }).closest('tr') as HTMLElement).getByTestId('follow-up-summary')).toHaveTextContent('No follow-up planned.'));
    dialog = await openDrawer('Fabrikam');
    fireEvent.click(within(dialog).getByText('History (2)'));
    expect(within(dialog).getByText('Done')).toBeInTheDocument();
    expect(within(dialog).getByText('Dismissed')).toBeInTheDocument();
  });

  it('a stale form cannot overwrite a newer change and says so', async () => {
    const id = row();
    renderPage();
    const dialog = await openDrawer('Fabrikam');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a follow-up' }));
    fireEvent.change(within(dialog).getByLabelText('Short title'), { target: { value: 'Original' } });
    fillWhen(dialog, { date: '2030-11-06', zone: 'UTC' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add follow-up' }));
    await within(dialog).findByTestId('follow-up-action');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit: Follow up: Original' }));
    // The same action is changed elsewhere (another window) while this form is open.
    const handlers = createApplicationActionsHandlers(async () => ({ db, now: () => new Date(), mutate: (task) => gate.runMutation(task) }));
    const current = (await handlers['application-actions:get']!({ applicationId: id })) as { view: { actions: Array<{ id: string; version: number }> } };
    await handlers['application-actions:complete']!({ applicationId: id, actionId: current.view.actions[0]!.id, expectedVersion: 1 });
    fireEvent.change(within(dialog).getByLabelText('Short title'), { target: { value: 'Stale edit' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/already completed or dismissed|changed since you opened it/);
    expect(db.select().from((await import('../../../electron/workspace/schema.js')).applicationActions).all()[0]).toMatchObject({ title: 'Original', state: 'completed' });
  });

  it('lets the person stop suggestions for an application, and nothing is offered afterwards', async () => {
    row();
    renderPage();
    const dialog = await openDrawer('Fabrikam');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop suggesting follow-ups' }));
    await waitFor(() => expect(within(dialog).getByTestId('follow-up-suggestion-line')).toHaveTextContent('You turned off follow-up suggestions'));
    expect(within(dialog).queryByRole('button', { name: 'Plan a follow-up' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(within(screen.getByText('Fabrikam', { selector: 'td' }).closest('tr') as HTMLElement).queryByTestId('follow-up-summary')).toBeNull());
  });

  it('opens, creates, edits, completes and dismisses with no model session, no request and no unrelated channel', async () => {
    row();
    renderPage();
    const dialog = await openDrawer('Fabrikam');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add a follow-up' }));
    fillWhen(dialog, { date: '2030-11-06', zone: 'UTC' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add follow-up' }));
    await within(dialog).findByTestId('follow-up-action');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Mark done/ }));
    await waitFor(() => expect(within(dialog).getByText('History (1)')).toBeInTheDocument());
    expect(createSession).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(new Set(channelsSeen.filter((channel) => channel.startsWith('application-actions:')))).toEqual(
      new Set(['application-actions:overview', 'application-actions:get', 'application-actions:create', 'application-actions:complete']),
    );
    expect(channelsSeen.every((channel) => channel.startsWith('application-actions:'))).toBe(true);
  });
});

describe('a build without the bridge keeps the page as it was', () => {
  it('shows no follow-up summary and the drawer says it is unavailable', async () => {
    row();
    delete (window as unknown as { applicationActions?: unknown }).applicationActions;
    renderPage();
    const tr = await rowFor('Fabrikam');
    expect(within(tr).queryByTestId('follow-up-summary')).toBeNull();
    fireEvent.click(within(tr).getByRole('button', { name: 'Follow-ups for Platform Engineer at Fabrikam' }));
    await act(async () => {});
    expect(await screen.findByText('Follow-ups are not available in this build.')).toBeInTheDocument();
  });
});
