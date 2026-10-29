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
import * as evidenceStore from '../../../electron/workspace/company-evidence-store.js';
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
    correctFact: (t, factId, claim, quote) => call('company-evidence:correct-fact', { ...t, factId, claim, ...(quote ? { quote } : {}) }),
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
    expect(await screen.findByRole('alert')).toHaveTextContent("a job board, recruiting system or shared publishing/hosting platform used by many organisations, not the employer's own website");

    fireEvent.change(screen.getByLabelText('Company website'), { target: { value: 'harbor-systems.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm website' }));
    expect(await screen.findByTestId('company-identity')).toHaveTextContent('a website you confirmed for this vacancy (harbor-systems.example)');
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
    // "Usable" = eligible; "Used" is reserved for what a prepared letter actually carried.
    expect(within(card).getByText('Usable')).toBeInTheDocument();
    expect(within(card).queryByText('Used')).toBeNull();
    expect(within(card).getByText('Company')).toBeInTheDocument();
    expect(within(card).getByText('Quoted passage found')).toBeInTheDocument();
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
    expect(screen.getByTestId('company-identity')).toHaveTextContent('0 usable, 0 leads');
  });

  it('lets the person decide a disagreement and a similar-name suggestion, in plain words', async () => {
    const platform = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const group = attempt('Northwind Freight Group', 'Dispatcher', 'https://careers.northwind-freight-group.example/jobs/9');
    pages.set(ABOUT, 'Northwind Freight has 200 employees');
    pages.set('https://news.example/n', 'Northwind Freight employs about 450 people');
    pages.set('https://northwind-freight-group.example/about', 'Northwind Freight Group runs a dispatch centre in Rotterdam for its own fleet');
    const api = bridge();
    await api.addFact({ attemptId: platform.id }, { claim: 'Northwind Freight has 200 employees.', sourceUrl: ABOUT, quote: 'Northwind Freight has 200 employees', scope: 'company', topic: 'size' });
    await api.addFact({ attemptId: platform.id }, { claim: 'Northwind Freight employs about 450 people.', sourceUrl: 'https://news.example/n', quote: 'Northwind Freight employs about 450 people', scope: 'company', topic: 'size' });
    await api.addFact({ attemptId: group.id }, { claim: 'Northwind Freight Group runs a dispatch centre in Rotterdam.', sourceUrl: 'https://northwind-freight-group.example/about', quote: 'Northwind Freight Group runs a dispatch centre in Rotterdam for its own fleet', scope: 'company', topic: 'general' });

    const onChanged = vi.fn();
    render(<CompanyEvidencePanel target={{ attemptId: platform.id }} onChanged={onChanged} />);
    const dispute = await screen.findByTestId('company-contradiction');
    expect(dispute).toHaveTextContent('Two sources disagree about size. Neither is used until you choose.');
    expect(screen.queryByText('Usable in the prepared letter and interview prep')).toBeNull();
    fireEvent.click(within(dispute).getAllByRole('button', { name: 'Keep this one' })[0]!);
    await waitFor(() => expect(screen.queryByTestId('company-contradiction')).toBeNull());
    expect(await screen.findByText('Usable in the prepared letter and interview prep')).toBeInTheDocument();
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

  it('says which consumers use evidence and what "usable" proves, without repeating the company name beside the heading', async () => {
    const platform = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    render(<CompanyEvidencePanel target={{ attemptId: platform.id }} />);
    const panel = await screen.findByTestId('company-evidence');
    expect(panel).toHaveTextContent('the cover letter this app prepares for an application, and the “Prepare interview” prompt');
    expect(panel).toHaveTextContent('The Letters page and the CV assistant do not.');
    expect(panel).toHaveTextContent('That checks the wording only; it does not prove the page or the claim is right.');
    expect(panel).toHaveTextContent('greenhouse board "northwind"; the employer\'s own website is not known');
    expect(panel).toHaveTextContent('takes up to about 90 seconds');
    expect(panel).not.toHaveTextContent('Northwind Freight');
  });

  it('a correction can carry a new passage, and a correction without one stays a lead that needs a passage', async () => {
    const platform = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    await bridge().addFact({ attemptId: platform.id }, { claim: CLAIM, sourceUrl: ABOUT, quote: QUOTE, scope: 'company', topic: 'general' });
    render(<CompanyEvidencePanel target={{ attemptId: platform.id }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Correct' }));
    fireEvent.change(screen.getByLabelText('Corrected claim'), { target: { value: 'Northwind Freight operates 140 depots.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    const card = (await screen.findByText('Northwind Freight operates 140 depots.')).closest('[data-testid="company-fact"]') as HTMLElement;
    await waitFor(() => expect(card).toHaveAttribute('data-support', 'lead'));
    expect(card).toHaveTextContent('No passage copied from the page is saved for this wording');
    expect(card).toHaveTextContent('no longer supports it');

    pages.set(ABOUT, 'Northwind Freight now operates 15 depots in the Benelux');
    fireEvent.click(within(card).getByRole('button', { name: 'Correct' }));
    fireEvent.change(screen.getByLabelText('Corrected claim'), { target: { value: 'Northwind Freight now operates 15 depots in the Benelux.' } });
    fireEvent.change(screen.getByLabelText(/Passage from the page that says the corrected wording/), {
      target: { value: 'Northwind Freight now operates 15 depots in the Benelux' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    const fixed = (await screen.findByText('Northwind Freight now operates 15 depots in the Benelux.')).closest('[data-testid="company-fact"]') as HTMLElement;
    await waitFor(() => expect(fixed).toHaveAttribute('data-support', 'supported'));
    expect(within(fixed).getByText('Quoted passage found')).toBeInTheDocument();
  });

  it('confirms a website with an optional entity reference, and offers same-name domains only as suggestions', async () => {
    const first = attempt('Apex', 'Engineer', 'https://www.jobgether.com/offer/1');
    await bridge().confirmDomain({ attemptId: first.id }, { domain: 'apex-logistics.example' });
    const second = attempt('Apex', 'Designer', 'https://www.linkedin.com/jobs/view/2');
    render(<CompanyEvidencePanel target={{ attemptId: second.id }} />);
    const suggestions = await screen.findByTestId('company-domain-suggestions');
    expect(suggestions).toHaveTextContent('apex-logistics.example (you confirmed it for another vacancy with this name)');
    expect(screen.getByTestId('company-identity-missing')).toHaveTextContent('Another vacancy with the same name is not affected.');
    fireEvent.click(within(suggestions).getByRole('button', { name: 'Use this address' }));
    expect(screen.getByLabelText('Company website')).toHaveValue('apex-logistics.example');
    fireEvent.change(screen.getByLabelText('Registration number or legal name (optional)'), { target: { value: 'KvK 87654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm website' }));
    expect(await screen.findByTestId('company-identity')).toHaveTextContent('entity reference kvk 87654321');
  });

  it('closing the panel while research runs cancels the work it started', async () => {
    const platform = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    let aborted = false;
    research.mockImplementation(
      (_input: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve({ status: 'cancelled', reason: 'cancelled_by_user', candidates: [], queries: [], searches: 0, fetches: 0 });
            },
            { once: true },
          );
        }),
    );
    const view = render(<CompanyEvidencePanel target={{ attemptId: platform.id }} />);
    await screen.findByTestId('company-identity');
    fireEvent.click(screen.getByRole('button', { name: 'Research this company' }));
    await screen.findByRole('button', { name: 'Stop' });
    await waitFor(() => expect(runs.active).toBe(1));
    view.unmount();
    await waitFor(() => expect(aborted).toBe(true));
    await waitFor(() => expect(runs.active).toBe(0));
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

/* Fix round 2 (review 2, P3): an attestation names the claim and the source, and says why the app refused it;
 * a self-attested use is marked as such; a posting-domain suggestion warns that it may be a job or hosting site. */
describe('CompanyEvidencePanel: informed attestation and domain suggestions (fix 2)', () => {
  const BORROWED = 'Northwind Freight employs 12,000 people.';
  const COMPETITOR = 'Northwind Freight is a logistics firm. Our competitor Acme Haulage employs 12,000 people worldwide.';

  it('asks for a one-step confirmation that names the source and the exact claim, with the reason the app refused it', async () => {
    const platform = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    pages.set(ABOUT, COMPETITOR);
    const api = bridge();
    await api.addFact({ attemptId: platform.id }, { claim: BORROWED, sourceUrl: ABOUT, quote: COMPETITOR, scope: 'company', topic: 'size' });
    render(<CompanyEvidencePanel target={{ attemptId: platform.id }} />);
    const card = (await screen.findByText(BORROWED)).closest('[data-testid="company-fact"]') as HTMLElement;
    expect(card).toHaveAttribute('data-support', 'lead');
    // No single click turns a refused lead into a confirmed one.
    expect(within(card).queryByRole('button', { name: /I read the source/ })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'The source says this…' }));
    const step = within(card).getByTestId('company-fact-attest');
    expect(step).toHaveTextContent(`Only confirm this if you opened northwind.example yourself and it says exactly: “${BORROWED}”`);
    expect(step).toHaveTextContent('The app did not use it automatically:');
    expect(step).toHaveTextContent('the sentence is not about this employer as its subject');
    expect(step).toHaveTextContent('your statement, not a check by the app');
    fireEvent.click(within(step).getByRole('button', { name: 'Cancel' }));
    expect(within(card).queryByTestId('company-fact-attest')).toBeNull();
    expect(card).toHaveAttribute('data-support', 'lead');

    fireEvent.click(within(card).getByRole('button', { name: 'The source says this…' }));
    fireEvent.click(within(card).getByRole('button', { name: 'I read northwind.example and it says this' }));
    // Confirmed, the claim moves to the usable list (a new list item), labelled as the person's own confirmation.
    await waitFor(() => expect(screen.getByText(BORROWED).closest('[data-testid="company-fact"]')).toHaveAttribute('data-support', 'supported'));
    const confirmed = screen.getByText(BORROWED).closest('[data-testid="company-fact"]') as HTMLElement;
    expect(within(confirmed).getByText('You confirmed')).toBeInTheDocument();
    expect(within(confirmed).queryByTestId('company-fact-attest')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Recorded your confirmation that northwind.example says this claim.');
  });

  it('marks each claim the prepared letter used that only the person confirmed', async () => {
    const platform = attempt('Northwind Freight', 'Platform Engineer', NORTHWIND);
    const api = bridge();
    await api.addFact({ attemptId: platform.id }, { claim: CLAIM, sourceUrl: ABOUT, quote: QUOTE, scope: 'company', topic: 'general' });
    pages.set('https://northwind.example/rail', COMPETITOR);
    await api.addFact({ attemptId: platform.id }, { claim: BORROWED, sourceUrl: 'https://northwind.example/rail', quote: COMPETITOR, scope: 'company', topic: 'size' });
    const lead = (await api.get({ attemptId: platform.id })) as Extract<Awaited<ReturnType<CompanyEvidenceBridge['get']>>, { ok: true }>;
    await api.confirmFact({ attemptId: platform.id }, lead.view.facts.find((fact) => fact.claim === BORROWED)!.id);
    const prose = await api.prose({ attemptId: platform.id });
    if (!prose.ok) throw new Error('prose refused');
    evidenceStore.recordEvidenceUses(db, platform.id, prose.facts, new Date('2026-10-05T10:00:00.000Z'));

    render(<CompanyEvidencePanel target={{ attemptId: platform.id }} />);
    const uses = await screen.findByTestId('company-letter-uses');
    expect(uses).toHaveTextContent(`"${BORROWED}" (northwind.example, observed`);
    expect(uses).toHaveTextContent('you confirmed it; the app did not check its wording');
    expect(uses.textContent!.match(/you confirmed it/g)).toHaveLength(1);
    expect(uses).toHaveTextContent(`"${CLAIM}" (northwind.example, observed`);
  });

  it('says a posting-domain suggestion may be a job or hosting site, and never suggests or accepts a shared platform', async () => {
    const apex = attempt('Apex', 'Engineer', 'https://careers.apex-jobs-network.example/jobs/1');
    render(<CompanyEvidencePanel target={{ attemptId: apex.id }} />);
    const suggestions = await screen.findByTestId('company-domain-suggestions');
    expect(suggestions).toHaveTextContent(
      "apex-jobs-network.example (the domain of this posting. It may be a job site or a hosting service: use it only if it is the employer's own website)",
    );
    expect(screen.getByTestId('company-identity-missing')).toHaveTextContent('not a job board, recruiting system or hosting site');

    for (const domain of ['bamboohr.com', 'apex.jobvite.com', 'icims.com', 'medium.com', 'apex.substack.com', 'wordpress.com', 'ghost.io', 'sslip.io']) {
      fireEvent.change(screen.getByLabelText('Company website'), { target: { value: domain } });
      fireEvent.click(screen.getByRole('button', { name: 'Confirm website' }));
      expect(await screen.findByRole('alert'), domain).toHaveTextContent(/job board, recruiting system or shared publishing\/hosting platform|shared hosting service or a public suffix/);
    }
    expect(screen.getByTestId('company-identity-missing')).toBeInTheDocument();
  });

  it('offers no posting-domain suggestion at all for a shared ATS or hosting platform', async () => {
    const onBamboo = attempt('Apex', 'Engineer', 'https://apex.bamboohr.com/careers/1');
    render(<CompanyEvidencePanel target={{ attemptId: onBamboo.id }} />);
    await screen.findByTestId('company-identity-missing');
    expect(screen.queryByTestId('company-domain-suggestions')).toBeNull();
  });
});
