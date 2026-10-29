import {
  addSearchPlanSuggestions,
  approveSearchPlanDraft,
  captureSearchPlanSnapshot,
  dismissSearchPlanSuggestion,
  EMPTY_SEARCH_PLAN,
  isSearchPlanUsable,
  loadSearchPlan,
  searchPlanDraftSchema,
  writeSearchPlan,
  type SearchPlan,
  type SearchPlanSnapshot,
} from '@open-vacancy-radar/vacancy-engine';

/**
 * The saved search plan (#686), kept free of Electron so tests can drive the same approve -> persist ->
 * snapshot sequence the app does.
 *
 * Every change is a read-modify-write on one file, so changes are applied one at a time; two quick edits
 * can then never overwrite each other. Only `save` can change the approved titles (and, because the
 * person is re-approving everything, it is also what replaces an unreadable plan file). Suggestions are stored
 * apart and cannot reach a search until the person approves them with `save`.
 */
export interface SearchPlanStore {
  get(): Promise<SearchPlan>;
  /** Approves the plan exactly as the person wrote it. */
  save(rawDraft: unknown): Promise<SearchPlan>;
  addSuggestions(rawTitles: unknown): Promise<SearchPlan>;
  dismissSuggestion(id: unknown): Promise<SearchPlan>;
  /** A frozen copy for one run, or null when there is no approved title. A damaged file rejects. */
  snapshot(): Promise<SearchPlanSnapshot | null>;
}

export function createSearchPlanStore(options: {
  filePath(): Promise<string>;
  /** Wraps each change, for the caller's own data-reset gate. */
  mutate?<T>(change: () => Promise<T>): Promise<T>;
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

  const update = (
    change: (current: SearchPlan) => SearchPlan,
    { replaceUnreadable = false }: { replaceUnreadable?: boolean } = {},
  ): Promise<SearchPlan> =>
    gate(() =>
      serialized(async () => {
        const path = await options.filePath();
        let current: SearchPlan;
        try {
          current = await loadSearchPlan(path);
        } catch (error) {
          // A damaged file blocks searches with the plan, so approving a new plan is the way to repair
          // it. Suggestions are not: they must not quietly replace a file the person may still want.
          if (!replaceUnreadable) throw error;
          current = EMPTY_SEARCH_PLAN;
        }
        const next = change(current);
        await writeSearchPlan(path, next);
        return next;
      }),
    );

  return {
    get: async () => loadSearchPlan(await options.filePath()),
    save: (rawDraft) => {
      const draft = searchPlanDraftSchema.parse(rawDraft);
      return update((current) => approveSearchPlanDraft(current, draft), { replaceUnreadable: true });
    },
    addSuggestions: (rawTitles) => {
      if (!Array.isArray(rawTitles) || rawTitles.length > 50) {
        return Promise.reject(new Error('Suggestions must be a short list.'));
      }
      return update((current) => addSearchPlanSuggestions(current, 'toolkit', rawTitles));
    },
    dismissSuggestion: (id) => {
      if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
        return Promise.reject(new Error('Unknown suggestion.'));
      }
      return update((current) => dismissSearchPlanSuggestion(current, id));
    },
    snapshot: async () => {
      const plan = await loadSearchPlan(await options.filePath());
      return isSearchPlanUsable(plan) ? captureSearchPlanSnapshot(plan) : null;
    },
  };
}
