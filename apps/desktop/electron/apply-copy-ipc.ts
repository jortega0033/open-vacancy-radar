import { getApplyCopyFields } from './apply-copy-fields.js';
import { ApplyCopyGetInput, type ApplyCopyResult } from './apply-copy-types.js';
import type { WorkspaceDb } from './workspace/client.js';
import { WorkspaceNotFoundError } from './workspace/repository.js';

/**
 * The `apply-copy-fields:*` IPC surface (#660) as plain functions, so `main.ts` only registers them
 * and the tests drive exactly what the renderer reaches. Input is parsed strictly (unknown keys
 * refused). Read-only: no channel writes, renders, or reaches a model, the network, or any file
 * outside the attempt's own staged artifacts.
 */

type Handler = (input: unknown) => Promise<ApplyCopyResult>;

const INVALID: ApplyCopyResult = { ok: false, code: 'invalid_request', message: 'That request was not understood.', view: null };
const FAILED: ApplyCopyResult = { ok: false, code: 'failed', message: 'The copy fields could not be read.', view: null };
const GONE: ApplyCopyResult = { ok: false, code: 'not_found', message: 'That application is no longer available.', view: null };

export function createApplyCopyHandlers(deps: () => Promise<{ db: WorkspaceDb }>): Record<string, Handler> {
  return {
    'apply-copy-fields:get': async (input) => {
      const parsed = ApplyCopyGetInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return { ok: true, view: await getApplyCopyFields((await deps()).db, parsed.data.attemptId) };
      } catch (error) {
        // Content-free on purpose: never echo an error that could carry stored text.
        return error instanceof WorkspaceNotFoundError ? GONE : FAILED;
      }
    },
  };
}
