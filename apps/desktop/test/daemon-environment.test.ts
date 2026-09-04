import { describe, expect, it } from 'vitest';
import { buildDaemonEnvironment, isDeniedDaemonEnvironmentName } from '../electron/daemon-environment.js';

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
