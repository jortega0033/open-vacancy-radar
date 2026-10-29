import { useCallback, useEffect, useId, useState } from 'react';
import type { SearchPlan, SearchPlanDraft, SearchPlanVariantOrigin } from '@open-vacancy-radar/vacancy-engine';
import { describeError } from '../cv/useAgentRun.js';
import { ErrorBanner } from '../shell/index.js';

/** How the person is told where an approved title came from. Never guessed: no record, no label. */
export function originLabel(origin: SearchPlanVariantOrigin): string {
  if (origin === 'toolkit') return 'From the CV tools, approved by you';
  if (origin === 'ai') return 'AI suggestion, approved by you';
  return 'Added by you';
}

interface DraftVariant {
  key: number;
  title: string;
  language: string;
  origin: SearchPlanVariantOrigin;
}

interface Draft {
  primaryFunction: string;
  variants: DraftVariant[];
  markets: string;
}

let nextKey = 1;

function draftOf(plan: SearchPlan): Draft {
  return {
    primaryFunction: plan.primaryFunction,
    variants: plan.variants.map((variant) => ({
      key: nextKey++,
      title: variant.title,
      language: variant.language,
      origin: variant.origin,
    })),
    markets: plan.markets.join(', '),
  };
}

function toSaveInput(draft: Draft): SearchPlanDraft {
  return {
    primaryFunction: draft.primaryFunction,
    variants: draft.variants.map(({ title, language, origin }) => ({ title, language, origin })),
    markets: draft.markets.split(',').map((market) => market.trim()).filter(Boolean),
  };
}

/**
 * The editable, user-approved search plan (#686), shown inside "What you are looking for".
 *
 * It holds desired work only: a primary function, an ordered list of equivalent titles with the working
 * language each is written in, and the markets they care about. It never reads or writes the candidate
 * facts above it. Titles suggested by the Resume Toolkit or an AI answer wait in their own list and join
 * the plan only when the person adds them; saving is the single act of approval, and a saved change
 * applies to the next search, never one already running.
 */
