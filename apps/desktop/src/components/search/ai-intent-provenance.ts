/**
 * The run-intent versions whose `aiSearchIntent` layout this build can describe. Version 2 (#686) added
 * the search plan to the run intent; the AI provenance layout itself is the same as version 1, so
 * reports from either version are described the same way.
 */
const SUPPORTED_INTENT_VERSIONS: readonly number[] = [1, 2];
const SUPPORTED_RANGE = 'v1-v2';

const CRITERIA = ['role', 'country', 'employment', 'salary'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One diagnostics line for "Copy diagnostics" (#684): which submitted criteria the AI web search
 * step was given, and how. Holds search terms and counts only, never CV text, skill names or the
 * prompt, because the provenance it reads holds none.
 *
 * Reads a saved report, which may come from another build or have been edited by hand, so it takes
 * `unknown`, describes only the layout it understands, and otherwise says so instead of throwing:
 * a bad value here must never stop the rest of the diagnostics from being copied. `redact` is applied
 * to the typed search terms only, so the run id stays readable for matching against the log.
 */
export function describeAiIntentProvenance(
  provenance: unknown,
  redact: (text: string) => string = (text) => text,
): string {
  if (!isRecord(provenance)) return 'AI search intent not shown (unrecognised format)';
  const { intentVersion } = provenance;
  if (typeof intentVersion !== 'number' || !SUPPORTED_INTENT_VERSIONS.includes(intentVersion)) {
    return typeof intentVersion === 'number'
      ? `AI search intent v${intentVersion} not shown (this version of the app reads ${SUPPORTED_RANGE})`
      : 'AI search intent not shown (unrecognised format)';
  }
  const { criteria, candidateContext, scanId, mode } = provenance;
  if (!isRecord(criteria) || !isRecord(candidateContext) || typeof scanId !== 'string') {
    return `AI search intent v${intentVersion} not shown (incomplete record)`;
  }
  const parts: string[] = [];
  for (const name of CRITERIA) {
    const entry = criteria[name];
    if (!isRecord(entry)) return `AI search intent v${intentVersion} not shown (incomplete record)`;
    if (entry.requested !== true) continue;
    if (typeof entry.value !== 'string') {
      return `AI search intent v${intentVersion} not shown (incomplete record)`;
    }
    const route = entry.pushdown === 'prompt_guidance' ? 'sent to AI as guidance' : 'not searchable, applied locally';
    parts.push(`${name} "${redact(entry.value)}" (${route})`);
  }
  const criteriaText = mode === 'browse_all' ? 'browse all, no criteria' : parts.join(', ') || 'no criteria';
  const skills = typeof candidateContext.skillCount === 'number' ? candidateContext.skillCount : 0;
  return `AI search intent v${intentVersion}, run ${scanId}: ${criteriaText}; ${skills} saved skill(s) as background, saved target roles not searched`;
}
