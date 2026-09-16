// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createApplicationQueuePort } from '../electron/application-queue-port.js';

/**
 * The daemon-queue port, and in particular the one call in it that used to throw its answer away.
 *
 * `release` hands the daemon's single global lease back. The worker calls it on every path that ends
 * a turn, including the abandonment path whose entire purpose is to stop the queue wedging behind a
 * preparation nobody is waiting for -- so a refusal there is the last condition that can still leave
 * the queue blocked with no run in flight, cleared only by the daemon's startup reconciliation, i.e.
 * by restarting the app. It spent its whole life being ignored: `await daemonFetch(...)` with no
 * `res.ok` check, resolving as a success whatever came back.
 *
 * It could not be tested where it lived, because it lived in `main.ts`, which no test can import
 * (doing so boots Electron, spawns the daemon sidecar and opens two SQLite databases -- the same
 * wall `test/tick.test.ts` and the daemon-respawn work both ran into). Pulling the port out into its
 * own module is what makes the assertions below possible at all; the HTTP transport itself stays in
 * `main.ts` behind the injected `request`/`getJson` callbacks these tests stand in for.
 */

function refusal(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function portWith(request: (path: string, init: { method: string; body?: unknown }) => Promise<Response>) {
  const log = vi.fn();
  const getJson = vi.fn(async () => undefined);
  return { port: createApplicationQueuePort({ request, getJson, log }), log, getJson };
}

describe('createApplicationQueuePort: release', () => {
  it('logs loudly when the daemon refuses to take a lease back, naming the status and the reason', async () => {
    const { port, log } = portWith(async () => refusal(409, { code: 'invalid_transition' }));

    await expect(port.release('lease-7', 'requeue')).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
    const [message, meta] = log.mock.calls[0]!;
    expect(message).toContain('refused to take back an application-queue lease');
    expect(meta).toMatchObject({
      leaseId: 'lease-7',
      outcome: 'requeue',
      status: 409,
      reason: 'that action cannot be applied to this attempt right now',
    });
  });

  it('resolves rather than throwing, so a refusal cannot take the worker tick down with it', async () => {
    // `runNextApplicationAttempt` awaits `release` on its settled path with no catch at all, and on
    // its abandonment path only to log a transport error. Throwing here would turn "the queue may be
    // stuck" into "the tick crashed", and would lose the outcome the run had already decided on.
    const { port } = portWith(async () => refusal(500, {}));

    await expect(port.release('lease-7', 'completed')).resolves.toBeUndefined();
  });

  it('never repeats text the daemon wrote, falling back to a message this process owns', async () => {
    const { port, log } = portWith(async () => refusal(400, { code: 'something_new', error: 'lease 7 is held by pid 4192' }));

    await port.release('lease-7', 'failed');

    const meta = log.mock.calls[0]![1] as Record<string, unknown>;
    expect(meta.reason).toBe('the agent runtime gave no reason it recognises');
    expect(JSON.stringify(meta)).not.toContain('pid 4192');
  });

  it('says nothing at all when the release succeeds, which is the overwhelmingly common case', async () => {
    const { port, log } = portWith(async () => new Response(null, { status: 204 }));

    await port.release('lease-7', 'completed');

    expect(log).not.toHaveBeenCalled();
  });

  it('sends the lease id and outcome the caller gave it, to the route the daemon owns', async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const { port } = portWith(request);

    await port.release('lease-7', 'requeue');

    expect(request).toHaveBeenCalledWith('/v2/applications/lease/release', {
      method: 'POST',
      body: { leaseId: 'lease-7', outcome: 'requeue' },
    });
  });
});

/** The rest of the port, pinned on the way out of `main.ts`: the extraction is only worth doing if
 * it is provably behaviour-preserving, and none of these three had a test before either. */
describe('createApplicationQueuePort: the other three calls', () => {
  it('turns a refused enqueue into a thrown, app-authored message', async () => {
    const { port } = portWith(async () => refusal(404, { code: 'application_not_found' }));

    await expect(port.enqueue('attempt-1')).rejects.toThrow('no such attempt is in the queue');
  });

  it('reports nothing schedulable as null, not as an error: it is a poller\'s ordinary answer', async () => {
    const { port } = portWith(async () => new Response(null, { status: 409 }));

    await expect(port.acquireLease()).resolves.toBeNull();
  });

  it('refuses a lease whose body is missing either half of the handle', async () => {
    const { port } = portWith(async () => new Response(JSON.stringify({ lease: { leaseId: 'lease-7' } }), { status: 200 }));

    await expect(port.acquireLease()).resolves.toBeNull();
  });

  it('returns the lease when the daemon hands back a whole one', async () => {
    const { port } = portWith(async () =>
      new Response(JSON.stringify({ lease: { leaseId: 'lease-7', attemptId: 'attempt-1' } }), { status: 200 }),
    );

    await expect(port.acquireLease()).resolves.toEqual({ leaseId: 'lease-7', attemptId: 'attempt-1' });
  });

  it('accepts only queue states this process already understands', async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const log = vi.fn();
    const state = vi.fn(async () => ({ entry: { state: 'queued' } }) as Record<string, unknown>);
    const port = createApplicationQueuePort({ request, getJson: state, log });

    await expect(port.entryState('attempt-1')).resolves.toBe('queued');

    state.mockResolvedValueOnce({ entry: { state: 'reticulating' } });
    await expect(port.entryState('attempt-1')).resolves.toBeNull();
    expect(state).toHaveBeenLastCalledWith('/v2/applications/attempt-1');
  });
});
