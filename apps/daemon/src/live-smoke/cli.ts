import { platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentDockClient } from '@agent-dock/client';
import {
  CLAUDE_LEGACY_COMPATIBILITY,
  CODEX_APP_SERVER_COMPATIBILITY,
  CODEX_LEGACY_COMPATIBILITY,
  createConsoleLogger,
  execCapture,
} from '@agent-dock/agent-runtime';
import type { ProviderId } from '@agent-dock/shared';
import { buildProviderRegistry } from '../providers.js';
import { checkAuthSourceSupportsAppServer } from './auth-source-gate.js';
import { isLiveProviderSmokeEnabled } from './opt-in.js';
import { checkVersionSupported } from './version-gate.js';
import { withSyntheticWorkspace } from './synthetic-workspace.js';
import { startLiveSmokeDaemon } from './daemon-instance.js';
import { runCancellationCase, runFreshRunCase } from './run-case.js';
import { appendEvidenceRecord, buildEvidenceRecord, LiveSmokeRedactionError } from './evidence.js';
import { isFailedResult, type LiveSmokeResultCode, type LiveSmokeTransportId } from './types.js';

const SMOKE_TIMEOUT_MS = 120_000;
const SMOKE_PROMPT = 'Reply with a single short sentence confirming you received this message. Do not use any tools.';
const CANCEL_PROMPT = 'Count slowly from 1 to 100, writing each number on its own line, waiting a moment between each.';

interface SmokeCaseDefinition {
  id: LiveSmokeTransportId;
  provider: ProviderId;
  pinnedVersion: string;
  /**
   * Set only for the app-server case (ADI-08 stage 8): `AGENT_DOCK_CODEX_TRANSPORT` is set to this
   * value for the duration of that one case's daemon-driven run, so `CodexProvider.startSession()`
   * (which reads that env var fresh on every call, not once at import time -- see
   * `resolveCodexTransportMode`) actually attempts the app-server transport instead of the
   * operator-facing default. Every other case leaves the env var untouched, matching the real
   * shipped default an operator who has set nothing would get.
   */
  transportModeEnv?: string;
}

/**
 * ADI-19's original scope was the two one-shot transports this repo shipped at the time; ADI-08
 * stage 8 added a third once the app-server transport (stage 5), its compatibility-manifest entry
 * (stage 6), and its daemon wiring with a safe exec fallback (stage 7) all landed. Upstream's own
 * harness also covers `claude-agent-sdk`; see `types.ts`'s doc comment on why that one is still
 * deliberately not here.
 */
const CASES: SmokeCaseDefinition[] = [
  { id: 'claude-legacy-one-shot', provider: 'claude', pinnedVersion: CLAUDE_LEGACY_COMPATIBILITY.providerVersion },
  { id: 'codex-legacy-one-shot', provider: 'codex', pinnedVersion: CODEX_LEGACY_COMPATIBILITY.providerVersion },
  {
    id: 'codex-app-server',
    provider: 'codex',
    pinnedVersion: CODEX_APP_SERVER_COMPATIBILITY.providerVersion,
    transportModeEnv: 'app-server',
  },
];

/** Spawns through `execCapture` (ADI-15's environment allowlist), not a bare `node:child_process`
 * call -- see `synthetic-workspace.ts`'s own `git()` helper for why this repo restricts that
 * import outright. */
