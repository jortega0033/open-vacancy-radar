import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CREDENTIAL_SHAPED_ENV_DENY_PATTERNS } from '@agent-dock/shared';
import {
  buildProviderEnvironment,
  isDeniedProviderEnvironmentName,
  providerEnvironmentAllowlist,
  PROVIDER_CONFIG_VARIABLES,
  PROVIDER_ENVIRONMENT_DENY_PATTERNS,
  WINDOWS_RUNTIME_INJECTED_VARIABLES,
} from '../src/providers/common/provider-environment.js';
import { spawnProcess } from '../src/process/spawn-process.js';
import { execCapture } from '../src/process/exec-capture.js';
import { findExecutable } from '../src/detect-executable.js';
import { detectClaude } from '../src/providers/claude/detect.js';
import { detectCodex } from '../src/providers/codex/detect.js';
import { createConsoleLogger } from '../src/logger.js';

const ENV_DUMP_FIXTURE = fileURLToPath(new URL('./fixtures/fake-env-dump.mjs', import.meta.url));
const JOB_HOST = fileURLToPath(
  new URL('../../../apps/daemon/dist/agent-dock-job-host.exe', import.meta.url),
);
const isWindows = process.platform === 'win32';

/**
 * A value no real environment variable could plausibly hold, planted in every poisoned variable so
 * a leak can be detected by *value* as well as by name. Name-only assertions would miss a child
 * that received a secret under a different key (a wrapper re-exporting it, say).
 */
const SENTINEL = 'ADI15-SENTINEL-6f2b9c41-do-not-leak';

/**
 * The parent-process poison. Three deliberate groups:
 *
 * 1. Credential-shaped names from common ecosystems -- what the deny list exists for.
 * 2. This product's own env-backed vacancy-source credentials and daemon internals -- the real,
 *    currently-shipping exposure ADI-15 closes (`packages/vacancy-engine/src/config.ts`,
 *    `apps/desktop/electron/main.ts`).
 * 3. `FOO_BAR_BAZ` and `HARMLESS_LOOKING_VAR`, which match **no** deny pattern at all. These are the
 *    load-bearing ones: they are excluded only because the allowlist never granted them. A denylist
 *    that happened to cover this test's secret-shaped names would still let these two through, so
 *    their absence is what proves the mechanism is a real allowlist.
 */
