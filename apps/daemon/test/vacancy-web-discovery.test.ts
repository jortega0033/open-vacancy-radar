import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_PROVIDER_CAPABILITIES, FakeProvider, ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type { StartSessionOptions } from '@agent-dock/agent-runtime';
import { buildServer } from '../src/server.js';
import { SessionManager } from '../src/session-manager.js';

const TOKEN = 'test-token-123';

/**
 * `POST /sessions/vacancy-web-discovery` (issue #398): the only route that ever asks
 * `SessionManager.create()` for the `'web-only'` tool profile. Mirrors
 * `application-generation.test.ts`'s own suite for `'no-network'` -- these tests assert the route's
 * own request-validation behavior and, crucially, that the session it starts actually carries
 * `hardened: 'web-only'` -- not just `hardened: true` -- since that is the one property that makes
 * this route different from `POST /sessions` at all.
 */
function setup() {
  const provider = new FakeProvider(
    'claude',
    { id: 'claude', name: 'Claude Code', installed: true, authenticated: 'authenticated', capabilities: FAKE_PROVIDER_CAPABILITIES },
    'success',
  );
  const registry = new ProviderRegistry();
  registry.register(provider);
  const sessionManager = new SessionManager(registry, noopLogger);
  const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });
  return { app, provider, registry };
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-dock-daemon-aiwebdiscovery-test-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('POST /sessions/vacancy-web-discovery', () => {
  it('rejects an invalid body the same way POST /sessions does', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/vacancy-web-discovery',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('silently drops a resumeProviderSessionId: this session type has no thread to resume', async () => {
    const { app, provider } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/vacancy-web-discovery',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'search for frontend vacancies', resumeProviderSessionId: 'thread-1' },
    });
    expect(res.statusCode).toBe(201);
    expect(provider.startedOptions[0]!.resumeProviderSessionId).toBeUndefined();
  });

  it('rejects any provider other than claude, before ever consulting the registry', async () => {
    // Issue #398 is explicitly Claude-only in V1 -- Codex's own build-args never reads
    // `opts.hardened` at all. Registering a FakeProvider under 'codex' and confirming it's STILL
    // refused proves this is a real provider-identity gate, not merely "not installed".
    const { app, registry } = setup();
    registry.register(
      new FakeProvider(
        'codex',
        { id: 'codex', name: 'Codex', installed: true, authenticated: 'authenticated', capabilities: FAKE_PROVIDER_CAPABILITIES },
        'success',
      ),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/vacancy-web-discovery',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'codex', cwd, prompt: 'search for frontend vacancies' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not support the vacancy-web-discovery hardening profile/);
  });

  it('rejects an unregistered (but claude-identified) provider the same way POST /sessions does', async () => {
    const registry = new ProviderRegistry(); // no claude registered at all
    const sessionManager = new SessionManager(registry, noopLogger);
    const app = buildServer({ registry, sessionManager, token: TOKEN, logger: noopLogger });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/vacancy-web-discovery',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'search for frontend vacancies' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unsupported provider/);
  });

  it('rejects a cwd that does not exist', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/vacancy-web-discovery',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd: join(cwd, 'nope'), prompt: 'search for frontend vacancies' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a session and requires auth, same as every other privileged route', async () => {
    const { app } = setup();
    const unauth = await app.inject({
      method: 'POST',
      url: '/sessions/vacancy-web-discovery',
      payload: { provider: 'claude', cwd, prompt: 'search for frontend vacancies' },
    });
    expect(unauth.statusCode).toBe(401);

    const res = await app.inject({
      method: 'POST',
      url: '/sessions/vacancy-web-discovery',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'search for frontend vacancies' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBeTruthy();
  });

  it('starts the provider session with the "web-only" hardening profile, not plain "true"', async () => {
    const { app, provider } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/vacancy-web-discovery',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'search for frontend vacancies', model: 'fable' },
    });
    expect(res.statusCode).toBe(201);

    const started: StartSessionOptions[] = provider.startedOptions;
    expect(started).toHaveLength(1);
    expect(started[0]!.hardened).toBe('web-only');
    expect(started[0]!.model).toBe('fable');
  });

  it('is a distinct session from those POST /sessions creates: that route still gets plain hardening', async () => {
    const { app, provider } = setup();
    await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'a normal CV feature session' },
    });
    await app.inject({
      method: 'POST',
      url: '/sessions/vacancy-web-discovery',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'search for frontend vacancies' },
    });

    const started: StartSessionOptions[] = provider.startedOptions;
    expect(started).toHaveLength(2);
    expect(started[0]!.hardened).toBe(true);
    expect(started[1]!.hardened).toBe('web-only');
  });

  it('is also distinct from the "no-network" field-map-generation session', async () => {
    const { app, provider } = setup();
    await app.inject({
      method: 'POST',
      url: '/sessions/application-field-map',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'map these fields' },
    });
    await app.inject({
      method: 'POST',
      url: '/sessions/vacancy-web-discovery',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { provider: 'claude', cwd, prompt: 'search for frontend vacancies' },
    });

    const started: StartSessionOptions[] = provider.startedOptions;
    expect(started).toHaveLength(2);
    expect(started[0]!.hardened).toBe('no-network');
    expect(started[1]!.hardened).toBe('web-only');
  });
});