async function resolveCommit(): Promise<string> {
  const result = await execCapture('git', ['rev-parse', 'HEAD']);
  if (result.timedOut || result.code !== 0) {
    throw new Error(`git rev-parse HEAD failed (code ${result.code}, timed out ${result.timedOut}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function runOneCase(evidencePath: string, commit: string, definition: SmokeCaseDefinition): Promise<LiveSmokeResultCode> {
  const startedAt = Date.now();
  const registry = buildProviderRegistry(createConsoleLogger('live-smoke-detect', 'info'));
  const adapter = registry.get(definition.provider);
  if (!adapter) throw new Error(`no provider adapter registered for ${definition.provider}`);
  const status = await adapter.detect();

  async function record(resultCode: LiveSmokeResultCode): Promise<void> {
    const base = {
      commit,
      os: platform(),
      provider: definition.provider,
      transport: definition.id,
      authStatus: status.authenticated,
      resultCode,
      durationMs: Date.now() - startedAt,
    } as const;
    try {
      await appendEvidenceRecord(evidencePath, buildEvidenceRecord({ ...base, providerVersion: status.version }));
    } catch (error) {
      if (!(error instanceof LiveSmokeRedactionError)) throw error;
      // A malformed field (most likely a bogus --version string) must never sink the whole
      // evidence row for this case -- losing evidence entirely is worse than omitting one field.
      console.warn(`live-provider-smoke: dropping an unsafe field from the ${definition.id} evidence row: ${error.message}`);
      await appendEvidenceRecord(evidencePath, buildEvidenceRecord({ ...base, providerVersion: undefined }));
    }
  }

  if (!status.installed) {
    await record('skipped_missing_binary');
    return 'skipped_missing_binary';
  }
  if (status.authenticated !== 'authenticated') {
    await record('skipped_missing_auth');
    return 'skipped_missing_auth';
  }
  const versionGate = checkVersionSupported(status.version, definition.pinnedVersion);
  if (!versionGate.supported) {
    await record('skipped_version_stale');
    return 'skipped_version_stale';
  }
  if (definition.transportModeEnv && !checkAuthSourceSupportsAppServer(status.authSource).supported) {
    await record('skipped_auth_source_incompatible');
    return 'skipped_auth_source_incompatible';
  }

  // Scoped to this one case's daemon-driven run only, and always restored -- including if
  // `startLiveSmokeDaemon()` itself throws before the daemon-owning `try` below ever starts, which
  // is exactly why that call is INSIDE this `try`, not before it. `resolveCodexTransportMode` reads
  // this env var fresh on every `CodexProvider.startSession()` call (see its own doc comment), so
  // setting it here -- rather than needing a per-daemon-instance option -- is what actually makes
  // the daemon this case drives attempt the app-server transport instead of the shipped `'exec'`
  // default every other case in this file exercises with nothing set.
  const previousTransportEnv = process.env.AGENT_DOCK_CODEX_TRANSPORT;
  if (definition.transportModeEnv) process.env.AGENT_DOCK_CODEX_TRANSPORT = definition.transportModeEnv;

  try {
    const daemon = await startLiveSmokeDaemon();
    try {
      const client = new AgentDockClient({ baseUrl: daemon.baseUrl, token: daemon.token });
      return await withSyntheticWorkspace(async (workspace) => {
        const fresh = await runFreshRunCase(client.sessions, {
          provider: definition.provider,
          cwd: workspace.cwd,
          prompt: SMOKE_PROMPT,
          timeoutMs: SMOKE_TIMEOUT_MS,
        });

        if (fresh.resultCode === 'success' && fresh.session) {
          if (status.capabilities.cancellation) {
            const cancellation = await withSyntheticWorkspace(async (cancelWorkspace) => {
              // Deliberately NOT `runFreshRunCase` here: that helper drains a session to full
              // completion before returning, which would make the cancel below race an
              // already-terminal session and fail every real run. `runCancellationCase` needs the
              // session while it's still live, so it is created directly and handed off immediately.
              const cancelSession = await client.sessions.create({
                provider: definition.provider,
                cwd: cancelWorkspace.cwd,
                prompt: CANCEL_PROMPT,
              });
              return runCancellationCase(client.sessions, cancelSession, SMOKE_TIMEOUT_MS);
            });
            if (cancellation.resultCode !== 'success') {
              await record(cancellation.resultCode);
              return cancellation.resultCode;
            }
          }

          if (status.capabilities.resume && fresh.session.providerSessionId) {
            const continuation = await runFreshRunCase(client.sessions, {
              provider: definition.provider,
              cwd: workspace.cwd,
              prompt: SMOKE_PROMPT,
              timeoutMs: SMOKE_TIMEOUT_MS,
              resumeProviderSessionId: fresh.session.providerSessionId,
            });
            if (continuation.resultCode !== 'success') {
              await record(continuation.resultCode);
              return continuation.resultCode;
            }
          }
        }

        await record(fresh.resultCode);
        return fresh.resultCode;
      });
    } finally {
      await daemon.close();
    }
  } finally {
    if (definition.transportModeEnv) {
      if (previousTransportEnv === undefined) delete process.env.AGENT_DOCK_CODEX_TRANSPORT;
      else process.env.AGENT_DOCK_CODEX_TRANSPORT = previousTransportEnv;
    }
  }
}

async function main(): Promise<void> {
  if (!isLiveProviderSmokeEnabled()) {
    console.log('live-provider-smoke: AGENT_DOCK_LIVE_PROVIDER_SMOKE is not set to "1", skipping.');
    return;
  }
  const commit = await resolveCommit();
  const evidencePath = join(process.cwd(), 'live-provider-smoke-evidence.jsonl');
  let sawFailure = false;
  for (const definition of CASES) {
    console.log(`live-provider-smoke: running ${definition.id}...`);
    const resultCode = await runOneCase(evidencePath, commit, definition);
    console.log(`live-provider-smoke: ${definition.id} -> ${resultCode}`);
    if (isFailedResult(resultCode)) sawFailure = true;
  }
  console.log(`live-provider-smoke: evidence written to ${evidencePath}`);
  if (sawFailure) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error('live-provider-smoke: fatal error', error);
    process.exitCode = 1;
  });
}
