import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSavedJobPatch } from '../../../electron/workspace/validate.js';
import { GapAnalysis } from '../../../src/components/cv/GapAnalysis.js';
import { matchSavedJob } from '../../../src/components/cv/gap-analysis-store.js';
import type { CvDocument, VacancyLead } from '../../../src/components/cv/types.js';
import { SavedJobDrawer } from '../../../src/components/saved/SavedJobDrawer.js';
import { toSavedJobInput } from '../../../src/components/saved/saved-job-input.js';
import type { SavedJobInput, SavedJobPatch, SavedJobRecord } from '../../../src/window.js';
import { installBridges, TEST_VACANCY } from '../../cv-bridges.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';

/**
 * Issue #138: a gap analysis the user chooses to keep survives leaving the screen.
 *
 * The claim is a round trip across three seams, so this file exercises all three rather than
 * asserting that a mock was called: the renderer picks the right saved job for the vacancy on
 * screen, the payload it sends survives `parseSavedJobPatch` (the real trust-boundary allow-list,
 * imported here rather than imitated), and what comes back out is what `SavedJobDrawer` renders
 * when the job is reopened later.
 *
 * "Reopened later" is simulated the only honest way available in a component test: the tree that
 * did the saving is unmounted entirely, and the drawer is then rendered from a record read back
 * out of the store, exactly as `SavedJobsPage` renders it after `listSavedJobs`. Nothing is carried
 * over in React state. The database half of the same claim -- that the row survives a real
 * `workspace.db` close and reopen, migration included -- is `test/workspace-migration-0004.test.ts`.
 */

const CV: CvDocument = { fileName: 'cv.pdf', text: 'Angular architect. 8 years of frontend work.' };

const ANALYSIS = '## Strengths\nEight years of Angular.\n\n## Gaps\nNo Kubernetes exposure.';

const SAVED_JOB: SavedJobRecord = {
  id: 'job-redwood-1',
  vacancyKey: 'nl:redwood-software:senior-frontend-engineer',
  role: 'Senior Frontend Engineer',
  company: 'Redwood Software',
  market: 'netherlands',
  location: 'Amsterdam, Netherlands',
  salary: null,
  arrangement: 'Hybrid',
  verification: 'Recognised sponsor',
  matchPercent: 91,
  // The same URL `TEST_VACANCY` carries: this is how the renderer knows the two are one vacancy.
  sourceUrl: TEST_VACANCY.url,
  notes: 'Recruiter replied within a day.',
  status: 'considering',
  savedAt: '2026-08-20T10:00:00.000Z',
  gapAnalysis: null,
  gapAnalysisAt: null,
};

/**
 * A stand-in for `workspace.db` that keeps saved jobs in a Map and applies writes the way the main
 * process does: the incoming patch goes through the real `parseSavedJobPatch` first, and
 * `gapAnalysisAt` is derived here rather than accepted from the caller (see `repository.ts`).
 */
function installStore(rows: SavedJobRecord[]) {
  const store = new Map(rows.map((row) => [row.id, row]));
  const updateSavedJob = vi.fn(async (id: string, patch: SavedJobPatch | SavedJobInput) => {
    const existing = store.get(id);
    if (!existing) throw new Error(`no saved job ${id}`);
    const allowed = parseSavedJobPatch(patch);
    const next: SavedJobRecord = {
      ...existing,
      ...allowed,
      ...('gapAnalysis' in allowed
        ? allowed.gapAnalysis == null
          ? { gapAnalysis: null, gapAnalysisAt: null }
          : { gapAnalysis: allowed.gapAnalysis, gapAnalysisAt: new Date().toISOString() }
        : {}),
    };
    store.set(id, next);
    return next;
  });

  const bridge = installWorkspaceBridge({
    listSavedJobs: vi.fn(async () => [...store.values()]),
    updateSavedJob: updateSavedJob as never,
  });
  return { bridge, updateSavedJob, read: (id: string) => store.get(id) };
}

