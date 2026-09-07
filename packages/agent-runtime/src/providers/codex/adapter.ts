import type { ProviderStatus } from '@agent-dock/shared';
import type { AgentProvider, ProviderSessionHandle, StartSessionOptions } from '../../types.js';
import { type Logger, noopLogger } from '../../logger.js';
import { runProviderSession } from '../common/run-session.js';
import { resolveCodexTransportMode } from './app-server-support.js';
import { buildCodexArgs } from './build-args.js';
import { detectCodex } from './detect.js';
import { parseCodexLine } from './parser.js';
import { createCodexTransportWithFallback } from './transport-selection.js';

/**
 * Codex CLI adapter. Authentication is entirely owned by the `codex` binary via `codex login`.
 * This adapter never reads Codex's credential storage and never passes an API key.
 *
 * As of ADI-08 stage 7, this has two possible transports, selected by
 * `AGENT_DOCK_CODEX_TRANSPORT` (`resolveCodexTransportMode`, defaulting to `'exec'`):
 *
 * - `'exec'` (the shipped default): runs `codex exec --json ...` (or `codex exec resume <id>
 *   --json ...` to continue a prior thread) and normalizes its JSONL event stream, exactly as
 *   before this stage -- this branch is untouched code, not merely unaffected behavior, so there
 *   is zero risk to the transport every existing session already uses. The prompt travels over the
 *   child's stdin, never in argv (ADI-14): `buildCodexArgs` emits Codex's documented `-`
 *   placeholder in the prompt position and `promptViaStdin` below makes `runProviderSession` write
 *   the prompt to stdin. See build-args.ts for the argv-length and process-list-visibility reasons,
 *   and note that this is also what moves Codex's accepted-work boundary from the spawn attempt to
 *   the stdin flush (`providers/compatibility-manifest.ts`).
 * - `'app-server'` / `'auto'`: delegates to `transport-selection.ts`, which decides per-session
 *   (compatibility, auth source) whether to actually use the long-lived app-server JSON-RPC
 *   transport (`app-server/transport.ts`) or fail safely back to the exec path above -- see that
 *   file's own doc comment for the full decision and why it needs to be async.
 */
export class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const;
  readonly name = 'Codex';

  constructor(private readonly logger: Logger = noopLogger) {}

  detect(): Promise<ProviderStatus> {
    return detectCodex(this.logger);
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    if (resolveCodexTransportMode() === 'exec') {
      return runProviderSession(
        {
          providerId: 'codex',
          executableNames: ['codex'],
          buildArgs: buildCodexArgs,
          parseLine: parseCodexLine,
          promptViaStdin: true,
        },
        options,
        this.logger,
      );
    }
    return createCodexTransportWithFallback(options, this.logger);
  }
}
