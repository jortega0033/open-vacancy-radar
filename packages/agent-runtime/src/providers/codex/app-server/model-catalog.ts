import { parseCodexModelCatalog, type CodexAppServerModel } from './scope-evidence.js';
import { withCodexAppServerRpc, type CodexAppServerProbeOptions } from './scope-probe.js';

/**
 * Fetches Codex's live model catalog over a short-lived, read-only app-server session (ADI-22a):
 * the same `model/list` RPC call and `parseCodexModelCatalog` parser `app-server/transport.ts`
 * (before every real `thread/start`/`thread/resume`) and `scope-probe.ts`'s
 * `probeCodexAppServerScope` already use, reused here as its own probe with no thread or turn ever
 * started. `withCodexAppServerRpc` gives this the same teardown and timeout discipline
 * `probeCodexAppServerScope` already has (its own 4s bound, `scope-probe.ts`'s
 * `SCOPE_PROBE_TIMEOUT_MS`), so a caller on the daemon's request path (`GET
 * /v2/providers/:providerId/models`, `POST /v2/sessions`'s capability resolution) can never hang
 * past it.
 *
 * Deliberately narrower than `probeCodexAppServerScope`: no `account/read` call, no auth-source
 * cross-check, and no `CodexContinuationEvidence` binding -- a plain catalog listing has no need
 * for any of that, and adding it would mean every catalog-only caller paying for (and being able to
 * fail on) an account check it never asked for.
 */
export async function probeCodexModelCatalog(options: CodexAppServerProbeOptions): Promise<readonly CodexAppServerModel[]> {
  return withCodexAppServerRpc(options, async (rpc) =>
    parseCodexModelCatalog(await rpc.request('model/list', { limit: 1_024, includeHidden: false })),
  );
}
