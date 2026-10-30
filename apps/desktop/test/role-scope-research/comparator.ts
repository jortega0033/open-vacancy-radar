import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';

/**
 * #694 research option B: a deterministic, target-role-aware role-family comparator.
 *
 * RESEARCH ONLY. It is not a production scorer, it is not imported by anything that ships, and it never
 * reads or writes a profile, plan, preference, search or score. It exists to answer one question on a fixed
 * synthetic corpus: what would a role-aware family check change compared with today's frontend-shaped
 * evaluator, and where would it still be wrong or unsure?
 *
 * Design rules it follows (and the evaluation tests):
 *   - Pure. No I/O, clock, randomness, network or model. Same input, same output.
 *   - The candidate's target roles decide the target family. A target role it cannot place in a supported
 *     family is listed as unsupported, never silently mapped to the nearest family.
 *   - A profile with no supported target family gets `unsupported_family` for every vacancy: an explicit
 *     refusal, not a low score.
 *   - Too little text is `uncertain` (or a `low`-confidence call from the title alone), never a confident no.
 *   - "Nice to have" lines are ignored as family evidence, and reported as ignored.
 *   - Eligibility (country, language, salary) is NOT its business: those stay with the existing assessor.
 */

export const COMPARATOR_VERSION = 'role-family-comparator/0.1.0-research';
export const EXPLANATION_SCHEMA_VERSION = 'role-family-explanation/0.1.0-research';
export const SUPPORTED_FAMILIES = ['frontend', 'backend'] as const;
export type SupportedFamily = (typeof SUPPORTED_FAMILIES)[number];
export type VacancyFamily = SupportedFamily | 'full_stack' | 'infrastructure' | 'out_of_scope' | 'unknown';
export type Verdict = 'match' | 'adjacent' | 'mismatch' | 'uncertain' | 'unsupported_family';

export interface RoleFamilyExplanation {
  schema: typeof EXPLANATION_SCHEMA_VERSION;
  comparator: typeof COMPARATOR_VERSION;
  verdict: Verdict;
  confidence: 'normal' | 'low' | 'none';
  targetFamilies: SupportedFamily[];
  adjacentFamilies: VacancyFamily[];
  unsupportedTargetRoles: string[];
  titleFamily: VacancyFamily;
  vacancyFamily: VacancyFamily;
  lean: SupportedFamily | null;
  evidence: 'sufficient' | 'sparse';
  signals: Record<'frontend' | 'backend' | 'infrastructure', string[]>;
  ignoredPreferenceSignals: string[];
  reasonCodes: string[];
}

/** Sparse below this many words of posting text. A research constant, not a tuned or validated value. */
export const SPARSE_WORDS = 12;

