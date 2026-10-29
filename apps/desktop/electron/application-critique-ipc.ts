import { z } from 'zod';
import {
  acceptProposal,
  cancelCritique,
  getCritiqueView,
  rejectProposal,
  runCritique,
  type CritiqueDeps,
} from './application-critique-service.js';
import { DRAFT_KINDS, type CritiqueActionResult } from './application-critique-types.js';
import { WorkspaceNotFoundError } from './workspace/repository.js';

/**
 * The `application-critique:*` IPC surface (#690) as plain functions, so `main.ts` only registers them
 * and the tests drive exactly what the renderer reaches. Input is parsed strictly (unknown keys are
 * refused): the renderer names an attempt and, to decide on a suggestion, the review run and document
 * hash it was looking at. It cannot send a document, a fact, a prompt, a provider or a permission.
 *
 * Only `run` can reach a model, and it is the explicit action; `get` never does. Decisions on a
 * suggestion write under the caller's data-reset gate. A running review is NOT held under that gate
 * (it can take minutes); a reset cancels it and every write it would make is refused once its attempt
 * is gone.
 */

const Id = z.string().trim().min(1).max(200);
const AttemptInput = z.object({ attemptId: Id }).strict();
const TargetInput = z
  .object({
    attemptId: Id,
    runId: Id,
    document: z.enum(DRAFT_KINDS),
    baseContentHash: z.string().trim().min(1).max(100),
  })
  .strict();

export interface ApplicationCritiqueIpcDeps {
  service(): Promise<CritiqueDeps>;
  mutate<T>(task: () => T | Promise<T>): Promise<T>;
}

type Handler = (input: unknown) => Promise<unknown>;

const INVALID: CritiqueActionResult = { ok: false, code: 'invalid_request', message: 'That request was not understood.', view: null };
const FAILED: CritiqueActionResult = { ok: false, code: 'failed', message: 'Something went wrong. Your documents were not changed.', view: null };
const GONE: CritiqueActionResult = { ok: false, code: 'not_found', message: 'That application is no longer available.', view: null };

function settle(error: unknown): CritiqueActionResult {
  // A stable, content-free failure: never echo an error that could carry stored text.
  return error instanceof WorkspaceNotFoundError ? GONE : FAILED;
}

export function createApplicationCritiqueHandlers(deps: ApplicationCritiqueIpcDeps): Record<string, Handler> {
  return {
    'application-critique:get': async (input): Promise<CritiqueActionResult> => {
      const parsed = AttemptInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return { ok: true, view: await getCritiqueView(await deps.service(), parsed.data.attemptId) };
      } catch (error) {
        return settle(error);
      }
    },
    'application-critique:run': async (input): Promise<CritiqueActionResult> => {
      const parsed = AttemptInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return await runCritique(await deps.service(), parsed.data.attemptId);
      } catch (error) {
        return settle(error);
      }
    },
    'application-critique:cancel': async (input): Promise<{ ok: boolean }> => {
      const parsed = AttemptInput.safeParse(input);
      return { ok: parsed.success ? cancelCritique(parsed.data.attemptId) : false };
    },
    'application-critique:reject': async (input): Promise<CritiqueActionResult> => {
      const parsed = TargetInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return await deps.mutate(async () => rejectProposal(await deps.service(), parsed.data));
      } catch (error) {
        return settle(error);
      }
    },
    'application-critique:accept': async (input): Promise<CritiqueActionResult> => {
      const parsed = TargetInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return await deps.mutate(async () => acceptProposal(await deps.service(), parsed.data));
      } catch (error) {
        return settle(error);
      }
    },
  };
}

export const APPLICATION_CRITIQUE_CHANNELS = [
  'application-critique:get',
  'application-critique:run',
  'application-critique:cancel',
  'application-critique:reject',
  'application-critique:accept',
] as const;
