import type { FollowUpDeps, GenerateResult } from '../electron/application-follow-up-service.js';
import type { WorkspaceDb } from '../electron/workspace/client.js';
import type { ApplicationDataResetGate } from '../electron/application-data-reset-gate.js';

/**
 * A stand-in for the one place a follow-up draft can reach a model. It records every prompt it is given
 * and answers with whatever the test supplies, so a test can assert "no model call" (`calls.length === 0`)
 * and can hold or reject a reply to exercise cancel, reset and stale-result handling. No real model,
 * provider or network is ever involved.
 */
export interface ModelStub {
  calls: Array<{ prompt: string; signal: AbortSignal }>;
  /** Called for every request; defaults to a failure so an unexpected call is loud. */
  reply: (prompt: string, signal: AbortSignal) => Promise<GenerateResult> | GenerateResult;
}

export function modelStub(): ModelStub {
  return {
    calls: [],
    reply: () => ({ ok: false, text: '', error: 'the test did not expect a model call' }),
  };
}

export function actionsDeps(options: {
  db: WorkspaceDb;
  gate: ApplicationDataResetGate;
  now?: () => Date;
  model?: ModelStub;
}): FollowUpDeps {
  const model = options.model ?? modelStub();
  return {
    db: options.db,
    now: options.now ?? (() => new Date()),
    mutate: (task) => options.gate.runMutation(task),
    async generate(prompt, signal) {
      model.calls.push({ prompt, signal });
      return model.reply(prompt, signal);
    },
    provider: 'claude',
  };
}