import { basename } from 'node:path';
import {
  addSearchPlanSuggestions,
  approveSearchPlanDraft,
  backupUnreadableSearchPlan,
  captureSearchPlanSnapshot,
  dismissSearchPlanSuggestion,
  EMPTY_SEARCH_PLAN,
  isSearchPlanReadError,
  isSearchPlanUsable,
  loadSearchPlan,
  parseSearchPlanDraft,
  writeSearchPlan,
  type SearchPlan,
  type SearchPlanReadFailure,
  type SearchPlanSnapshot,
} from '@open-vacancy-radar/vacancy-engine';

/**
 * What the page is told about the saved plan (#686): the plan, or -- when the file cannot be used -- why,
 * so it can say so and offer the one repair that keeps the person's data: back up, then start again.
 */
export type SearchPlanLoadResult =
  | { status: 'ok'; plan: SearchPlan }
  | { status: 'unreadable'; reason: SearchPlanReadFailure; message: string; fileName: string };

export interface SearchPlanResetResult {
  plan: SearchPlan;
  /** The file name the unreadable plan's exact bytes were kept under, next to the plan file. */
  backupFileName: string;
}

/**
 * The saved search plan (#686), kept free of Electron so tests can drive the same approve -> persist ->
 * snapshot sequence the app does.
 *
 * Every change is a read-modify-write on one file, so changes are applied one at a time; two quick edits
 * can then never overwrite each other. Only `save` can change the approved titles. Suggestions are stored
 * apart and cannot reach a search until the person approves them with `save`.
 *
 * A file that cannot be used (damaged, written by a newer version, or unopenable) is NEVER replaced by an
 * ordinary save or suggestion: those reject with the reason. Only `resetUnreadable({ confirm: true })`
 * replaces it, and only after its exact bytes are kept as a timestamped backup next to it.
 */
export interface SearchPlanStore {
  /** The plan, or why the saved file cannot be used. Never throws for a damaged or newer-version file. */
  load(): Promise<SearchPlanLoadResult>;
  /** The plan; rejects with a readable `SearchPlanReadError` when the file cannot be used. */
  get(): Promise<SearchPlan>;
  /** Approves the plan exactly as the person wrote it. */
  save(rawDraft: unknown): Promise<SearchPlan>;
  addSuggestions(rawTitles: unknown): Promise<SearchPlan>;
  dismissSuggestion(id: unknown): Promise<SearchPlan>;
  /** Backs up an unusable plan file and starts an empty plan. Requires an explicit `{ confirm: true }`. */
  resetUnreadable(confirmation: unknown): Promise<SearchPlanResetResult>;
  /** A frozen copy for one run, or null when there is no approved title. An unusable file rejects. */
  snapshot(): Promise<SearchPlanSnapshot | null>;
}

export function createSearchPlanStore(options: {
  filePath(): Promise<string>;
  /** Wraps each change, for the caller's own data-reset gate. */
  mutate?<T>(change: () => Promise<T>): Promise<T>;
  now?(): Date;
}): SearchPlanStore {
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const gate = options.mutate ?? (<T>(change: () => Promise<T>) => change());
  const now = options.now ?? (() => new Date());

  const update = (change: (current: SearchPlan) => SearchPlan): Promise<SearchPlan> =>
    gate(() =>
      serialized(async () => {
        const path = await options.filePath();
        // An unusable file rejects here with its reason and is left exactly as it is.
        const current = await loadSearchPlan(path);
        const next = change(current);
        await writeSearchPlan(path, next);
        return next;
      }),
    );

  const load = async (): Promise<SearchPlanLoadResult> => {
    const path = await options.filePath();
    try {
      return { status: 'ok', plan: await loadSearchPlan(path) };
    } catch (error) {
      if (!isSearchPlanReadError(error)) throw error;
      return { status: 'unreadable', reason: error.reason, message: error.message, fileName: basename(path) };
    }
  };

  return {
    load,
    get: async () => loadSearchPlan(await options.filePath()),
    save: (rawDraft) => {
      let draft;
      try {
        draft = parseSearchPlanDraft(rawDraft);
      } catch (error) {
        return Promise.reject(error);
      }
      return update((current) => approveSearchPlanDraft(current, draft, now()));
    },
    addSuggestions: (rawTitles) => {
      if (!Array.isArray(rawTitles) || rawTitles.length > 50) {
        return Promise.reject(new Error('Suggestions must be a short list.'));
      }
      return update((current) => addSearchPlanSuggestions(current, 'toolkit', rawTitles, now()));
    },
    dismissSuggestion: (id) => {
      if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
        return Promise.reject(new Error('Unknown suggestion.'));
      }
      return update((current) => dismissSearchPlanSuggestion(current, id));
    },
    resetUnreadable: (confirmation) => {
      if (
        confirmation === null ||
        typeof confirmation !== 'object' ||
        (confirmation as { confirm?: unknown }).confirm !== true
      ) {
        return Promise.reject(new Error('Starting a new search plan needs your confirmation.'));
      }
      return gate(() =>
        serialized(async () => {
          const path = await options.filePath();
          try {
            await loadSearchPlan(path);
            throw new Error('Your search plan can be read, so there is nothing to reset.');
          } catch (error) {
            if (!isSearchPlanReadError(error)) throw error;
          }
          // The exact bytes are kept first; the new plan is written only once the backup exists.
          const backup = await backupUnreadableSearchPlan(path, now());
          await writeSearchPlan(path, EMPTY_SEARCH_PLAN);
          return { plan: EMPTY_SEARCH_PLAN, backupFileName: basename(backup) };
        }),
      );
    },
    snapshot: async () => {
      const plan = await loadSearchPlan(await options.filePath());
      return isSearchPlanUsable(plan) ? captureSearchPlanSnapshot(plan) : null;
    },
  };
}
