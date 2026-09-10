import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { CREDENTIAL_SHAPED_ENV_DENY_PATTERNS } from '@agent-dock/shared';
import {
  buildDaemonEnvironment,
  DAEMON_ENVIRONMENT_DENY_PATTERNS,
  isDeniedDaemonEnvironmentName,
} from '../electron/daemon-environment.js';
import { loadConfig } from '@open-vacancy-radar/vacancy-engine';

// Construct fixture path relative to this test file's directory
const ENV_DUMP_FIXTURE = join(dirname(import.meta.filename), 'fixtures', 'fake-env-dump.mjs');

describe('DAEMON_ENVIRONMENT_DENY_PATTERNS (issue #176)', () => {
  it('carries every pattern in the shared credential-shaped list, by construction not duplication', () => {
    // Regexes are objects, so this asserts on source/flags rather than reference identity -- the
    // real property under test is that DAEMON_ENVIRONMENT_DENY_PATTERNS was built by spreading
    // CREDENTIAL_SHAPED_ENV_DENY_PATTERNS in (see daemon-environment.ts), not by hand-copying it, so
    // a future edit to the shared list is inherited here automatically instead of silently drifting.
    const daemonSources = DAEMON_ENVIRONMENT_DENY_PATTERNS.map((p) => `${p.source}/${p.flags}`);
    for (const shared of CREDENTIAL_SHAPED_ENV_DENY_PATTERNS) {
      expect(daemonSources).toContain(`${shared.source}/${shared.flags}`);
    }
  });
});

