import {
  DeleteRoundInput,
  GetInput,
  SaveRoundInput,
  StateDocumentsInput,
  type InterviewContextResult,
} from './interview-context-types.js';
import { getInterviewContextView, removeRound, saveRound, stateDocuments, type InterviewContextDeps } from './interview-context-service.js';
import { WorkspaceNotFoundError } from './workspace/repository.js';

/**
 * The `interview-context:*` IPC surface (#691) as plain functions, so `main.ts` only registers them and
 * the tests drive exactly what the renderer reaches. Input is parsed strictly (unknown keys refused).
 * No channel reaches a model, the network or a file outside the app's own artifact records; writes go
 * through the caller's application data reset gate.
 */

type Handler = (input: unknown) => Promise<InterviewContextResult>;

const INVALID: InterviewContextResult = { ok: false, code: 'invalid_request', message: 'That request was not understood.', view: null };
const FAILED: InterviewContextResult = { ok: false, code: 'failed', message: 'Something went wrong. Nothing was changed.', view: null };
const GONE: InterviewContextResult = { ok: false, code: 'not_found', message: 'That application is no longer available.', view: null };

function settle(error: unknown): InterviewContextResult {
  // Content-free on purpose: never echo an error that could carry stored text.
  return error instanceof WorkspaceNotFoundError ? GONE : FAILED;
}

export function createInterviewContextHandlers(service: () => Promise<InterviewContextDeps>): Record<string, Handler> {
  return {
    'interview-context:get': async (input) => {
      const parsed = GetInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return { ok: true, view: await getInterviewContextView(await service(), parsed.data.applicationId) };
      } catch (error) {
        return settle(error);
      }
    },
    'interview-context:state-documents': async (input) => {
      const parsed = StateDocumentsInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return await stateDocuments(await service(), parsed.data);
      } catch (error) {
        return settle(error);
      }
    },
    'interview-context:save-round': async (input) => {
      const parsed = SaveRoundInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return await saveRound(await service(), parsed.data);
      } catch (error) {
        return settle(error);
      }
    },
    'interview-context:delete-round': async (input) => {
      const parsed = DeleteRoundInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return await removeRound(await service(), parsed.data);
      } catch (error) {
        return settle(error);
      }
    },
  };
}

export const INTERVIEW_CONTEXT_CHANNELS = [
  'interview-context:get',
  'interview-context:state-documents',
  'interview-context:save-round',
  'interview-context:delete-round',
] as const;
