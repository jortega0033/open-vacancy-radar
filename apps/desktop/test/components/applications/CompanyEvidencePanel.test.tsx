import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CrawlerHttpError, type AtsHttpClient } from '@open-vacancy-radar/vacancy-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyEvidenceBridge } from '../../../electron/company-evidence.js';
import { createCompanyEvidenceHandlers } from '../../../electron/company-evidence-ipc.js';
import {
  parseCancelResult,
  parseCompanyEvidenceProse,
  parseCompanyEvidenceResult,
} from '../../../electron/company-evidence-parse.js';
import { CompanyEvidenceRuns, type CompanyEvidenceDeps } from '../../../electron/company-evidence-service.js';
import { createWorkspaceDb, type WorkspaceDb } from '../../../electron/workspace/client.js';
import * as workspace from '../../../electron/workspace/repository.js';
import { CompanyEvidencePanel } from '../../../src/components/applications/CompanyEvidencePanel.js';
import { InterviewPrepDrawer } from '../../../src/components/applications/InterviewPrepDrawer.js';
import { installBridges } from '../../cv-bridges.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';

/**
 * The evidence panel and the interview drawer driven against the REAL main-process handlers and a
 * migrated SQLite database: `window.companyEvidence` is the same handlers + the same fail-closed
 * parsers the preload uses, so what these tests click is what a person gets. Only the public web
 * (an in-memory page map) and the model session are replaced.
 */

const NORTHWIND = 'https://job-boards.greenhouse.io/northwind/jobs/1001';
const NORTHWIND_DATA = 'https://job-boards.greenhouse.io/northwind/jobs/1002';
const ABOUT = 'https://northwind.example/about';
const QUOTE = 'Northwind Freight operates 14 depots across the Netherlands and Belgium';
const CLAIM = 'Northwind Freight operates 14 depots across the Netherlands and Belgium.';

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let pages: Map<string, string | Error>;
let research: ReturnType<typeof vi.fn>;
const runs = new CompanyEvidenceRuns();

function bridge(): CompanyEvidenceBridge {
  const deps: CompanyEvidenceDeps = {
    db,
    now: () => new Date('2026-10-05T10:00:00.000Z'),
    getHttp: async () =>
      ({
        get: async (url: string) => {
          const page = pages.get(url);
          if (!page) throw new CrawlerHttpError({ category: 'http_error', code: 'http_status', url, detail: 'gone', status: 404 });
          if (page instanceof Error) throw page;
          return { status: 200, finalUrl: url, headers: {}, body: `<p>${page}</p>` };
        },
        postJson: async () => {
          throw new Error('unused');
        },
      }) as AtsHttpClient,
    runResearch: research as unknown as CompanyEvidenceDeps['runResearch'],
  };
  const handlers = createCompanyEvidenceHandlers({ service: async () => deps, runs, mutate: (task) => Promise.resolve(task()) });
  const call = async (channel: string, payload: object) => parseCompanyEvidenceResult(await handlers[channel]!(payload));
  return {
    get: (t) => call('company-evidence:get', { ...t }),
    prose: async (t) => parseCompanyEvidenceProse(await handlers['company-evidence:prose']!({ ...t })),
    confirmDomain: (t, input) => call('company-evidence:confirm-domain', { ...t, ...input }),
    addFact: (t, input) => call('company-evidence:add-fact', { ...t, ...input }),
    confirmFact: (t, factId) => call('company-evidence:confirm-fact', { ...t, factId }),
    correctFact: (t, factId, claim) => call('company-evidence:correct-fact', { ...t, factId, claim }),
    withdrawFact: (t, factId) => call('company-evidence:withdraw-fact', { ...t, factId }),
    resolveContradiction: (t, contradictionId, keepFactId) => call('company-evidence:resolve-contradiction', { ...t, contradictionId, keepFactId }),
    decideLink: (t, linkId, decision) => call('company-evidence:decide-link', { ...t, linkId, decision }),
    deleteRecord: (t) => call('company-evidence:delete', { ...t }),
    refresh: (t) => call('company-evidence:refresh', { ...t }),
    research: (t, options) => call('company-evidence:research', { ...t, ...(options ?? {}) }),
    cancel: async (t) => parseCancelResult(await handlers['company-evidence:cancel']!({ ...t })),
  };
}

