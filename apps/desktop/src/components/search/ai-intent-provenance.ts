import type { AiSearchIntentProvenance } from '@open-vacancy-radar/vacancy-engine';

/**
 * One diagnostics line for "Copy diagnostics" (#684): which submitted criteria the AI web search
 * step was given, and how. Holds search terms and counts only, never CV text, skill names or the
 * prompt, because the provenance it reads holds none.
 */
export function describeAiIntentProvenance(provenance: AiSearchIntentProvenance): string {
  const parts = (['role', 'country', 'employment', 'salary'] as const).flatMap((name) => {
    const entry = provenance.criteria[name];
    if (!entry.requested) return [];
    const route = entry.pushdown === 'prompt_guidance' ? 'sent to AI as guidance' : 'not searchable, applied locally';
    return [`${name} "${entry.value}" (${route})`];
  });
  const criteria = provenance.mode === 'browse_all' ? 'browse all, no criteria' : parts.join(', ') || 'no criteria';
  const context = provenance.candidateContext;
  return `AI search intent v${provenance.intentVersion}, run ${provenance.scanId}: ${criteria}; ${context.skillCount} saved skill(s) as background, saved target roles not searched`;
}