export function SearchPlanEditor() {
  const headingId = useId();
  const [plan, setPlan] = useState<SearchPlan | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    if (!('vacancyRadar' in window) || typeof window.vacancyRadar.getSearchPlan !== 'function') {
      setFailed(true);
      return;
    }
    void window.vacancyRadar
      .getSearchPlan()
      .then((loaded) => {
        if (!cancelled) setPlan(loaded);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const approve = useCallback(async (input: SearchPlanDraft) => {
    setSaving(true);
    setError(undefined);
    try {
      const saved = await window.vacancyRadar.saveSearchPlan(input);
      setPlan(saved);
      setDraft(null);
    } catch (caught) {
      setError(describeError(caught, 'could not save the search plan'));
    } finally {
      setSaving(false);
    }
  }, []);

  const runSuggestionAction = useCallback(async (action: () => Promise<SearchPlan>) => {
    setError(undefined);
    try {
      setPlan(await action());
    } catch (caught) {
      setError(describeError(caught, 'could not update the suggestions'));
    }
  }, []);

  if (failed) {
    return <p className="mt-3 text-sm text-base-content/60">The search plan could not be loaded.</p>;
  }
  if (!plan) return null;

  const addSuggestion = (id: string) => {
    const suggestion = plan.suggestions.find((entry) => entry.id === id);
    if (!suggestion) return;
    void approve({
      primaryFunction: plan.primaryFunction,
      variants: [
        ...plan.variants.map(({ title, language, origin }) => ({ title, language, origin })),
        { title: suggestion.title, language: suggestion.language, origin: suggestion.origin },
      ],
      markets: plan.markets,
    });
  };

  const update = (change: (current: Draft) => Draft) => setDraft((current) => (current ? change(current) : current));

  return (
    <div className="mt-4 border-t border-base-300 pt-3" data-testid="search-plan">
      <div className="flex items-center justify-between gap-3">
        <h3 id={headingId} className="text-sm font-semibold">
          Search plan
        </h3>
        {!draft && (
          <button
            type="button"
            className="btn btn-outline btn-sm"
            aria-label={plan.variants.length > 0 ? 'Change search plan titles' : 'Add search plan titles'}
            onClick={() => setDraft(draftOf(plan))}
          >
            {plan.variants.length > 0 ? 'Change titles' : 'Add titles'}
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-base-content/60">
        Titles you approve here are searched as well as what you type, and any one of them is a good match.
        A change applies to your next search only. Nothing is added without your approval.
      </p>

      {error && <ErrorBanner className="mt-2">{error}</ErrorBanner>}

      {!draft ? (
        <div className="mt-2 text-sm" aria-labelledby={headingId}>
          {plan.variants.length === 0 ? (
            <p className="text-base-content/60">No titles approved yet. Searches use only what you type.</p>
          ) : (
            <>
              {plan.primaryFunction && (
                <p>
                  <span className="text-base-content/60">Function </span>
                  {plan.primaryFunction}
                </p>
              )}
              <ol className="mt-1 list-decimal pl-5" aria-label="Approved titles, in order">
                {plan.variants.map((variant) => (
                  <li key={variant.id}>
                    {variant.title}
                    {variant.language && <span className="ml-2 badge badge-outline badge-sm">{variant.language}</span>}
                    <span className="ml-2 text-xs text-base-content/60">{originLabel(variant.origin)}</span>
                  </li>
                ))}
              </ol>
              {plan.markets.length > 0 && (
                <p className="mt-1">
                  <span className="text-base-content/60">Markets </span>
                  {plan.markets.join(', ')}
                </p>
              )}
            </>
          )}
        </div>
      ) : (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void approve(toSaveInput(draft));
          }}
        >
          <label className="form-control">
            <span className="label-text text-xs">Primary function</span>
            <input
              className="input input-bordered input-sm"
              aria-label="Primary function"
              value={draft.primaryFunction}
              placeholder="e.g. Frontend engineering"
              onChange={(event) => update((current) => ({ ...current, primaryFunction: event.target.value }))}
            />
          </label>
          <ul className="flex flex-col gap-2" aria-label="Titles">
            {draft.variants.map((variant, index) => (
              <li key={variant.key} className="flex flex-wrap items-center gap-2">
                <input
                  className="input input-bordered input-sm min-w-0 flex-1"
                  aria-label={`Title ${index + 1}`}
                  value={variant.title}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      variants: current.variants.map((entry) =>
                        entry.key === variant.key ? { ...entry, title: event.target.value } : entry,
                      ),
                    }))
                  }
                />
                <input
                  className="input input-bordered input-sm w-32"
                  aria-label={`Working language for title ${index + 1}`}
                  placeholder="Language"
                  value={variant.language}
                  onChange={(event) =>
                    update((current) => ({
                      ...current,
                      variants: current.variants.map((entry) =>
                        entry.key === variant.key ? { ...entry, language: event.target.value } : entry,
                      ),
                    }))
                  }
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  aria-label={`Move title ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() =>
                    update((current) => {
                      const variants = [...current.variants];
                      [variants[index - 1], variants[index]] = [variants[index]!, variants[index - 1]!];
                      return { ...current, variants };
                    })
                  }
                >
                  Up
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  aria-label={`Remove title ${index + 1}`}
                  onClick={() =>
                    update((current) => ({ ...current, variants: current.variants.filter((entry) => entry.key !== variant.key) }))
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-ghost btn-sm self-start"
            onClick={() =>
              update((current) => ({
                ...current,
                variants: [...current.variants, { key: nextKey++, title: '', language: '', origin: 'user' }],
              }))
            }
          >
            Add a title
          </button>
          <label className="form-control">
            <span className="label-text text-xs">Markets (countries, separated by commas)</span>
            <input
              className="input input-bordered input-sm"
              aria-label="Markets (countries, separated by commas)"
              value={draft.markets}
              onChange={(event) => update((current) => ({ ...current, markets: event.target.value }))}
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
              Approve search plan
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {plan.suggestions.length > 0 && (
        <div className="mt-3">
          <h4 className="text-xs font-semibold">Suggested titles to review</h4>
          <p className="text-xs text-base-content/60">These are not part of your searches until you add them.</p>
          <ul className="mt-1 flex flex-col gap-1 text-sm" aria-label="Suggested titles">
            {plan.suggestions.map((suggestion) => (
              <li key={suggestion.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {suggestion.title}
                  {suggestion.language && <span className="ml-2 badge badge-outline badge-sm">{suggestion.language}</span>}
                </span>
                <button
                  type="button"
                  className="btn btn-outline btn-xs"
                  aria-label={`Add suggested title ${suggestion.title}`}
                  disabled={saving || draft !== null}
                  onClick={() => addSuggestion(suggestion.id)}
                >
                  Add
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  aria-label={`Dismiss suggested title ${suggestion.title}`}
                  onClick={() => void runSuggestionAction(() => window.vacancyRadar.dismissSearchPlanSuggestion(suggestion.id))}
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