const POISON: Record<string, string> = Object.fromEntries(
  [
    'AWS_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SESSION_TOKEN',
    'AZURE_CLIENT_SECRET',
    'GCP_SERVICE_ACCOUNT_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'NPM_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'STRIPE_SECRET_KEY',
    'DATABASE_PASSWORD',
    'SIGNING_PRIVATE_KEY',
    'SLACK_WEBHOOK_TOKEN',
    'DOCKER_PASSWORD',
    'SSH_AUTH_SOCK',
    'VAULT_TOKEN',
    'MY_COMPANY_SECRET',
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

/** The daemon's and Electron's own internals, asserted separately from the credential sweep. */
const DAEMON_INTERNAL: Record<string, string> = {
  AGENT_DOCK_STATE_DIR: `${SENTINEL}:state-dir`,
  AGENT_DOCK_APP_ID: `${SENTINEL}:app-id`,
  AGENT_DOCK_PORT: `${SENTINEL}:port`,
  AGENT_DOCK_LOG_LEVEL: `${SENTINEL}:log-level`,
  ELECTRON_RUN_AS_NODE: `${SENTINEL}:electron`,
};

const ALL_PLANTED = { ...POISON, ...DAEMON_INTERNAL };

describe('PROVIDER_ENVIRONMENT_DENY_PATTERNS (issue #176)', () => {
  it('carries every pattern in the shared credential-shaped list, by construction not duplication', () => {
    // Regexes are objects, so this asserts on source/flags rather than reference identity -- the
    // real property under test is that PROVIDER_ENVIRONMENT_DENY_PATTERNS was built by spreading
    // CREDENTIAL_SHAPED_ENV_DENY_PATTERNS in (see provider-environment.ts), not by hand-copying it,
    // the same structural guarantee apps/desktop's daemon-environment.test.ts asserts on its side.
    const providerSources = PROVIDER_ENVIRONMENT_DENY_PATTERNS.map((p) => `${p.source}/${p.flags}`);
    for (const shared of CREDENTIAL_SHAPED_ENV_DENY_PATTERNS) {
      expect(providerSources).toContain(`${shared.source}/${shared.flags}`);
    }
  });
});

describe('buildProviderEnvironment (policy, no subprocess)', () => {
  it('grants only allowlisted names and reports the rest as dropped', () => {
    const { env, dropped } = buildProviderEnvironment(
      { PATH: '/bin', FOO_BAR_BAZ: 'x', AWS_SECRET_ACCESS_KEY: 'y' },
      { platform: 'linux' },
    );
    expect(env).toEqual({ PATH: '/bin' });
    expect(dropped).toEqual(['AWS_SECRET_ACCESS_KEY', 'FOO_BAR_BAZ']);
  });

  it('reports dropped names only, never values', () => {
    const { dropped } = buildProviderEnvironment(
      { AWS_SECRET_ACCESS_KEY: SENTINEL },
      { platform: 'linux' },
    );
    // The whole reason `dropped` is `string[]` and not a record: a caller logging it cannot leak a
    // secret by accident, because the type gives it nothing to leak.
    expect(dropped).toEqual(['AWS_SECRET_ACCESS_KEY']);
    expect(JSON.stringify(dropped)).not.toContain(SENTINEL);
  });

  it('denyOverridesAllowlist: the deny list wins even over an explicitly granted name', () => {
    // The shipped two lists are disjoint, so this is the only way to exercise the ordering rather
    // than merely assert it. If the implementation checked deny *before* allow, or skipped it for
    // allowed names, this would return the secret.
    const { env, dropped } = buildProviderEnvironment(
      { PATH: '/bin', COMPANY_API_KEY: SENTINEL },
      { platform: 'linux', allowlistOverride: ['PATH', 'COMPANY_API_KEY'] },
    );
    expect(env).toEqual({ PATH: '/bin' });
    expect(dropped).toEqual(['COMPANY_API_KEY']);
  });

  it('matches the deny list case-insensitively on every platform, allowlist per platform rules', () => {
    // Windows environment variables are case-insensitive, so `Path` is `PATH` there...
    expect(buildProviderEnvironment({ Path: 'x' }, { platform: 'win32' }).env).toEqual({ Path: 'x' });
    // ...and genuinely a different variable on POSIX.
    expect(buildProviderEnvironment({ Path: 'x' }, { platform: 'linux' }).env).toEqual({});
    // Deny is fail-closed everywhere regardless of casing.
    expect(isDeniedProviderEnvironmentName('aws_secret_access_key')).toBe(true);
    expect(isDeniedProviderEnvironmentName('github_token')).toBe(true);
    expect(isDeniedProviderEnvironmentName('agent_dock_state_dir')).toBe(true);
  });

  it('excludes innocuous unlisted names via the allowlist, not the deny list', () => {
    // If either of these ever became deny-matched, the sentinel sweep below would stop proving what
    // it claims to prove, so the property is pinned here rather than left to inspection.
    expect(isDeniedProviderEnvironmentName('FOO_BAR_BAZ')).toBe(false);
    expect(isDeniedProviderEnvironmentName('HARMLESS_LOOKING_VAR')).toBe(false);
    expect(buildProviderEnvironment({ FOO_BAR_BAZ: 'x' }, { platform: 'linux' }).env).toEqual({});
  });

  it('treats a variable literally named __proto__ as a key, not a prototype assignment', () => {
    // The computed key is load-bearing: `{ __proto__: 'poison' }` written literally is the
    // prototype-setter syntax and creates no own property at all, so the builder's loop would never
    // see the key and this test would silently exercise nothing. `{ ['__proto__']: ... }` does
    // create a real own property, which is also what `env __proto__=x ./daemon` produces on Linux.
    const parent = { ['__proto__']: 'poison', PATH: '/bin' } as unknown as NodeJS.ProcessEnv;
    expect(Object.getOwnPropertyNames(parent)).toContain('__proto__');

    const { env } = buildProviderEnvironment(parent, {
      platform: 'linux',
      allowlistOverride: ['PATH', '__proto__'],
    });
    expect(Object.getPrototypeOf(env)).toBeNull();
    expect(Object.getOwnPropertyNames(env)).toContain('__proto__');
    expect(env.PATH).toBe('/bin');
  });

  it('grants the variables it claims to grant', () => {
    // The counterweight to every "is absent" assertion in this file. A builder that returned `{}`
    // would satisfy all of those, so at least one test has to fail when the allowlist stops
    // granting anything -- otherwise the suite can only detect under-restriction, never the
    // over-restriction this design names as its primary feared failure mode.
    const posix = buildProviderEnvironment(
      { PATH: '/bin', HOME: '/home/u', TMPDIR: '/tmp', CODEX_HOME: '/home/u/.codex' },
      { platform: 'linux' },
    );
    expect(posix.env).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
      TMPDIR: '/tmp',
      CODEX_HOME: '/home/u/.codex',
    });
    expect(posix.dropped).toEqual([]);

    const windows = buildProviderEnvironment(
      { Path: 'C:\\bin', PATHEXT: '.EXE', APPDATA: 'C:\\a', USERPROFILE: 'C:\\u' },
      { platform: 'win32' },
    );
    expect(windows.env).toEqual({
      Path: 'C:\\bin',
      PATHEXT: '.EXE',
      APPDATA: 'C:\\a',
      USERPROFILE: 'C:\\u',
    });
  });

  it('keeps an allowlisted empty-string value rather than treating it as unset', () => {
    const { env, dropped } = buildProviderEnvironment(
      { PATH: '', HOME: undefined },
      { platform: 'linux' },
    );
    expect(env).toEqual({ PATH: '' });
    // `HOME: undefined` is reported as neither granted nor dropped, and that is the right call: an
    // explicitly-unset variable was never present, so calling it "dropped" would misattribute an
    // absence to this policy. `dropped` means "removed by the allowlist/deny decision", which is
    // what makes it useful for diagnosing over-restriction.
    expect(dropped).toEqual([]);
  });

  it('deniedNamesAreDisjointFromRuntimeInjected', () => {
    // A deny pattern matching one of these would be a fiction on Windows: the process runtime
    // re-adds them from the parent no matter what this module returns (see the constant's doc
    // comment). Better to fail here than to ship a guarantee the OS quietly overrides.
    for (const name of WINDOWS_RUNTIME_INJECTED_VARIABLES) {
      expect(isDeniedProviderEnvironmentName(name)).toBe(false);
    }
  });

  it('never grants a name that its own deny list matches', () => {
    for (const name of [
      ...providerEnvironmentAllowlist('win32'),
      ...providerEnvironmentAllowlist('linux'),
      ...PROVIDER_CONFIG_VARIABLES,
    ]) {
      expect([name, isDeniedProviderEnvironmentName(name)]).toEqual([name, false]);
    }
  });
});