const TITLE_RULES: readonly { family: VacancyFamily; pattern: RegExp }[] = [
  { family: 'out_of_scope', pattern: /\b(?:designer|account executive|sales|marketing|recruiter|data scientist|machine learning|ml engineer|firmware|embedded|product manager|project manager)\b/u },
  { family: 'full_stack', pattern: /\bfull[ -]?stack\b/u },
  { family: 'frontend', pattern: /\bfront[ -]?end\b|\bfrontend-entwickler\b|\bui (?:engineer|developer)\b|\bclient[ -]side\b|\bdesign systems? engineer\b|\bweb platform\b|\b(?:angular|react|vue(?:\.js)?|svelte) (?:engineer|developer)\b|\bweb (?:engineer|developer)\b/u },
  { family: 'backend', pattern: /\bback[ -]?end\b|\bserver[ -]side\b|\bapi engineer\b|\b(?:go|golang|java|node\.js|python|django|\.net|c#|rust|ruby|php) (?:engineer|developer)\b/u },
  { family: 'infrastructure', pattern: /\bplatform engineer\b|\bdevops\b|\bsite reliability\b|\bsre\b|\binfrastructure\b/u },
];

const SIGNALS: Readonly<Record<'frontend' | 'backend' | 'infrastructure', readonly { label: string; pattern: RegExp; caseSensitive?: boolean }[]>> = {
  frontend: [
    { label: 'React', pattern: /\breact\b/u },
    { label: 'Angular', pattern: /\bangular\b/u },
    { label: 'Vue', pattern: /\bvue(?:\.js)?\b|\bnuxt\b/u },
    { label: 'Svelte', pattern: /\bsvelte\b/u },
    { label: 'CSS', pattern: /\bcss\b/u },
    { label: 'browser', pattern: /\bbrowsers?\b/u },
    { label: 'user interfaces', pattern: /\buser interfaces?\b|\bui components?\b|\bcomponents? for our design system\b/u },
    { label: 'accessibility', pattern: /\baccessib(?:le|ility)\b|\bwcag\b/u },
    { label: 'design system', pattern: /\bdesign system\b|\bcomponent library\b|\bweb components\b/u },
    { label: 'single-page apps', pattern: /\bsingle-page\b|\bclient-side\b/u },
    { label: 'frontend', pattern: /\bfront[ -]?end\b|\bwebapplicaties\b/u },
  ],
  backend: [
    { label: 'APIs', pattern: /\bapis?\b|\brest apis?\b/u },
    { label: 'microservices', pattern: /\bmicroservices?\b|\bbackend services?\b|\bservices that\b/u },
    { label: 'databases', pattern: /\bpostgres(?:ql)?\b|\bmysql\b|\bdatabases?\b|\bdata models?\b/u },
    { label: 'messaging', pattern: /\bkafka\b|\bmessage queues?\b|\bconsumers\b|\bcelery\b/u },
    { label: 'gRPC', pattern: /\bgrpc\b/u },
    { label: 'Go', pattern: /\bGo\b/u, caseSensitive: true },
    { label: 'JVM', pattern: /\bjava\b|\bspring(?: boot)?\b/u },
    { label: 'Node.js', pattern: /\bnode\.js\b/u },
    { label: 'Python/Django', pattern: /\bdjango\b/u },
    { label: 'distributed systems', pattern: /\bdistributed systems\b/u },
  ],
  infrastructure: [
    { label: 'Kubernetes', pattern: /\bkubernetes\b/u },
    { label: 'Terraform', pattern: /\bterraform\b/u },
    { label: 'CI/CD', pattern: /\bci\/cd\b/u },
    { label: 'developer platform', pattern: /\bdeveloper platform\b/u },
  ],
};

const PREFERENCE_HEADING = /^(?:nice to have|preferred|bonus|good to have|desirable)\s*:?$/u;
const OTHER_HEADING = /^(?:responsibilities|requirements|qualifications|what you(?:'|’)ll do|what you bring)\s*:?$/u;
const PREFERENCE_MARKER = /\b(?:nice to have|a plus|preferred|bonus)\b/u;

function titleFamilyOf(title: string): VacancyFamily {
  const lowered = title.toLowerCase();
  if (/\bweb platform\b|\bfront[ -]?end platform\b/u.test(lowered)) return 'frontend';
  for (const rule of TITLE_RULES) if (rule.pattern.test(lowered)) return rule.family;
  return 'unknown';
}

function linesOf(description: string): { text: string; preference: boolean }[] {
  const out: { text: string; preference: boolean }[] = [];
  let inPreference = false;
  for (const raw of description.split(/\r?\n/u)) {
    const text = raw.replace(/^\s*[-*•]\s*/u, '').trim();
    if (!text) continue;
    const lowered = text.toLowerCase();
    if (PREFERENCE_HEADING.test(lowered)) {
      inPreference = true;
      continue;
    }
    if (OTHER_HEADING.test(lowered)) {
      inPreference = false;
      continue;
    }
    out.push({ text, preference: inPreference || PREFERENCE_MARKER.test(lowered) });
  }
  return out;
}

function signalsIn(lines: readonly { text: string; preference: boolean }[], wantPreference: boolean) {
  const found: Record<'frontend' | 'backend' | 'infrastructure', string[]> = { frontend: [], backend: [], infrastructure: [] };
  for (const family of ['frontend', 'backend', 'infrastructure'] as const) {
    for (const signal of SIGNALS[family]) {
      const hit = lines.some(
        (line) => line.preference === wantPreference && signal.pattern.test(signal.caseSensitive ? line.text : line.text.toLowerCase()),
      );
      if (hit) found[family].push(signal.label);
    }
  }
  return found;
}

/** Which supported family each target role names, and which target roles it cannot place. */
export function resolveTargets(profile: Pick<CandidateProfile, 'targetRoles' | 'consideredRoles'>): {
  targetFamilies: SupportedFamily[];
  adjacentFamilies: VacancyFamily[];
  unsupportedTargetRoles: string[];
} {
  const targetFamilies = new Set<SupportedFamily>();
  const unsupportedTargetRoles: string[] = [];
  for (const role of profile.targetRoles) {
    const family = titleFamilyOf(role);
    if (family === 'frontend' || family === 'backend') targetFamilies.add(family);
    else if (role.trim()) unsupportedTargetRoles.push(role.trim());
  }
  const adjacent = new Set<VacancyFamily>();
  for (const role of profile.consideredRoles) {
    const family = titleFamilyOf(role);
    if (family !== 'unknown' && family !== 'out_of_scope') adjacent.add(family);
  }
  return {
    targetFamilies: SUPPORTED_FAMILIES.filter((family) => targetFamilies.has(family)),
    adjacentFamilies: [...adjacent].sort(),
    unsupportedTargetRoles,
  };
}

export function compareRoleFamily(
  vacancy: { readonly title: string; readonly description: string | null },
  profile: Pick<CandidateProfile, 'targetRoles' | 'consideredRoles'>,
): RoleFamilyExplanation {
  const targets = resolveTargets(profile);
  const description = vacancy.description ?? '';
  const words = description.split(/\s+/u).filter(Boolean).length;
  const evidence: 'sufficient' | 'sparse' = words < SPARSE_WORDS ? 'sparse' : 'sufficient';
  const lines = linesOf(description);
  const signals = signalsIn(lines, false);
  const ignored = signalsIn(lines, true);
  const ignoredPreferenceSignals = [...ignored.frontend, ...ignored.backend, ...ignored.infrastructure];
  const titleFamily = titleFamilyOf(vacancy.title);
  const fe = signals.frontend.length;
  const be = signals.backend.length;
  const reasonCodes: string[] = [`title_family:${titleFamily}`];

  let vacancyFamily: VacancyFamily;
  let lean: SupportedFamily | null = null;
  if (titleFamily === 'out_of_scope' || titleFamily === 'infrastructure') {
    vacancyFamily = titleFamily;
  } else if (evidence === 'sparse') {
    vacancyFamily = titleFamily;
    reasonCodes.push('sparse_description');
  } else if (fe >= 2 && be >= 2) {
    lean = fe > be ? 'frontend' : be > fe ? 'backend' : null;
    vacancyFamily = 'full_stack';
    reasonCodes.push('responsibilities_mixed');
  } else if (fe >= 2) {
    vacancyFamily = 'frontend';
    reasonCodes.push('responsibilities_frontend');
  } else if (be >= 2) {
    vacancyFamily = 'backend';
    reasonCodes.push(titleFamily === 'full_stack' ? 'responsibilities_backend_overrule_title' : 'responsibilities_backend');
  } else {
    // Too few distinct family signals in the text: fall back to the title's family (low confidence), or abstain.
    vacancyFamily = titleFamily;
    reasonCodes.push('family_evidence_thin');
  }
  if (ignoredPreferenceSignals.length > 0) reasonCodes.push('preference_lines_ignored');

  let verdict: Verdict;
  const thin = reasonCodes.includes('family_evidence_thin') || evidence === 'sparse';
  let confidence: RoleFamilyExplanation['confidence'] = thin ? 'low' : 'normal';
  if (targets.targetFamilies.length === 0) {
    verdict = 'unsupported_family';
    confidence = 'none';
    reasonCodes.push('no_supported_target_family');
  } else if (vacancyFamily === 'unknown') {
    verdict = 'uncertain';
    confidence = 'none';
  } else if ((targets.targetFamilies as readonly VacancyFamily[]).includes(vacancyFamily)) {
    verdict = 'match';
  } else if (vacancyFamily === 'full_stack') {
    verdict = 'adjacent';
  } else if (vacancyFamily === 'infrastructure' || vacancyFamily === 'out_of_scope') {
    verdict = 'mismatch';
    reasonCodes.push('family_not_supported');
  } else {
    verdict = 'mismatch';
  }
  for (const role of targets.unsupportedTargetRoles) reasonCodes.push(`target_role_unsupported:${role}`);

  return {
    schema: EXPLANATION_SCHEMA_VERSION,
    comparator: COMPARATOR_VERSION,
    verdict,
    confidence,
    ...targets,
    titleFamily,
    vacancyFamily,
    lean,
    evidence,
    signals,
    ignoredPreferenceSignals,
    reasonCodes,
  };
}

/** Research ordering for option B: lower is earlier. Uncertain sits above mismatch so abstention is not buried. */
export function verdictTier(explanation: Pick<RoleFamilyExplanation, 'verdict' | 'confidence'>): number {
  switch (explanation.verdict) {
    case 'match':
      return explanation.confidence === 'low' ? 1 : 0;
    case 'adjacent':
      return 2;
    case 'uncertain':
      return 3;
    case 'mismatch':
      return 4;
    case 'unsupported_family':
      return 5;
  }
}
