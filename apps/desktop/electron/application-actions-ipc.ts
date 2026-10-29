import {
  CreateActionInput,
  GetActionsInput,
  RescheduleActionInput,
  SetSuppressedInput,
  TransitionActionInput,
  UpdateActionInput,
  type ActionsResult,
  type OverviewResult,
} from './application-actions-types.js';
import {
  completeActionRequest,
  createActionRequest,
  dismissActionRequest,
  getActionsView,
  getOverview,
  rescheduleActionRequest,
  setSuppressedRequest,
  updateActionRequest,
  type ActionsDeps,
} from './application-actions-service.js';
import { WorkspaceNotFoundError } from './workspace/repository.js';

/**
 * The `application-actions:*` IPC surface (#692) as plain functions, so `main.ts` only registers them
 * and the tests drive exactly what the renderer reaches. Input is parsed strictly (unknown keys
 * refused) and dates are validated again in the service: the renderer is never trusted to have done it.
 * No channel here reaches a model, the network, a mailbox or a calendar; writes run under the caller's
 * application data reset gate.
 */

type Handler = (input: unknown) => Promise<ActionsResult | OverviewResult>;

const INVALID: ActionsResult = {
  ok: false,
  code: 'invalid_request',
  message: 'That request was not understood.',
  view: null,
  dueIssue: null,
  dueOptions: [],
};
const FAILED: ActionsResult = {
  ok: false,
  code: 'failed',
  message: 'Something went wrong. Nothing was changed.',
  view: null,
  dueIssue: null,
  dueOptions: [],
};
const GONE: ActionsResult = {
  ok: false,
  code: 'not_found',
  message: 'That application is no longer available.',
  view: null,
  dueIssue: null,
  dueOptions: [],
};

function settle(error: unknown): ActionsResult {
  // Content-free on purpose: never echo an error that could carry stored text.
  return error instanceof WorkspaceNotFoundError ? GONE : FAILED;
}

export function createApplicationActionsHandlers(service: () => Promise<ActionsDeps>): Record<string, Handler> {
  return {
    'application-actions:get': async (input) => {
      const parsed = GetActionsInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        const deps = await service();
        return { ok: true, view: getActionsView(deps, parsed.data.applicationId), actionId: null, unchanged: false };
      } catch (error) {
        return settle(error);
      }
    },
    'application-actions:overview': async () => {
      try {
        return getOverview(await service());
      } catch {
        return { ok: false, code: 'failed', message: 'The follow-ups could not be read.' };
      }
    },
    'application-actions:create': async (input) => {
      const parsed = CreateActionInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return await createActionRequest(await service(), parsed.data);
      } catch (error) {
        return settle(error);
      }
    },
    'application-actions:update': async (input) => {
      const parsed = UpdateActionInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return await updateActionRequest(await service(), parsed.data);
      } catch (error) {
        return settle(error);
      }
    },
    'application-actions:reschedule': async (input) => {
      const parsed = RescheduleActionInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return await rescheduleActionRequest(await service(), parsed.data);
      } catch (error) {
        return settle(error);
      }
    },
    'application-actions:complete': async (input) => {
      const parsed = TransitionActionInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return await completeActionRequest(await service(), parsed.data);
      } catch (error) {
        return settle(error);
      }
    },
    'application-actions:dismiss': async (input) => {
      const parsed = TransitionActionInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return await dismissActionRequest(await service(), parsed.data);
      } catch (error) {
        return settle(error);
      }
    },
    'application-actions:set-suppressed': async (input) => {
      const parsed = SetSuppressedInput.safeParse(input);
      if (!parsed.success) return INVALID;
      try {
        return await setSuppressedRequest(await service(), parsed.data);
      } catch (error) {
        return settle(error);
      }
    },
  };
}

export const APPLICATION_ACTIONS_CHANNELS = [
  'application-actions:get',
  'application-actions:overview',
  'application-actions:create',
  'application-actions:update',
  'application-actions:reschedule',
  'application-actions:complete',
  'application-actions:dismiss',
  'application-actions:set-suppressed',
] as const;
