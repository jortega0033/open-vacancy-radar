import { describe, expect, it } from 'vitest';
import { startLiveSmokeDaemon } from '../../src/live-smoke/daemon-instance.js';

/**
 * Not part of upstream's own live-smoke test suite (it has no dedicated `daemon-instance.test.ts`
 * either -- this file, like `cli.ts`, is only ever really exercised end-to-end by a live opt-in
 * run). Added anyway: this is the one place a wiring mistake (a wrong `SessionManager` constructor
 * argument, a missing v1 route registration) would otherwise go completely uncaught by any test in
 * this repo, since nothing else builds a real daemon instance this way. No real provider CLI is
 * needed for this -- `/health` and `POST /sessions/:id/cancel` on an unknown id both work without
 * one.
 */
describe('startLiveSmokeDaemon', () => {
  it('builds and starts a real, working v1-only daemon on an ephemeral port, then shuts down cleanly', async () => {
    const daemon = await startLiveSmokeDaemon();
    try {
      expect(daemon.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(daemon.token.length).toBeGreaterThan(0);

      const health = await fetch(`${daemon.baseUrl}/health`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as { status: string };
      expect(body.status).toBe('ok');

      // Authenticated v1 route reachable, and no /v2 route was ever registered (this instance is
      // deliberately v1-only -- see the class doc comment).
      const unauthorized = await fetch(`${daemon.baseUrl}/sessions/00000000-0000-4000-8000-000000000000`);
      expect(unauthorized.status).toBe(401);
      const v2 = await fetch(`${daemon.baseUrl}/v2/providers`, { headers: { authorization: `Bearer ${daemon.token}` } });
      expect(v2.status).toBe(404);
    } finally {
      await daemon.close();
    }

    // Closed for real: a fresh request against the same base URL now fails to connect.
    await expect(fetch(`${daemon.baseUrl}/health`)).rejects.toThrow();
  });
});
