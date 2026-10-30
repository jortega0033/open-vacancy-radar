import { resolveDue } from '../electron/application-actions-core.js';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import { createAction, transitionAction } from '../electron/workspace/application-action-store.js';
import { insertDraft } from '../electron/workspace/follow-up-draft-store.js';
import * as workspace from '../electron/workspace/repository.js';

/**
 * Synthetic applications with follow-ups (#692), written into a user-data directory before the app is
 * launched on it. Like `seed-tailoring-case.ts` it goes through the real repository and store functions the
 * main process uses, so the rows are the ones the app would have written. The one step that needs a model (a
 * draft's text) cannot run here and is never pressed: the draft row is inserted with the store's own function,
 * exactly what a successful generation stores. Nothing is faked after launch, and no seeding hook exists in
 * the app, so there is nothing to strip from a packaged build.
 */
export const OVERDUE_ROW = {
  role: 'Senior Frontend Engineer for International Design Systems',
  company: 'Northstar Product Engineering and Platform Operations',
} as const;
export const QUIET_ROW = {
  role: 'Platform Engineer',
  company: 'Fabrikam',
} as const;
export const SEEDED_NEXT_STEP = 'Review the prepared application documents';
export const SEEDED_ACTION_TITLE = 'Ask the hiring team about the interview timeline and next steps';

export function seedFollowUpsCase(userDataDir: string): { overdueId: string; quietId: string } {
  const seeded = createWorkspaceDb(userDataDir);
  try {
    const { db } = seeded;
    const now = new Date();
    const overdueId = workspace.createApplication(db, {
      ...OVERDUE_ROW,
      location: 'Amsterdam, Netherlands',
      status: 'applied',
      appliedAt: '2024-01-02T09:00:00.000Z',
      nextStep: SEEDED_NEXT_STEP,
      contact: 'Recruiting team',
    }).id;
    const quietId = workspace.createApplication(db, {
      ...QUIET_ROW,
      status: 'applied',
      appliedAt: '2024-01-03T09:00:00.000Z',
      nextStep: '',
    }).id;

    const dueOn = (date: string, zone = 'Europe/Amsterdam') => {
      const resolved = resolveDue({ kind: 'date', date, timeZone: zone });
      if (!resolved.ok) throw new Error(`seed date refused: ${resolved.code}`);
      return resolved.due;
    };
    const fields = {
      kind: 'follow_up' as const,
      title: SEEDED_ACTION_TITLE,
      note: 'Mention the portfolio review and ask who the right contact for scheduling is.',
      channel: 'email' as const,
      contactDetail: 'recruiting-team-with-a-long-name@example.invalid',
    };
    const open = createAction(
      db,
      { applicationId: overdueId, requestId: 'seed-open', fields, due: dueOn('2024-01-10'), origin: 'user', basisClass: 'user_stated' },
      now,
    );
    if (!open.ok) throw new Error('seed action failed');
    const done = createAction(
      db,
      { applicationId: overdueId, requestId: 'seed-done', fields: { ...fields, kind: 'thank_you', title: 'Thank the panel' }, due: dueOn('2024-01-05'), origin: 'user', basisClass: 'user_stated' },
      now,
    );
    if (!done.ok) throw new Error('seed history action failed');
    const moved = transitionAction(db, { applicationId: overdueId, actionId: done.action.id, expectedVersion: done.action.version, to: 'completed' }, now);
    if (!moved.ok) throw new Error('seed history transition failed');

    const draft = insertDraft(
      db,
      {
        applicationId: overdueId,
        actionId: open.action.id,
        requestId: 'seed-draft',
        kind: 'follow_up',
        basis: {
          mode: 'current_context',
          label: 'No recorded submission package, so this draft uses your current linked documents, which may differ from what you sent.',
          submissionClass: 'user_stated',
          packageId: null,
          packageVersion: null,
          manifestHash: null,
          documents: [],
          factsHash: 'f'.repeat(64),
        },
        subject: 'Checking in on my application for the Senior Frontend Engineer role',
        body: 'Hello [Recipient],\n\nI wanted to check in on my application. I applied on 2024-01-02 and would be glad to hear about the interview timeline.\n\nThank you for your time.\n\n[Your name]',
        provider: 'claude',
        usage: null,
      },
      now,
    );
    if (!draft.ok) throw new Error('seed draft failed');
    return { overdueId, quietId };
  } finally {
    seeded.close();
  }
}