describe('buildDaemonEnvironment', () => {
  it('drops the vacancy-source credential names read by packages/vacancy-engine/src/config.ts', () => {
    const parentEnv = {
      AI_API_KEY: 'sk-fake',
      BRAVE_SEARCH_API_KEY: 'brave-fake',
      ADZUNA_APP_ID: 'adzuna-id-fake',
      ADZUNA_APP_KEY: 'adzuna-key-fake',
      JOOBLE_API_KEY: 'jooble-fake',
      REED_API_KEY: 'reed-fake',
      JOBSPIPE_API_KEY: 'jobspipe-fake',
    };

    const env = buildDaemonEnvironment(parentEnv);

    expect(Object.keys(env)).toEqual([]);
  });

  it('drops generic secret-shaped and cloud-credential names', () => {
    const parentEnv = {
      SOME_SECRET: 'x',
      GITHUB_TOKEN: 'x',
      DB_PASSWORD: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      OPENAI_API_KEY: 'x',
      ANTHROPIC_API_KEY: 'x',
      NPM_TOKEN: 'x',
      SSH_AUTH_SOCK: 'x',
    };

    const env = buildDaemonEnvironment(parentEnv);

    expect(Object.keys(env)).toEqual([]);
  });

  it('keeps ordinary platform and this repo own operational variables', () => {
    const parentEnv = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      AGENT_DOCK_APP_ID: 'open-vacancy-radar',
      AGENT_DOCK_STATE_DIR: '/state',
      ELECTRON_RUN_AS_NODE: '1',
      VITE_DEV_SERVER_URL: 'http://localhost:5173',
      HTTP_PROXY: 'http://proxy.example:8080',
    };

    const env = buildDaemonEnvironment(parentEnv);

    expect(env).toEqual(parentEnv);
  });

  it('drops undefined-valued entries rather than forwarding the literal string "undefined"', () => {
    const parentEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin', UNSET_VAR: undefined };

    const env = buildDaemonEnvironment(parentEnv);

    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('is case-insensitive, matching a lowercase secret-shaped name too', () => {
    expect(isDeniedDaemonEnvironmentName('adzuna_app_key')).toBe(true);
    expect(isDeniedDaemonEnvironmentName('aws_secret_access_key')).toBe(true);
    expect(isDeniedDaemonEnvironmentName('PATH')).toBe(false);
  });
});

/**
 * A value no real environment variable could plausibly hold, planted in every poisoned variable so
 * a leak can be detected by *value* as well as by name. Name-only assertions would miss a child
 * that received a secret under a different key (a wrapper re-exporting it, say).
 */
const SENTINEL = 'ADI21-SENTINEL-8b3a7d52-do-not-leak';

/**
 * The parent-process poison. Three deliberate groups:
 *
 * 1. Credential-shaped names from common ecosystems -- what the deny list exists for.
 * 2. This product's own env-backed vacancy-source credentials -- the real, currently-shipping
 *    exposure ADI-21 closes (`packages/vacancy-engine/src/config.ts`,
 *    `apps/desktop/electron/main.ts`).
 * 3. `FOO_BAR_BAZ` and `HARMLESS_LOOKING_VAR`, which match **no** deny pattern at all. These are the
 *    load-bearing ones: they are excluded only because the allowlist never granted them. A denylist
 *    that happened to cover this test's secret-shaped names would still let these two through.
 */
const POISON: Record<string, string> = Object.fromEntries(
  [
    'AWS_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY_ID',
    'AZURE_CLIENT_SECRET',
    'GCP_SERVICE_ACCOUNT_KEY',
    'GITHUB_TOKEN',
    'NPM_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'AI_API_KEY',
    'BRAVE_SEARCH_API_KEY',
    'ADZUNA_APP_ID',
    'ADZUNA_APP_KEY',
    'JOOBLE_API_KEY',
    'REED_API_KEY',
    'JOBSPIPE_API_KEY',
    'FOO_BAR_BAZ',
    'HARMLESS_LOOKING_VAR',
  ].map((name) => [name, `${SENTINEL}:${name}`]),
);

describe('spawned child environment (sentinel sweep for issue #250)', () => {
  const saved = new Map<string, string | undefined>();
  let workdir: string;

  beforeAll(async () => {
    for (const [name, value] of Object.entries(POISON)) {
      saved.set(name, process.env[name]);
      process.env[name] = value;
    }
    workdir = await mkdtemp(join(tmpdir(), 'ovr daemon env sweep '));
  });

  afterAll(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /**
   * Spawns the env-dump fixture with buildDaemonEnvironment's filtering and returns what it
   * actually saw. This directly mirrors ADI-15's sentinel-sweep test, but for the daemon spawn
   * boundary rather than the provider-child boundary.
   */
  async function childEnvironment(): Promise<Record<string, string>> {
    const filtered = buildDaemonEnvironment(process.env);
    const child = spawn(process.execPath, [ENV_DUMP_FIXTURE], {
      cwd: workdir,
      env: filtered,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stdin?.end();
    const { code } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    expect(code).toBe(0);
    try {
      return JSON.parse(stdout) as Record<string, string>;
    } catch {
      throw new Error(
        `env-dump fixture produced unparseable output (${stdout.length} bytes, code ${code})`,
      );
    }
  }

  it(
    'hands the daemon child none of the credential-shaped poisoned variables, by name or by value',
    async () => {
      const childEnv = await childEnvironment();

      // Sanity check that the poison was actually planted.
      expect(process.env.AWS_SECRET_ACCESS_KEY).toBe(`${SENTINEL}:AWS_SECRET_ACCESS_KEY`);

      // The deny-list approach drops only credential-shaped names. Verify all the poisoned
      // credential names are filtered.
      const credentialPoisonNames = [
        'AWS_SECRET_ACCESS_KEY',
        'AWS_ACCESS_KEY_ID',
        'AZURE_CLIENT_SECRET',
        'GCP_SERVICE_ACCOUNT_KEY',
        'GITHUB_TOKEN',
        'NPM_TOKEN',
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'AI_API_KEY',
        'BRAVE_SEARCH_API_KEY',
        'ADZUNA_APP_ID',
        'ADZUNA_APP_KEY',
        'JOOBLE_API_KEY',
        'REED_API_KEY',
        'JOBSPIPE_API_KEY',
      ];

      for (const name of credentialPoisonNames) {
        expect([name, name in childEnv]).toEqual([name, false]);
      }
      // Value-level sweep: none of the credential-shaped poisoned values leaked under any key.
      // (We don't check all keys since some non-credential vars like FOO_BAR_BAZ are intentionally
      // preserved by the deny-list approach, and those may legitimately contain the sentinel value.)
      for (const credentialName of credentialPoisonNames) {
        const value = childEnv[credentialName];
        if (value !== undefined) {
          expect([credentialName, value.includes(SENTINEL)]).toEqual([credentialName, false]);
        }
      }
    },
    30_000,
  );

  it(
    'preserves unlisted innocuous variables, proving it is a deny list not an allowlist',
    async () => {
      const childEnv = await childEnvironment();
      // These do not match any deny pattern, so they should be passed through by the deny list.
      // If they were filtered, it would mean we switched to an allowlist, which would be a
      // breaking change for the daemon's legitimate platform access.
      expect('FOO_BAR_BAZ' in childEnv).toBe(true);
      expect('HARMLESS_LOOKING_VAR' in childEnv).toBe(true);
      expect(childEnv.FOO_BAR_BAZ).toBe(`${SENTINEL}:FOO_BAR_BAZ`);
      expect(childEnv.HARMLESS_LOOKING_VAR).toBe(`${SENTINEL}:HARMLESS_LOOKING_VAR`);
    },
    30_000,
  );
});

describe('vacancyEngineConfig integration (issue #250)', () => {
  it('still resolves vacancy-source keys from process.env before filtering', () => {
    const testKeys = [
      'AI_API_KEY',
      'BRAVE_SEARCH_API_KEY',
      'ADZUNA_APP_ID',
      'ADZUNA_APP_KEY',
      'JOOBLE_API_KEY',
      'REED_API_KEY',
      'JOBSPIPE_API_KEY',
    ] as const;
    const saved = new Map(testKeys.map((name) => [name, process.env[name]]));
    try {
      process.env.AI_API_KEY = 'test-key';
      process.env.BRAVE_SEARCH_API_KEY = 'test-brave';
      process.env.ADZUNA_APP_ID = 'test-adzuna-id';
      process.env.ADZUNA_APP_KEY = 'test-adzuna-key';
      process.env.JOOBLE_API_KEY = 'test-jooble';
      process.env.REED_API_KEY = 'test-reed';
      process.env.JOBSPIPE_API_KEY = 'test-jobspipe';

      // loadConfig reads from process.env directly, not from the filtered daemon environment,
      // so it should see these values even if they would be filtered later for the daemon child.
      const config = loadConfig(process.env);

      expect(config.ai.apiKey).toBe('test-key');
      expect(config.braveSearch.apiKey).toBe('test-brave');
      expect(config.keyedDiscovery.adzunaAppId).toBe('test-adzuna-id');
      expect(config.keyedDiscovery.adzunaAppKey).toBe('test-adzuna-key');
      expect(config.keyedDiscovery.joobleApiKey).toBe('test-jooble');
      expect(config.keyedDiscovery.reedApiKey).toBe('test-reed');
      expect(config.keyedDiscovery.jobspipeApiKey).toBe('test-jobspipe');
    } finally {
      // Restore rather than Object.assign-merge: this worker's process.env is shared across every
      // test file in the same vitest worker, so a key that didn't exist before this test must be
      // deleted, not left behind with its test value.
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('buildDaemonEnvironment drops the same keys that loadConfig reads', () => {
    const testEnv = {
      PATH: '/usr/bin',
      AI_API_KEY: 'test-key',
      BRAVE_SEARCH_API_KEY: 'test-brave',
      ADZUNA_APP_ID: 'test-adzuna-id',
      ADZUNA_APP_KEY: 'test-adzuna-key',
      JOOBLE_API_KEY: 'test-jooble',
      REED_API_KEY: 'test-reed',
      JOBSPIPE_API_KEY: 'test-jobspipe',
    };

    const filtered = buildDaemonEnvironment(testEnv);

    // These credential keys should be dropped by buildDaemonEnvironment
    expect('AI_API_KEY' in filtered).toBe(false);
    expect('BRAVE_SEARCH_API_KEY' in filtered).toBe(false);
    expect('ADZUNA_APP_ID' in filtered).toBe(false);
    expect('ADZUNA_APP_KEY' in filtered).toBe(false);
    expect('JOOBLE_API_KEY' in filtered).toBe(false);
    expect('REED_API_KEY' in filtered).toBe(false);
    expect('JOBSPIPE_API_KEY' in filtered).toBe(false);

    // But PATH should be preserved
    expect(filtered.PATH).toBe('/usr/bin');
  });
});
