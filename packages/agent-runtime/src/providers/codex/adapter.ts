import { tmpdir } from 'node:os';
import type { ProviderModelV2, ProviderStatus } from '@agent-dock/shared';
import type { AgentProvider, ProviderModelCatalogOptions, ProviderSessionHandle, StartSessionOptions } from '../../types.js';
import { findExecutable } from '../../detect-executable.js';
import { type Logger, noopLogger } from '../../logger.js';
import { runProviderSession } from '../common/run-session.js';
import { resolveCodexTransportMode } from './app-server-support.js';
import { probeCodexModelCatalog } from './app-server/model-catalog.js';
import { buildCodexArgs } from './build-args.js';
import { detectCodex } from './detect.js';
import { parseCodexLine } from './parser.js';
import { createCodexTransportWithFallback } from './transport-selection.js';

const EXECUTABLE_NAMES = ['codex'];

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
          executableNames: EXECUTABLE_NAMES,
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

  /**
   * ADI-22a. A thin wrapper over the same live `model/list` RPC `app-server/transport.ts` and
   * `scope-probe.ts` already call before every real session (`app-server/model-catalog.ts`'s
   * `probeCodexModelCatalog`) -- deliberately independent of `AGENT_DOCK_CODEX_TRANSPORT`: a
   * read-only catalog probe carries none of the risk that gates using the app-server transport for
   * a real turn, and `transport-selection.ts` already documents this exact kind of caller ("a
   * future settings/diagnostics surface") as one `probeCodexAppServerScope` was left unwired for.
   *
   * Resolves to an empty catalog, never a rejection, when the `codex` executable itself cannot be
   * found -- "no CLI installed" is not an infrastructure failure this method should propagate as
   * one, and both callers (the `GET /v2/providers/:providerId/models` route and `POST
   * /v2/sessions`'s capability resolution) already treat an empty/failed catalog identically.
   * `options.cwd` defaults to the OS temp directory: this probe's `model/list` call has no
   * dependency on a real workspace, and a caller with no session-specific directory (the read-only
   * route) has nothing more meaningful to offer.
   */
  async fetchModelCatalog(options: ProviderModelCatalogOptions = {}): Promise<readonly ProviderModelV2[]> {
    const executablePath = await findExecutable(EXECUTABLE_NAMES);
    if (!executablePath) return [];
    const catalog = await probeCodexModelCatalog({
      executable: executablePath,
      cwd: options.cwd ?? tmpdir(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return catalog.map(({ id, displayName, isDefault }) => ({ id, displayName, isDefault }));
  }
}