describe('spawned child environment (real spawnProcess, sentinel sweep)', () => {
  const saved = new Map<string, string | undefined>();
  let workdir: string;

  beforeAll(async () => {
    for (const [name, value] of Object.entries(ALL_PLANTED)) {
      saved.set(name, process.env[name]);
      process.env[name] = value;
    }
    workdir = await mkdtemp(join(tmpdir(), 'ovr env sweep '));
  });

  afterAll(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /**
   * Spawns the env-dump fixture through the real `spawnProcess` and returns what it actually saw.
   *
   * `useJobHost` exists because Windows has two genuinely different spawn paths and provider code
   * uses both: a session goes through the Job Host (an extra process hop, where the provider
   * inherits the host's block rather than one we hand it directly), while `execCapture` sets
   * `useJobHostOnWindows: false`, which is the path *all* provider detection takes. They share the
   * filter call, but only one of them was being swept.
   */
  async function childEnvironment(useJobHost = true): Promise<Record<string, string>> {
    const tree = spawnProcess(process.execPath, [ENV_DUMP_FIXTURE], {
      cwd: workdir,
      ...(isWindows && useJobHost ? { windowsJobHostPath: JOB_HOST } : {}),
      ...(useJobHost ? {} : { useJobHostOnWindows: false }),
    });
    let stdout = '';
    tree.child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    tree.child.stdin.end();
    const { code } = await tree.exit;
    expect(code).toBe(0);
    try {
      return JSON.parse(stdout) as Record<string, string>;
    } catch {
      // Deliberately does not include `stdout` in the message: it is a full environment dump, so a
      // parse failure (a stray Node warning, a Job Host handshake regression) would otherwise echo
      // real environment content into CI output -- the exact thing this suite exists to prevent.
      throw new Error(`env-dump fixture produced unparseable output (${stdout.length} bytes)`);
    }
  }

  it(
    'hands the child none of the poisoned variables, by name or by value',
    async () => {
      const childEnv = await childEnvironment();

      // Sanity check that the poison was actually planted, so a silently-empty parent environment
      // cannot make this whole suite pass vacuously.
      expect(process.env.AWS_SECRET_ACCESS_KEY).toBe(`${SENTINEL}:AWS_SECRET_ACCESS_KEY`);

      for (const name of Object.keys(POISON)) {
        expect([name, name in childEnv]).toEqual([name, false]);
      }
      // Value-level sweep: nothing the child received contains the sentinel under any key at all.
      for (const [name, value] of Object.entries(childEnv)) {
        expect([name, value.includes(SENTINEL)]).toEqual([name, false]);
      }
    },
    30_000,
  );

  it(
    'excludes a plausible-but-unlisted innocuous variable, proving a real allowlist',
    async () => {
      const childEnv = await childEnvironment();
      expect('FOO_BAR_BAZ' in childEnv).toBe(false);
      expect('HARMLESS_LOOKING_VAR' in childEnv).toBe(false);
    },
    30_000,
  );

  it(
    "never leaks the daemon's own internal variables",
    async () => {
      const childEnv = await childEnvironment();
      for (const name of Object.keys(DAEMON_INTERNAL)) {
        expect([name, name in childEnv]).toEqual([name, false]);
      }
      // The per-launch discovery token is deliberately not in this list: it is not an environment
      // variable at all. It is generated per launch and written to a 0600 discovery file
      // (`apps/daemon/src/discovery-file.ts`), read back by Electron and held in memory, so there
      // is nothing here for it to leak through. `AGENT_DOCK_*` is denied on its own merits.
      expect(Object.keys(childEnv).some((name) => /^AGENT_DOCK_/i.test(name))).toBe(false);
    },
    30_000,
  );

  it(
    'applies the same policy on the direct-spawn path provider detection uses',
    async () => {
      // `execCapture` (and therefore `findExecutable` and both providers' `detect.ts`) bypasses the
      // Windows Job Host. Same filter call, different spawn path -- asserted rather than assumed,
      // since "detection sees a broader environment than a session" would make detection results
      // meaningless as a prediction of what a session gets.
      const childEnv = await childEnvironment(false);
      for (const name of Object.keys(ALL_PLANTED)) {
        expect([name, name in childEnv]).toEqual([name, false]);
      }
      expect(childEnv.PATH ?? childEnv.Path).toBeTruthy();
    },
    30_000,
  );

  it(
    "keys are a strict subset of the allowlist plus the platform's forced additions",
    async () => {
      const childEnv = await childEnvironment();
      const permitted = new Set(
        [
          ...providerEnvironmentAllowlist(process.platform),
          // Not a policy grant. On Windows libuv merges its own `required_vars` in from the real
          // parent environment, so `spawn(..., { env: {} })` still yields these eleven. Padding the
          // allowlist to hide that would turn a platform fact into a green check.
          ...(isWindows ? WINDOWS_RUNTIME_INJECTED_VARIABLES : []),
        ].map((name) => name.toLowerCase()),
      );

      const unexpected = Object.keys(childEnv).filter(
        (name) => !permitted.has(name.toLowerCase()),
      );
      expect(unexpected).toEqual([]);

      // A subset assertion alone is satisfied by an empty environment, so it can only ever detect
      // under-restriction. These two lines are what make it also detect over-restriction: the child
      // must actually be able to find executables, which is the single most load-bearing grant and
      // the one whose loss would present as a false "provider not installed".
      expect(childEnv.PATH ?? childEnv.Path).toBeTruthy();
      if (isWindows) expect(childEnv.PATHEXT).toBeTruthy();
      else expect(childEnv.HOME).toBeTruthy();
    },
    30_000,
  );
});

/**
 * Real-binary regression, opt-in.
 *
 * CONTRIBUTING.md's testing requirements are explicit that no test may depend on a real,
 * authenticated provider CLI being present, because CI has none -- so this is gated behind
 * `AGENT_DOCK_LIVE_PROVIDER_SMOKE=1` (the variable name ADI-19 already reserves for exactly this
 * shape of check) *and* skips per-provider when the executable is missing. Ordinary `pnpm test`
 * never runs it.
 *
 * It asserts `authenticated !== 'unknown'` rather than `=== 'authenticated'`: an installed CLI that
 * nobody has logged into is a legitimate state, whereas `'unknown'` is precisely the failure an
 * over-restrictive environment produces -- the probe ran and could not be understood. That is the
 * regression this ticket's stop condition names, so it is what gets asserted.
 */
const liveSmokeEnabled = process.env.AGENT_DOCK_LIVE_PROVIDER_SMOKE === '1';

describe.runIf(liveSmokeEnabled)('real provider CLIs under the restricted environment', () => {
  const logger = createConsoleLogger('adi15-live-smoke', 'error');

  it('claude --version and detectClaude() still succeed', async () => {
    const executable = await findExecutable(['claude']);
    if (!executable) return;
    const version = await execCapture(executable, ['--version'], { timeoutMs: 20_000 });
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).not.toBe('');

    const status = await detectClaude(logger);
    expect(status.installed).toBe(true);
    expect(status.authenticated).not.toBe('unknown');
    expect(status.error).toBeUndefined();
  }, 60_000);

  it('codex --version and detectCodex() still succeed', async () => {
    const executable = await findExecutable(['codex']);
    if (!executable) return;
    const version = await execCapture(executable, ['--version'], { timeoutMs: 20_000 });
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).not.toBe('');

    const status = await detectCodex(logger);
    expect(status.installed).toBe(true);
    expect(status.authenticated).not.toBe('unknown');
    expect(status.error).toBeUndefined();
  }, 60_000);
});
