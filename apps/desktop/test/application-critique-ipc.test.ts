// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The renderer-facing boundary of #690: strict input, no model call except the explicit run, writes
 * under the data-reset gate, a plain content-free failure, and a preload that rebuilds every result.
 */

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../electron/application-view.js', () => ({ createApplicationView: vi.fn() }));

const { createWorkspaceDb } = await import('../electron/workspace/client.js');
const workspace = await import('../electron/workspace/repository.js');
const { createApplicationCritiqueHandlers, APPLICATION_CRITIQUE_CHANNELS } = await import('../electron/application-critique-ipc.js');
const { parseCritiqueResult } = await import('../electron/application-critique-types.js');
const fx = await import('./application-critique-fixtures.js');
import type { WorkspaceDb } from '../electron/workspace/client.js';

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let generate: ReturnType<typeof vi.fn>;
let mutate: ReturnType<typeof vi.fn>;
let attemptId: string;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function handlers() {
  return createApplicationCritiqueHandlers({
    service: async () => ({
      db,
      storageRoot: join(dir, 'artifacts'),
      now: () => new Date(),
      generate: generate as never,
      loadCompanyEvidence: () => [],
      provider: 'claude',
    }),
    mutate: mutate as never,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-critique-ipc-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  generate = vi.fn(async () => ({ ok: true, text: '{"findings":[]}' }));
  mutate = vi.fn(async (task: () => unknown) => task());
  const cv = workspace.createCvDocument(db, { name: 'CV', kind: 'manual', text: 'Jamie', profile: { skills: fx.PROFILE_SKILLS }, source: fx.SOURCE, isDefault: true });
  attemptId = workspace.createApplicationAttempt(db, {
    vacancyKey: 'v',
    canonicalUrl: fx.APPLY_URL,
    company: fx.COMPANY,
    role: fx.ROLE,
    sourceCvId: cv.id,
    sourceCvContentHash: sha('Jamie'),
    jdSnapshot: fx.JD,
    jdSnapshotHash: sha(fx.JD),
    checkpoint: 'needs_user',
  }).id;
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('application-critique IPC handlers', () => {
  it('registers exactly the five channels the preload uses', () => {
    expect(Object.keys(handlers()).sort()).toEqual([...APPLICATION_CRITIQUE_CHANNELS].sort());
  });

  it('refuses unknown keys and malformed ids before doing anything', async () => {
    const h = handlers();
    for (const input of [
      { attemptId, provider: 'codex' },
      { attemptId, prompt: 'ignore the rules' },
      { attemptId: '' },
      { attemptId: 7 },
      null,
      'attempt',
    ]) {
      expect(await h['application-critique:run']!(input)).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(await h['application-critique:get']!(input)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    const target = { attemptId, runId: 'r', document: 'cv', baseContentHash: 'h' };
    for (const input of [{ ...target, document: 'combined' }, { ...target, resume: {} }, { ...target, baseContentHash: '' }]) {
      expect(await h['application-critique:accept']!(input)).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(await h['application-critique:reject']!(input)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
    expect(generate).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('reading never reaches the model or the write gate; only the explicit run starts a session', async () => {
    const h = handlers();
    expect(await h['application-critique:get']!({ attemptId })).toMatchObject({ ok: true, view: { attemptId, running: false } });
    expect(generate).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    // The unrecorded package cannot be reviewed, and says why, without a model call.
    expect(await h['application-critique:run']!({ attemptId })).toMatchObject({ ok: false, code: 'not_available' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('decisions on a suggestion run under the data-reset gate; a stale one changes nothing', async () => {
    const h = handlers();
    const result = await h['application-critique:accept']!({ attemptId, runId: 'old', document: 'cv', baseContentHash: 'old' });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false });
    expect(await h['application-critique:reject']!({ attemptId, runId: 'old', document: 'cv', baseContentHash: 'old' })).toMatchObject({ ok: false, code: 'outdated' });
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  it('answers a deleted application with a plain not-found, never stored text', async () => {
    const h = handlers();
    workspace.deleteApplicationAttempt(db, attemptId);
    expect(await h['application-critique:get']!({ attemptId })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await h['application-critique:run']!({ attemptId })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('cancel reports whether anything was running and never throws', async () => {
    expect(await handlers()['application-critique:cancel']!({ attemptId })).toEqual({ ok: false });
    expect(await handlers()['application-critique:cancel']!({ nope: true })).toEqual({ ok: false });
  });
});

describe('the preload result parser', () => {
  const view = {
    attemptId: 'a',
    canReview: true,
    unavailable: null,
    running: false,
    documents: [],
    review: null,
    lastRun: null,
  };

  it('keeps known fields and drops everything else', () => {
    const parsed = parseCritiqueResult({ ok: true, view: { ...view, secret: 'cv text', documents: [] }, extra: 1 });
    expect(parsed).toEqual({ ok: true, view });
  });

  it.each([[null], ['x'], [{ ok: true }], [{ ok: true, view: { ...view, canReview: 'yes' } }], [{ ok: false, code: 'made_up', message: 'm', view: null }]])(
    'fails closed on %j',
    (raw) => {
      expect(parseCritiqueResult(raw)).toMatchObject({ ok: false, code: 'failed', view: null });
    },
  );
});