function attempt(company: string, role: string, url: string, applicationId?: string) {
  return workspace.createApplicationAttempt(db, {
    company,
    role,
    canonicalUrl: url,
    sourceCvContentHash: 'h',
    jdSnapshot: 'Synthetic public description.',
    jdSnapshotHash: 'j',
    force: true,
    ...(applicationId ? { applicationId } : {}),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-evidence-ui-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  pages = new Map([
    [ABOUT, `${QUOTE}. Founded in 2009`],
    [NORTHWIND_DATA, 'The Data Engineer role works on the depot forecasting pipeline'],
  ]);
  research = vi.fn();
  (window as unknown as { companyEvidence: CompanyEvidenceBridge }).companyEvidence = bridge();
});

afterEach(() => {
  delete (window as unknown as { companyEvidence?: unknown }).companyEvidence;
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function addThroughForm(claim: string, url: string, quote: string) {
  fireEvent.click(screen.getByText('Add a source yourself'));
  fireEvent.change(screen.getByLabelText(/what the source says/i), { target: { value: claim } });
  fireEvent.change(screen.getByLabelText(/public page address/i), { target: { value: url } });
  fireEvent.change(screen.getByLabelText(/passage copied/i), { target: { value: quote } });
  fireEvent.click(screen.getByRole('button', { name: 'Save claim' }));
}

describe('CompanyEvidencePanel', () => {
  it('asks for the employer\'s own website when only a name is known, and a job board does not count', async () => {
    const harbor = attempt('Harbor Systems', 'Support Engineer', 'https://www.jobgether.com/offer/abc');
    render(<CompanyEvidencePanel target={{ attemptId: harbor.id }} />);
    const missing = await screen.findByTestId('company-identity-missing');
    expect(missing).toHaveTextContent('a name or a register match is not enough');
    expect(screen.queryByRole('button', { name: 'Research this company' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Company website'), { target: { value: 'jobgether.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm website' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('own website address, not a job board');

    fireEvent.change(screen.getByLabelText('Company website'), { target: { value: 'harbor-systems.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm website' }));
    expect(await screen.findByTestId('company-identity')).toHaveTextContent('a website you confirmed (harbor-systems.example)');
  });

  it('shows scope, source, original check time and why a claim is or is not used', async () => {
    const platform = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    attempt('Northwind Freight', 'Data Engineer', NORTHWIND_DATA);
    render(<CompanyEvidencePanel target={{ attemptId: platform.id }} />);
    await screen.findByTestId('company-identity');

    await addThroughForm('Northwind Freight operates 14 depots across the Netherlands and Belgium.', ABOUT, QUOTE);
    const used = await screen.findByText(CLAIM);
    const card = used.closest('[data-testid="company-fact"]') as HTMLElement;
    expect(card).toHaveAttribute('data-support', 'supported');
    expect(within(card).getByText('Used')).toBeInTheDocument();
    expect(within(card).getByText('Company')).toBeInTheDocument();
    expect(within(card).getByText('Source checked')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'northwind.example' })).toHaveAttribute('href', ABOUT);
    expect(card).toHaveTextContent('Last checked');
    expect(card).toHaveTextContent('Valid until');

    // A claim from a page that does not contain the quote stays a lead, with the reason spelled out.
    await addThroughForm('Northwind Freight has a rail division.', ABOUT, 'Northwind Freight has a rail division in Antwerp');
    const lead = (await screen.findByText('Northwind Freight has a rail division.')).closest('[data-testid="company-fact"]') as HTMLElement;
    await waitFor(() => expect(lead).toHaveAttribute('data-support', 'lead'));
    expect(within(lead).getByText('Lead only')).toBeInTheDocument();
    expect(lead).toHaveTextContent('The source has not been confirmed to say this.');
    expect(screen.getByText('Leads that are not used')).toBeInTheDocument();
  });

  it('keeps another role\'s claim out of the way and labels it', async () => {
    const platform = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const data = attempt('Northwind Freight', 'Data Engineer', NORTHWIND_DATA);
    const api = bridge();
    await api.addFact({ attemptId: data.id }, { claim: 'The Data Engineer works on depot forecasting.', sourceUrl: NORTHWIND_DATA, quote: 'The Data Engineer role works on the depot forecasting pipeline', scope: 'role', topic: 'general' });
    render(<CompanyEvidencePanel target={{ attemptId: platform.id }} />);
    const summary = await screen.findByText(/About other roles at this company \(1\)/);
    const details = summary.closest('details') as HTMLElement;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('Other role: Data Engineer');
    expect(details).toHaveTextContent('About a different role, so it is not used for this one.');
    expect(screen.getByTestId('company-identity')).toHaveTextContent('0 used, 0 leads');
  });

  it('lets the person decide a disagreement and a similar-name suggestion, in plain words', async () => {
    const platform = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const group = attempt('Northwind Freight Group', 'Dispatcher', 'https://careers.northwind-freight-group.example/jobs/9');
    pages.set(ABOUT, 'Northwind Freight has 200 employees');
    pages.set('https://news.example/n', 'Northwind Freight employs about 450 people in total');
    pages.set('https://northwind-freight-group.example/about', 'Northwind Freight Group runs a dispatch centre in Rotterdam for its own fleet');
    const api = bridge();
    await api.addFact({ attemptId: platform.id }, { claim: 'Northwind Freight has 200 employees.', sourceUrl: ABOUT, quote: 'Northwind Freight has 200 employees', scope: 'company', topic: 'size' });
    await api.addFact({ attemptId: platform.id }, { claim: 'Northwind Freight employs about 450 people.', sourceUrl: 'https://news.example/n', quote: 'Northwind Freight employs about 450 people in total', scope: 'company', topic: 'size' });
    await api.addFact({ attemptId: group.id }, { claim: 'Northwind Freight Group runs a dispatch centre in Rotterdam.', sourceUrl: 'https://northwind-freight-group.example/about', quote: 'Northwind Freight Group runs a dispatch centre in Rotterdam for its own fleet', scope: 'company', topic: 'general' });

    const onChanged = vi.fn();
    render(<CompanyEvidencePanel target={{ attemptId: platform.id }} onChanged={onChanged} />);
    const dispute = await screen.findByTestId('company-contradiction');
    expect(dispute).toHaveTextContent('Two sources disagree about size. Neither is used until you choose.');
    expect(screen.queryByText('Used in letters and interview prep')).toBeNull();
    fireEvent.click(within(dispute).getAllByRole('button', { name: 'Keep this one' })[0]!);
    await waitFor(() => expect(screen.queryByTestId('company-contradiction')).toBeNull());
    expect(await screen.findByText('Used in letters and interview prep')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();

    const proposal = await screen.findByTestId('company-link-proposal');
    expect(proposal).toHaveTextContent('Northwind Freight Group (northwind-freight-group.example) has a similar name but a different website');
    expect(proposal).toHaveTextContent('Nothing is shared until you say so, and role claims are never shared.');
    fireEvent.click(within(proposal).getByRole('button', { name: 'Different company' }));
    await waitFor(() => expect(screen.queryByTestId('company-link-proposal')).toBeNull());
  });

  it('runs research on request, shows Stop while it runs, and reports the outcome without touching what is saved', async () => {
    const platform = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    let release: ((value: unknown) => void) | undefined;
    research.mockImplementation(
      (_input: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          release = resolve;
          signal.addEventListener('abort', () => resolve({ status: 'cancelled', reason: 'cancelled_by_user', candidates: [], queries: [], searches: 1, fetches: 0 }), { once: true });
        }),
    );
    render(<CompanyEvidencePanel target={{ attemptId: platform.id }} />);
    await screen.findByTestId('company-identity');
    expect(research).not.toHaveBeenCalled(); // reading never researches

    fireEvent.click(screen.getByRole('button', { name: 'Research this company' }));
    const stop = await screen.findByRole('button', { name: 'Stop' });
    expect(screen.getByRole('button', { name: 'Researching...' })).toBeDisabled();
    expect(screen.getByText(/Your CV, letters and notes are never sent/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(stop);
    });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Stopped. Nothing was added and your drafts are unchanged.'));
    expect(screen.getByText('Nothing saved for this company yet.')).toBeInTheDocument();
    release?.({});
  });

  it('deletes only after a second, explicit confirmation and says prepared documents keep what they said', async () => {
    const platform = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    await bridge().addFact({ attemptId: platform.id }, { claim: CLAIM, sourceUrl: ABOUT, quote: QUOTE, scope: 'company', topic: 'general' });
    render(<CompanyEvidencePanel target={{ attemptId: platform.id }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete company evidence' }));
    const confirm = screen.getByRole('group', { name: 'Confirm delete' });
    expect(confirm).toHaveTextContent('Documents already prepared keep what they said.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep' }));
    expect(await screen.findByText(CLAIM)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete company evidence' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm delete' })).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Nothing saved for this company yet.')).toBeInTheDocument();
  });

  it('renders nothing on a build without the bridge, and a plain note when it cannot load', async () => {
    delete (window as unknown as { companyEvidence?: unknown }).companyEvidence;
    const { container } = render(<CompanyEvidencePanel target={{ attemptId: 'a' }} />);
    expect(container).toBeEmptyDOMElement();

    (window as unknown as { companyEvidence: Partial<CompanyEvidenceBridge> }).companyEvidence = {
      get: vi.fn().mockRejectedValue(new Error('boom')),
    };
    render(<CompanyEvidencePanel target={{ attemptId: 'b' }} />);
    expect(await screen.findByText('We could not load the company evidence. Your drafts are not affected.')).toBeInTheDocument();
  });
});

describe('Prepare interview with company evidence', () => {
  it('sends the model only current supported facts, shows leads to the person, and keeps both apart from the CV', async () => {
    const app = workspace.createApplication(db, { role: 'Platform Engineer', company: 'Northwind Freight', location: '', status: 'interview', notes: 'NOTE-SENTINEL' });
    const platform = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND, app.id);
    const api = bridge();
    await api.addFact({ attemptId: platform.id }, { claim: CLAIM, sourceUrl: ABOUT, quote: QUOTE, scope: 'company', topic: 'general' });
    await api.addFact({ attemptId: platform.id }, { claim: 'LEAD-RUMOUR Northwind Freight will be sold.', sourceUrl: 'https://rumours.example/x', quote: '', scope: 'company', topic: 'other' });

    const bridges = installBridges();
    installWorkspaceBridge({
      listApplicationAttempts: vi.fn().mockResolvedValue([
        {
          ...platform,
          applicationId: app.id,
        },
      ]),
    });
    render(
      <InterviewPrepDrawer
        application={{
          id: app.id,
          savedJobId: null,
          role: 'Platform Engineer',
          company: 'Northwind Freight',
          location: '',
          verification: null,
          status: 'interview',
          appliedAt: null,
          nextStep: '',
          contact: '',
          cvId: null,
          letterId: null,
          notes: 'NOTE-SENTINEL',
          archived: false,
        }}
        savedJobs={[]}
        cvDocuments={[]}
        letters={[]}
        onClose={vi.fn()}
      />,
    );

    // The person sees the lead and why it is not used; the panel is part of the drawer.
    expect(await screen.findByText('LEAD-RUMOUR Northwind Freight will be sold.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /generate prep pack/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /generate prep pack/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    const prompt = vi.mocked(bridges.agentDock.createSession).mock.calls[0]![0]!.prompt;
    expect(prompt).toContain('=== SOURCED COMPANY EVIDENCE');
    expect(prompt).toContain(`[E1] (the company) ${CLAIM}`);
    expect(prompt).toContain(`source: ${ABOUT}`);
    expect(prompt).not.toContain('LEAD-RUMOUR');
    expect(prompt).not.toContain('Valid until');
  });
});