/** Runs an analysis to completion in a freshly rendered `GapAnalysis`. */
async function runAnalysis(bridges: ReturnType<typeof installBridges>) {
  fireEvent.click(screen.getByRole('button', { name: /analyse gaps/i }));
  await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());
  bridges.emit('sess-cv-1', { type: 'assistant.message', text: ANALYSIS });
  bridges.emit('sess-cv-1', { type: 'session.completed' });
  await waitFor(() => expect(screen.getByRole('button', { name: /re-run analysis/i })).toBeEnabled());
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('saving a gap analysis onto its saved job', () => {
  it('persists the result, and it is still there when the job is reopened from scratch', async () => {
    const bridges = installBridges();
    const store = installStore([SAVED_JOB]);

    const first = render(<GapAnalysis cv={CV} vacancy={TEST_VACANCY} />);

    // Nothing to save before a run has produced anything.
    expect(screen.getByRole('button', { name: /save analysis/i })).toBeDisabled();

    await runAnalysis(bridges);

    const save = await screen.findByRole('button', { name: /save analysis/i });
    await waitFor(() => expect(save).toBeEnabled());
    // The panel names the row it would write to before the user commits to it.
    expect(screen.getByText(/Redwood Software/)).toBeInTheDocument();

    fireEvent.click(save);

    await waitFor(() => expect(store.updateSavedJob).toHaveBeenCalledTimes(1));
    const [id, patch] = store.updateSavedJob.mock.calls[0] ?? [];
    expect(id).toBe(SAVED_JOB.id);
    expect(patch).toEqual({ gapAnalysis: ANALYSIS });
    // The renderer never dates the analysis; the main process does. See `SavedJobInput`.
    expect(patch).not.toHaveProperty('gapAnalysisAt');

    expect(await screen.findByText(/saved to this job/i)).toBeInTheDocument();

    // ---- the reload. Everything that did the saving is torn down. ----
    first.unmount();

    const reopened = store.read(SAVED_JOB.id);
    expect(reopened?.gapAnalysis).toBe(ANALYSIS);
    expect(reopened?.gapAnalysisAt).not.toBeNull();

    render(<SavedJobDrawer job={reopened} onSave={vi.fn()} onClose={vi.fn()} />);

    const panel = screen.getByRole('region', { name: /saved gap analysis/i });
    expect(panel).toHaveTextContent('Eight years of Angular.');
    expect(panel).toHaveTextContent('No Kubernetes exposure.');
    // The rest of the job came back untouched by the write.
    expect(screen.getByDisplayValue('Recruiter replied within a day.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Senior Frontend Engineer')).toBeInTheDocument();
  });

  it('shows nothing in the drawer for a job that has no saved analysis', () => {
    installWorkspaceBridge();
    render(<SavedJobDrawer job={SAVED_JOB} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('region', { name: /saved gap analysis/i })).not.toBeInTheDocument();
  });

  it('does not resend the analysis when the drawer itself is saved, so an edit cannot rewrite it', () => {
    installWorkspaceBridge();
    const onSave = vi.fn();
    const kept: SavedJobRecord = { ...SAVED_JOB, gapAnalysis: ANALYSIS, gapAnalysisAt: '2026-09-01T09:00:00.000Z' };

    render(<SavedJobDrawer job={kept} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByDisplayValue('Recruiter replied within a day.'), {
      target: { value: 'Second interview booked.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const input = onSave.mock.calls[0]?.[0] as SavedJobInput;
    expect(input.notes).toBe('Second interview booked.');
    // Absent, not null: `parseSavedJobPatch` leaves a column alone only when the key is missing.
    expect('gapAnalysis' in input).toBe(false);
    expect(parseSavedJobPatch(input)).not.toHaveProperty('gapAnalysis');
  });

  it('keeps a stored analysis through the delete-undo recreate', () => {
    const kept: SavedJobRecord = { ...SAVED_JOB, gapAnalysis: ANALYSIS, gapAnalysisAt: '2026-09-01T09:00:00.000Z' };
    expect(toSavedJobInput(kept).gapAnalysis).toBe(ANALYSIS);
  });

  it('leaves the action disabled, and says why, when the vacancy is not a saved job', async () => {
    const bridges = installBridges();
    installStore([]); // nothing saved

    render(<GapAnalysis cv={CV} vacancy={TEST_VACANCY} />);
    await runAnalysis(bridges);

    expect(screen.getByRole('button', { name: /save analysis/i })).toBeDisabled();
    expect(screen.getByText(/save this vacancy to your saved jobs first/i)).toBeInTheDocument();
  });

  it('surfaces a rejected write instead of claiming the analysis was kept', async () => {
    const bridges = installBridges();
    installWorkspaceBridge({
      listSavedJobs: vi.fn().mockResolvedValue([SAVED_JOB]),
      updateSavedJob: vi.fn().mockRejectedValue(new Error('workspace database is locked')),
    });

    render(<GapAnalysis cv={CV} vacancy={TEST_VACANCY} />);
    await runAnalysis(bridges);

    const save = screen.getByRole('button', { name: /save analysis/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    expect(await screen.findByRole('alert')).toHaveTextContent('workspace database is locked');
    expect(screen.queryByText(/saved to this job/i)).not.toBeInTheDocument();
  });
});

describe('matching a vacancy to the saved job it is about', () => {
  const lead: VacancyLead = TEST_VACANCY;

  it('matches on the source URL the search page persisted', () => {
    expect(matchSavedJob([SAVED_JOB], lead)?.id).toBe(SAVED_JOB.id);
  });

  it('falls back to role, company and location for a hand-typed job with no URL', () => {
    const manual: SavedJobRecord = { ...SAVED_JOB, id: 'manual-1', sourceUrl: null };
    expect(matchSavedJob([manual], lead)?.id).toBe('manual-1');
  });

  it('refuses to guess when two saved jobs are indistinguishable from the lead', () => {
    const a: SavedJobRecord = { ...SAVED_JOB, id: 'a', sourceUrl: null };
    const b: SavedJobRecord = { ...SAVED_JOB, id: 'b', sourceUrl: null };
    expect(matchSavedJob([a, b], lead)).toBeNull();
  });

  it('does not match a different vacancy at the same company', () => {
    const other: SavedJobRecord = { ...SAVED_JOB, sourceUrl: 'https://example.invalid/jobs/other', role: 'Designer' };
    expect(matchSavedJob([other], lead)).toBeNull();
  });
});

describe('docs/privacy.md discloses the new stored field', () => {
  const privacy = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'docs', 'privacy.md'),
    'utf8',
  );

  /**
   * privacy.md's own opening promise is that it "describes the current, shipped behavior of this
   * codebase, not aspirations". This ticket adds a new place personal data comes to rest, so the
   * doc going stale is a compliance regression, not a paperwork one. Asserted against the retention
   * section specifically, because that is the section a reader consults to answer "what is kept,
   * and until when".
   */
  it('names the saved analysis, workspace.db, and when it goes away, in the retention section', () => {
    const retention = privacy.split('## Retention and deletion')[1]?.split('\n## ')[0] ?? '';
    expect(retention).not.toBe('');
    expect(retention).toMatch(/gap analys/i);
    expect(retention).toMatch(/workspace\.db/);
    expect(retention).toMatch(/Save analysis/);
    // It must say the retention period, which is the life of the saved job.
    expect(retention).toMatch(/until you delete that saved job/i);
  });

  it('still lists what workspace.db holds, including the kept analysis', () => {
    const stored = privacy.split('## What is stored, and where')[1]?.split('\n## ')[0] ?? '';
    expect(stored).toMatch(/gap analysis/i);
  });
});
