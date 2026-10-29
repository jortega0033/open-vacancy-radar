import { z } from 'zod';
import type { BriefResult, CommitAssessmentResult, PrepareAssessmentResult } from './application-brief.js';
import {
  commitAssessment,
  correctPreference,
  getBrief,
  prepareAssessment,
  type BriefServiceDeps,
} from './application-brief-service.js';
import { WorkspaceNotFoundError } from './workspace/repository.js';

/**
 * The `application-brief:*` IPC surface (#688) as plain functions, so `main.ts` only registers them
 * and the tests drive exactly what the renderer reaches. Input is parsed strictly (unknown keys are
 * refused), every call that writes runs through the caller's data-reset gate, and nothing here starts
 * a model session or a network request: the renderer runs the explicit assessment itself and hands the
 * result back through `commit-assessment`, which refuses it if its inputs changed.
 */

const Id = z.string().trim().min(1).max(200);

const TargetInput = z
  .object({ savedJobId: Id.optional(), attemptId: Id.optional() })
  .strict()
  .refine((value) => (value.savedJobId === undefined) !== (value.attemptId === undefined), {
    message: 'exactly one of savedJobId or attemptId is required',
  });

const PrepareInput = z.object({ savedJobId: Id }).strict();

const CommitInput = z
  .object({
    savedJobId: Id,
    fence: z
      .object({
        briefId: Id,
        factsVersion: z.number().int().min(0),
        jdHash: z.string().min(1).max(100),
        cvId: Id,
        cvHash: z.string().min(1).max(100),
        overlayId: Id.nullable(),
        overlayCaseRevision: z.string().max(100).nullable(),
      })
      .strict(),
    requirements: z.array(z.unknown()).max(200),
    requirementCoverage: z
      .object({ status: z.enum(['partial', 'complete']), batches: z.number().int().min(0).max(20) })
      .strict(),
  })
  .strict();

const PreferenceInput = z
  .object({
    relocationWilling: z.boolean().optional(),
    primaryCountry: z.string().trim().max(120).optional(),
    professionalLanguage: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to change' });

export interface ApplicationBriefIpcDeps {
  service(): Promise<BriefServiceDeps>;
  /** The data-reset gate: writes wait for / are refused during a reset. */
  mutate<T>(task: () => T | Promise<T>): Promise<T>;
}

type Handler = (input: unknown) => Promise<unknown>;

const INVALID: BriefResult = { ok: false, code: 'invalid_request', message: 'That request was not understood.' };

export function createApplicationBriefHandlers(deps: ApplicationBriefIpcDeps): Record<string, Handler> {
  return {
    // Reading a brief refreshes the stored copy from the scan row / attempt that is on disk, so it
    // writes locally; it is still gated like any other write.
    'application-brief:get': async (input): Promise<BriefResult> => {
      const parsed = TargetInput.safeParse(input);
      if (!parsed.success) return INVALID;
      const target = parsed.data.savedJobId !== undefined ? { savedJobId: parsed.data.savedJobId } : { attemptId: parsed.data.attemptId! };
      try {
        const view = await deps.mutate(async () => getBrief(await deps.service(), target));
        return { ok: true, view };
      } catch (error) {
        if (error instanceof WorkspaceNotFoundError) {
          return { ok: false, code: 'not_found', message: 'That job is no longer in your list.' };
        }
        // Stable, content-free failure: never echo an error that could carry stored text.
        return { ok: false, code: 'failed', message: 'Something went wrong. Nothing was changed.' };
      }
    },
    'application-brief:prepare-assessment': async (input): Promise<PrepareAssessmentResult> => {
      const parsed = PrepareInput.safeParse(input);
      if (!parsed.success) return { ok: false, code: 'not_found', message: 'That request was not understood.' };
      try {
        return await deps.mutate(async () => prepareAssessment(await deps.service(), parsed.data.savedJobId));
      } catch {
        return { ok: false, code: 'not_found', message: 'This job cannot be assessed right now.' };
      }
    },
    'application-brief:commit-assessment': async (input): Promise<CommitAssessmentResult> => {
      const parsed = CommitInput.safeParse(input);
      if (!parsed.success) return { ok: false, code: 'invalid', message: 'The assessment result could not be read, so nothing was saved.' };
      try {
        return await deps.mutate(async () => commitAssessment(await deps.service(), parsed.data));
      } catch {
        return { ok: false, code: 'invalid', message: 'The assessment could not be saved. Nothing was changed.' };
      }
    },
    'application-brief:correct-preference': async (input): Promise<{ ok: boolean; message?: string }> => {
      const parsed = PreferenceInput.safeParse(input);
      if (!parsed.success) return { ok: false, message: 'That preference was not understood.' };
      try {
        const correction = {
          ...(parsed.data.relocationWilling !== undefined ? { relocationWilling: parsed.data.relocationWilling } : {}),
          ...(parsed.data.primaryCountry !== undefined ? { primaryCountry: parsed.data.primaryCountry } : {}),
          ...(parsed.data.professionalLanguage !== undefined ? { professionalLanguage: parsed.data.professionalLanguage } : {}),
        };
        await deps.mutate(async () => correctPreference(await deps.service(), correction));
        return { ok: true };
      } catch {
        return { ok: false, message: 'Your preference could not be saved.' };
      }
    },
  };
}

export const APPLICATION_BRIEF_CHANNELS = [
  'application-brief:get',
  'application-brief:prepare-assessment',
  'application-brief:commit-assessment',
  'application-brief:correct-preference',
] as const;
