import {
  deterministicScoreSchema,
  type DeterministicScore,
  type NormalizedVacancy,
} from '../domain/models.js';
import type { CandidateProfile } from '../candidate/profile.js';
import { assessNetherlandsSalary } from './compensation.js';

export const DETERMINISTIC_SCORING_VERSION = 'deterministic-relevance-v11';
export const RELEVANCE_THRESHOLD = 70;

type SegmentContext = 'responsibility' | 'requirement' | 'preference' | 'general' | 'team';

type TextSegment = {
  original: string;
  normalized: string;
  context: SegmentContext;
};

type ConceptKind = 'core' | 'domain';

type ConceptDefinition = {
  label: string;
  kind: ConceptKind;
  pattern: RegExp;
};

type ConceptEvidence = {
  label: string;
  kind: ConceptKind;
  strength: number;
};

type PrimaryRoleFamily =
  | 'frontend'
  | 'full-stack-typescript'
  | 'generic-frontend'
  | 'generic-software'
  | 'backend'
  | 'management'
  | 'quality-assurance'
  | 'data'
  | 'embedded'
  | 'devops'
  | 'design'
  | 'support'
  | 'security'
  | 'erp'
  | 'operations'
  | 'commercial'
  | 'other';

export type DutchRequirementAssessment = {
  dutchRequired: boolean;
  dutchPreferred: boolean;
  evidence: string[];
};

type RoleAssessment = {
  family: PrimaryRoleFamily;
  score: number;
  primaryFit: string;
  reason: string;
};

type DimensionAssessment = {
  score: number;
  reason: string;
};

const CONCEPTS: readonly ConceptDefinition[] = [
  { label: 'Angular', kind: 'core', pattern: /\bangular(?:\s+\d+)?\b/i },
  { label: 'React', kind: 'core', pattern: /\breact(?:\.js|js|\s+native)?\b/i },
  { label: 'TypeScript', kind: 'core', pattern: /\btypescript\b/i },
  { label: 'JavaScript', kind: 'core', pattern: /\bjavascript\b/i },
  { label: 'RxJS', kind: 'core', pattern: /\brxjs\b/i },
  { label: 'NgRx', kind: 'core', pattern: /\bngrx\b/i },
  { label: 'Web Components', kind: 'core', pattern: /\bweb\s+components?\b/i },
  { label: 'Stencil', kind: 'core', pattern: /\bstencil(?:\.js|js)?\b/i },
  { label: 'Electron', kind: 'core', pattern: /\belectron(?:\.js|js)?\b/i },
  { label: 'Capacitor', kind: 'core', pattern: /\bcapacitor(?:\.js|js)?\b/i },
  { label: 'frontend', kind: 'domain', pattern: /\bfront[ -]?end\b/i },
  { label: 'UI engineering', kind: 'domain', pattern: /\bui\b|\buser\s+interfaces?\b/i },
  { label: 'web applications', kind: 'domain', pattern: /\bweb\s+(?:applications?|apps?|products?)\b/i },
  { label: 'browser applications', kind: 'domain', pattern: /\bbrowser(?:-based)?\s+(?:applications?|apps?|products?)\b/i },
  { label: 'design systems', kind: 'domain', pattern: /\bdesign\s+systems?\b/i },
  { label: 'accessibility', kind: 'domain', pattern: /\baccessibility\b|\bwcag\b|\ba11y\b/i },
  { label: 'frontend architecture', kind: 'domain', pattern: /\bfront[ -]?end\s+architecture\b/i },
  { label: 'product engineering', kind: 'domain', pattern: /\bproduct\s+engineer(?:ing)?\b/i },
];

const SECTION_HEADINGS: readonly {
  pattern: RegExp;
  context: Exclude<SegmentContext, 'general' | 'team'>;
}[] = [
  {
    pattern: /^(?:responsibilities|what you(?:'|’)ll (?:do|be doing)|what you will (?:do|be doing)|your role|the role|day to day|the job)\s*:?$/i,
    context: 'responsibility',
  },
  {
    pattern: /^(?:requirements|what you(?:'|’)ll need|what you will need|what you bring|must have|your skills|qualifications|experience)\s*:?$/i,
    context: 'requirement',
  },
  {
    pattern: /^(?:nice to have|preferred|bonus|good to have|desirable)\s*:?$/i,
    context: 'preference',
  },
];

const CONTEXT_WEIGHT: Readonly<Record<SegmentContext, number>> = {
  responsibility: 1,
  requirement: 0.95,
  preference: 0.35,
  general: 0.6,
  team: 0.2,
};

const DUTCH_TERM = '(?:dutch|nederlands(?:e|talig)?|nederlandse\\s+taal)';
const PREFERRED_LANGUAGE_QUALIFIER =
  '(?:preferred|preferable|preference|a\\s+plus|pluspunt|nice\\s+to\\s+have|optional|bonus|(?:a\\s+)?strong\\s+advantage|advantage|desirable|not\\s+required|not\\s+mandatory|niet\\s+vereist|geen\\s+vereiste|mooi\\s+meegenomen|een\\s+pre|een\\s+plus)';

const DUTCH_REQUIRED_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `${DUTCH_TERM}(?:\\s+(?:language|proficiency|speaking|skills?))?(?:\\s+(?:is|are|at|of))?[^.!?]{0,25}(?:required|mandatory|must|essential|needed|prerequisite|fluent|fluency|professional|native|c1|c2|b1|b2|vereist|verplicht|vloeiend|moedertaal)`,
    'i',
  ),
  new RegExp(
    `(?:fluent|fluency|professional(?:\\s+working)?(?:\\s+proficiency)?|c1|c2|b1|b2|vloeiend|moedertaal|uitstekende\\s+beheersing|goede\\s+beheersing)[^.!?]{0,30}${DUTCH_TERM}`,
    'i',
  ),
  new RegExp(`native(?:-level)?(?:\\s+(?:in|speaker\\s+of))?\\s+${DUTCH_TERM}`, 'i'),
  new RegExp(
    `(?:must|need(?:ed)?\\s+to|required\\s+to|mandatory\\s+to)[^.!?]{0,45}(?:speak|communicate|write|read|understand|be\\s+fluent)[^.!?]{0,35}${DUTCH_TERM}`,
    'i',
  ),
  new RegExp(`${DUTCH_TERM}\\s+(?:and|&)\\s+english\\s+(?:is|are)?\\s*(?:required|mandatory)`, 'i'),
  new RegExp(
    `(?:spreekt?|schrijft?)(?:\\s+en\\s+(?:spreekt?|schrijft?))?[^.!?]{0,35}${DUTCH_TERM}`,
    'i',
  ),
  new RegExp(
    `(?:uitstekende|effectieve)\\s+communicatieve\\s+vaardigheden\\s+in\\s+(?:het\\s+)?${DUTCH_TERM}`,
    'i',
  ),
  new RegExp(
    `(?:je|jij|u|de\\s+kandidaat)\\b[^.!?]{0,25}\\bbeheers(?:t|en)?\\b[^.!?]{0,25}${DUTCH_TERM}`,
    'i',
  ),
  new RegExp(
    `(?:(?:the\\s+)?(?:role|position|job)|we)\\b[^.!?]{0,20}\\b(?:requires?|needs?)\\b[^.!?]{0,25}${DUTCH_TERM}`,
    'i',
  ),
];
const DUTCH_CONTEXTUAL_REQUIRED_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `(?:(?:excellent|good|strong|professional)\\s+)?command\\s+of\\s+(?:both\\s+)?(?:${DUTCH_TERM}(?:\\s+(?:and|&)\\s+english)?|english\\s+(?:and|&)\\s+${DUTCH_TERM})`,
    'i',
  ),
  new RegExp(
    `(?:business|professional|working)\\s+proficiency\\s+(?:in|of)\\s+${DUTCH_TERM}`,
    'i',
  ),
  new RegExp(
    `working\\s+languages?\\s*(?::|is|are)?[^.!?]{0,35}${DUTCH_TERM}`,
    'i',
  ),
  new RegExp(
    `(?:goede\\s+(?:mondelinge\\s+en\\s+schriftelijke\\s+)?)?beheersing\\s+(?:van\\s+)?(?:de\\s+)?${DUTCH_TERM}`,
    'i',
  ),
  new RegExp(
    `(?:kennis\\s+van\\s+(?:de\\s+)?${DUTCH_TERM}(?:\\s+taal)?|(?:goede\\s+)?(?:mondelinge\\s+en\\s+schriftelijke\\s+)?vaardigheden\\s+in\\s+(?:het\\s+)?${DUTCH_TERM})`,
    'i',
  ),
];
const DUTCH_NON_CANDIDATE_SUBJECT_PATTERN = new RegExp(
  `(?:^(?:(?:our|the|their|these|those)\\s+)?(?:(?:customer|product|engineering|support|sales|local|global)\\s+){0,3}(?:customers?|clients?|users?|partners?|teams?|colleagues?|employees?|workforce)\\b[^.!?]{0,25}\\b(?:has|have|uses?|speaks?)\\b|\\b(?:customers?|clients?|users?|partners?|teams?|colleagues?|employees?)\\s+whose\\b)`,
  'i',
);
const DUTCH_PREFERRED_PATTERN = new RegExp(
  `(?:${DUTCH_TERM}[^.!?]{0,70}${PREFERRED_LANGUAGE_QUALIFIER}|${PREFERRED_LANGUAGE_QUALIFIER}[^.!?]{0,70}${DUTCH_TERM})`,
  'i',
);
const DUTCH_DIRECT_PREFERRED_PATTERN = new RegExp(
  `(?:${DUTCH_TERM}(?:\\s+(?:language|fluency|proficiency|skills?))?\\s+(?:(?:is|are|would\\s+be)\\s+)?${PREFERRED_LANGUAGE_QUALIFIER}|(?:knowledge|fluency|proficiency)\\s+(?:of|in)\\s+${DUTCH_TERM}\\s+(?:(?:is|would\\s+be)\\s+)?${PREFERRED_LANGUAGE_QUALIFIER}|(?:fluency|proficiency)\\s+in\\s+${DUTCH_TERM}\\s+or\\s+[a-z-]+\\s+(?:is\\s+)?(?:a\\s+)?strong\\s+advantage|${PREFERRED_LANGUAGE_QUALIFIER}\\s+(?:for\\s+)?${DUTCH_TERM})`,
  'i',
);
const DUTCH_NEGATED_PATTERN = new RegExp(
  `(?:no|not|niet|geen|without|zonder|do\\s+not\\s+need)[^.!?]{0,35}${DUTCH_TERM}|${DUTCH_TERM}[^.!?]{0,35}(?:not\\s+required|not\\s+mandatory|not\\s+essential|not\\s+needed|not\\s+a\\s+prerequisite|niet\\s+vereist|geen\\s+vereiste|optional)`,
  'i',
);
const DUTCH_LANGUAGE_CAPABILITY_PATTERN = new RegExp(
  `(?:^${DUTCH_TERM}$|${DUTCH_TERM}[^.!?]{0,25}(?:language|proficiency|speaking|verbal|written|communication|skills?)|(?:speak|speaking|communicate|communication|written|verbal)[^.!?]{0,25}${DUTCH_TERM})`,
  'i',
);

const ROLE_EXCLUSION_ALIASES: Readonly<Record<PrimaryRoleFamily, readonly string[]>> = {
  frontend: [],
  'full-stack-typescript': ['full stack', 'fullstack'],
  'generic-frontend': [],
  'generic-software': ['generic software'],
  backend: ['backend only', 'pure backend'],
  management: ['management only', 'product management', 'project management'],
  'quality-assurance': ['qa only', 'test automation only'],
  data: ['data science', 'data engineering', 'machine learning research'],
  embedded: ['embedded', 'firmware', 'industrial controls', 'mechanical', 'electrical'],
  devops: ['devops only', 'sre only', 'infrastructure only'],
  design: ['design only'],
  support: ['support'],
  security: ['cybersecurity only'],
  erp: ['erp consulting', 'implementation consulting'],
  operations: ['operations'],
  commercial: ['sales', 'marketing', 'hr', 'finance'],
  other: [],
};

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeForMatching(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[’]/g, "'")
    .toLowerCase();
}

function plainText(value: string): string {
  return value
    .replace(/<(?:br|\/p|\/li|\/h[1-6]|\/div)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function inferContext(text: string, inherited: SegmentContext): SegmentContext {
  const normalized = normalizeForMatching(text);
  if (
    /\b(?:work|working|collaborat(?:e|ing)|partner)\s+(?:closely\s+)?with\b.{0,60}\bteam\b|\bsupport(?:ing)?\b.{0,40}\bteam\b/.test(
      normalized,
    )
  ) {
    return 'team';
  }
  if (/\b(?:nice to have|preferred|bonus|a plus|optional|desirable)\b/.test(normalized)) {
    return 'preference';
  }
  if (
    inherited === 'requirement' ||
    /\b(?:required|requirements|must have|you have|experience (?:with|in)|proficien(?:t|cy)|expertise|qualification)\b/.test(
      normalized,
    )
  ) {
    return 'requirement';
  }
  if (
    inherited === 'responsibility' ||
    /\b(?:you(?:'|’)ll|you will|build|develop|implement|create|architect|design|deliver|own|maintain|improve)\b/.test(
      normalized,
    )
  ) {
    return 'responsibility';
  }
  return inherited;
}

function createSegments(description: string): TextSegment[] {
  const lines = plainText(description)
    .replace(/^\s*[-*•]\s*/gm, '')
    .split('\n');
  const segments: TextSegment[] = [];
  let section: SegmentContext = 'general';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const heading = SECTION_HEADINGS.find(({ pattern }) => pattern.test(line));
    if (heading !== undefined) {
      section = heading.context;
      continue;
    }

    const sentences = line.split(/(?<=[.!?])\s+|\s+[•]\s+/);
    for (const sentence of sentences) {
      const original = sentence.trim();
      if (original.length === 0) continue;
      segments.push({
        original,
        normalized: normalizeForMatching(original),
        context: inferContext(original, section),
      });
    }
  }

  return segments;
}

function collectConceptEvidence(title: string, segments: readonly TextSegment[]): ConceptEvidence[] {
  const normalizedTitle = normalizeForMatching(title);
  return CONCEPTS.flatMap((concept) => {
    let strength = concept.pattern.test(normalizedTitle) ? 1 : 0;
    for (const segment of segments) {
      if (concept.pattern.test(segment.normalized)) {
        strength = Math.max(strength, CONTEXT_WEIGHT[segment.context]);
      }
    }
    return strength > 0 ? [{ label: concept.label, kind: concept.kind, strength }] : [];
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function skillPattern(skill: string): RegExp {
  const normalized = normalizeForMatching(skill).trim();
  const aliases: Readonly<Record<string, string>> = {
    'node.js': 'node(?:\\.js|js)',
    nestjs: 'nest(?:\\.js|js)',
    'react native': 'react\\s+native',
    'web components': 'web\\s+components?',
    'design systems': 'design\\s+systems?',
    'design tokens': 'design\\s+tokens?',
    'tailwind css': 'tailwind(?:\\s+css)?',
    'gitlab ci/cd': 'gitlab\\s+ci(?:/cd)?',
    'github actions': 'github\\s+actions?',
    'angular signals': 'angular\\s+signals?',
  };
  const source = aliases[normalized] ?? escapeRegExp(normalized).replace(/\\ /g, '\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${source}(?=$|[^a-z0-9])`, 'i');
}

function findMatchingSkills(vacancy: NormalizedVacancy, profile: CandidateProfile): string[] {
  const haystack = normalizeForMatching(`${vacancy.title}\n${plainText(vacancy.description)}`);
  const seen = new Set<string>();
  const matching: string[] = [];
  for (const skill of [...profile.strongestSkills, ...profile.additionalSkills]) {
    const identity = normalizeForMatching(skill);
    if (!seen.has(identity) && skillPattern(skill).test(haystack)) {
      seen.add(identity);
      matching.push(skill);
    }
  }
  return matching;
}

function meaningfulEvidenceCount(
  evidence: readonly ConceptEvidence[],
  kind: ConceptKind,
): number {
  return evidence.filter((item) => item.kind === kind && item.strength >= 0.9).length;
}

function countResponsibilitySignals(
  segments: readonly TextSegment[],
  patterns: readonly RegExp[],
): number {
  return patterns.filter((pattern) =>
    segments.some(
      (segment) =>
        segment.context === 'responsibility' && pattern.test(segment.normalized),
    ),
  ).length;
}

function classifyPrimaryRole(
  vacancy: NormalizedVacancy,
  evidence: readonly ConceptEvidence[],
  segments: readonly TextSegment[],
): RoleAssessment {
  const title = normalizeForMatching(vacancy.title);
  const descriptionText = segments.map((segment) => segment.normalized).join(' ');
  const core = meaningfulEvidenceCount(evidence, 'core');
  const domain = meaningfulEvidenceCount(evidence, 'domain');
  const hasTypeScript = evidence.some(
    (item) => item.label === 'TypeScript' && item.strength >= 0.9,
  );
  const hasJavaScript = evidence.some(
    (item) => item.label === 'JavaScript' && item.strength >= 0.9,
  );
  const angularElectron = ['Angular', 'Electron'].every((label) =>
    evidence.some((item) => item.label === label && item.strength >= 0.9),
  );
  const heavyFrontend =
    core >= 3 || (core >= 2 && domain >= 1) || (core >= 1 && domain >= 3) || angularElectron;
  const backendResponsibilitySignals = countResponsibilitySignals(segments, [
    /\bback[ -]?end\b/,
    /\bjava\b/,
    /\bspring(?: boot)?\b/,
    /\bjvm\b/,
    /\.net\b|\bc#/,
    /\b(?:php|python|django)\b/,
    /\bmicroservices?\b/,
    /\b(?:kafka|rabbitmq)\b/,
  ]);
  const frontendResponsibilitySignals = CONCEPTS.filter((concept) =>
    segments.some(
      (segment) =>
        segment.context === 'responsibility' &&
        /^(?:(?:you|we)(?:'ll| will)?\s+)?(?:build|develop|implement|create|architect|design|deliver|own|maintain|improve|work on)\b/.test(
          segment.normalized,
        ) &&
        concept.pattern.test(segment.normalized),
    ),
  ).length;

  const assessment = (
    family: PrimaryRoleFamily,
    score: number,
    primaryFit: string,
    reason: string,
  ): RoleAssessment => ({ family, score, primaryFit, reason });

  if (/\b(?:engineering manager|development manager|head of engineering|director of engineering|vp of engineering)\b/.test(title)) {
    return assessment('management', 5, 'Engineering management', 'The title identifies management as the primary responsibility.');
  }
  if (/\b(?:product manager|product owner|project manager|program manager|scrum master)\b/.test(title)) {
    return assessment('management', 5, 'Product/project management', 'The title is a management role rather than hands-on frontend engineering.');
  }
  if (/\b(?:qa|quality assurance|sdet|test automation|automation test|test engineer)\b/.test(title)) {
    return assessment('quality-assurance', 5, 'QA / test automation', 'The title makes quality assurance or test automation the primary role family.');
  }
  if (/\b(?:data engineer|data scientist|machine learning|ml engineer|ai researcher|analytics engineer)\b/.test(title)) {
    return assessment('data', 5, 'Data / machine learning', 'The title identifies a data or machine-learning role.');
  }
  if (
    /\b(?:embedded|firmware|plc|industrial controls?|electronics? engineer)\b/.test(title) ||
    /\bc\+\+/.test(title)
  ) {
    return assessment('embedded', 5, 'Embedded / firmware engineering', 'The title identifies embedded, firmware, or industrial-control work.');
  }
  if (
    /\b(?:devops|site reliability|sre|cloud infrastructure|infrastructure(?: platform)? engineer|platform operations)\b/.test(title) &&
    !/\bfront[ -]?end platform\b/.test(title)
  ) {
    return assessment('devops', 5, 'DevOps / infrastructure', 'The title identifies infrastructure operations as the primary role family.');
  }
  if (/\b(?:cybersecurity|security operations|soc analyst|penetration tester)\b/.test(title)) {
    return assessment('security', 5, 'Cybersecurity', 'The title identifies cybersecurity as the primary role family.');
  }
  if (/\b(?:sap|erp|salesforce|implementation consultant)\b/.test(title)) {
    return assessment('erp', 5, 'ERP / enterprise consulting', 'The title identifies an ERP or enterprise-platform role.');
  }
  if (/\b(?:support engineer|helpdesk|service desk|technical support|customer support|customer success manager)\b/.test(title)) {
    return assessment('support', 5, 'Technical support', 'The title identifies support as the primary responsibility.');
  }
  if (/\b(?:mechanical|electrical|warehouse|logistics|manufacturing|field technician)\b/.test(title)) {
    return assessment('operations', 5, 'Engineering / operational work outside software', 'The title is outside the target software role families.');
  }
  if (/\b(?:sales|pre-sales|account executive|marketing|recruiter|human resources|finance)\b/.test(title)) {
    return assessment('commercial', 5, 'Commercial / business role', 'The title is outside hands-on software engineering.');
  }
  if (/\b(?:product|ux|ui|ui\/ux|visual) designer\b/.test(title)) {
    return assessment('design', 20, 'Product / UX design', 'The title identifies design rather than UI engineering as the primary role.');
  }
  if (
    (/(?:\b(?:back[ -]?end|java|php|python|nestjs)\b|\.net\b|\bc#)/.test(title)) &&
    /\b(?:engineer|developer|architect)\b/.test(title)
  ) {
    return assessment('backend', 5, 'Backend engineering', 'The title makes backend technology or backend engineering primary.');
  }
  if (
    /\b(?:front[ -]?end|angular|react|ui engineer|web platform|design systems? engineer|typescript frontend)\b/.test(title)
  ) {
    return assessment('frontend', 96, 'Frontend / UI engineering', 'The title directly identifies a target frontend role family.');
  }
  if (/\bfull[ -]?stack\b/.test(title)) {
    if (backendResponsibilitySignals >= 2 && frontendResponsibilitySignals < 2) {
      return assessment(
        'backend',
        8,
        'Backend engineering',
        'Primary responsibilities are dominated by backend technologies; the full-stack title and frontend terms elsewhere do not change the role family.',
      );
    }
    if (
      hasTypeScript &&
      (core >= 2 || domain >= 1) &&
      frontendResponsibilitySignals >= 2
    ) {
      return assessment('full-stack-typescript', 82, 'Full-stack TypeScript with substantial frontend work', 'The role is full-stack, with TypeScript and meaningful frontend evidence in core work.');
    }
    if (
      hasJavaScript &&
      core >= 2 &&
      domain >= 1 &&
      frontendResponsibilitySignals >= 2
    ) {
      return assessment(
        'full-stack-typescript',
        82,
        'Full-stack JavaScript with substantial frontend work',
        'The role is full-stack, with JavaScript, multiple frontend technologies, and meaningful frontend product evidence.',
      );
    }
    return assessment('generic-software', 52, 'Generic full-stack engineering', 'The full-stack title lacks enough evidence that frontend TypeScript work is substantial.');
  }

  const softwareLikeTitle =
    /\b(?:software|product|application|web)\s+(?:engineer|developer)\b/.test(title) ||
    /\b(?:java|type)script\s+(?:engineer|developer)\b/.test(title);
  const frontendStackSignals = evidence.filter(
    (item) => item.kind === 'core' && item.strength >= 0.9,
  ).length;
  const fullStackProductEvidence =
    /\bfull[ -]?stack\b/.test(descriptionText) &&
    /\b(?:front[ -]?end|user[ -]?facing\s+(?:applications?|apps?|products?|flows?)|user experience|react|angular|ui)\b/.test(
      descriptionText,
    );
  if (softwareLikeTitle && frontendStackSignals >= 2 && fullStackProductEvidence) {
    const technology = hasTypeScript ? 'TypeScript' : 'JavaScript';
    return assessment(
      'full-stack-typescript',
      82,
      `Full-stack ${technology} with substantial frontend work`,
      `The role is full-stack ${technology}, with multiple frontend technologies and explicit user-facing product work.`,
    );
  }

  const genericTitle = softwareLikeTitle;
  if (backendResponsibilitySignals >= 2 && frontendResponsibilitySignals < 2) {
    return assessment(
      'backend',
      8,
      'Backend engineering',
      'Primary responsibilities are dominated by backend technologies; frontend terms elsewhere do not change the role family.',
    );
  }
  if (heavyFrontend) {
    return assessment(
      'generic-frontend',
      genericTitle ? 88 : 84,
      'Frontend product engineering',
      'The generic title is supported by multiple frontend technologies and frontend responsibility signals.',
    );
  }
  if (genericTitle) {
    return assessment('generic-software', 48, 'Generic software engineering', 'The generic title is not backed by enough primary frontend responsibility evidence.');
  }

  return assessment('other', 30, 'Unclear role family', 'The vacancy does not provide strong evidence of a target role family.');
}

function assessTechnicalFit(
  role: RoleAssessment,
  evidence: readonly ConceptEvidence[],
  matchingSkills: readonly string[],
): DimensionAssessment {
  const coreStrength = evidence
    .filter((item) => item.kind === 'core')
    .reduce((total, item) => total + item.strength, 0);
  const domainStrength = evidence
    .filter((item) => item.kind === 'domain')
    .reduce((total, item) => total + item.strength, 0);
  const explicitFrontendTitle = role.family === 'frontend';
  let score =
    18 +
    Math.min(45, coreStrength * 15) +
    Math.min(32, domainStrength * 9) +
    Math.min(12, matchingSkills.length * 3) +
    (explicitFrontendTitle ? 8 : 0);

  if (
    ['backend', 'management', 'quality-assurance', 'data', 'embedded', 'devops', 'support'].includes(
      role.family,
    )
  ) {
    score = Math.min(score, 55);
  }

  const rounded = Math.round(clamp(score));
  const meaningful = evidence.filter((item) => item.strength >= 0.9).map((item) => item.label);
  const reason =
    meaningful.length > 0
      ? `Primary responsibilities or requirements support: ${meaningful.join(', ')}. Repeated keywords are counted once.`
      : 'Little frontend technology evidence appears in primary responsibilities or requirements.';
  return { score: rounded, reason };
}

function assessSeniority(vacancy: NormalizedVacancy, profile: CandidateProfile): DimensionAssessment {
  const title = normalizeForMatching(vacancy.title);
  const text = normalizeForMatching(`${vacancy.title}\n${plainText(vacancy.description)}`);

  if (/\b(?:intern|internship|graduate|junior|entry[ -]?level)\b/.test(title)) {
    return { score: 35, reason: 'The role is advertised at junior or entry level for a senior candidate.' };
  }
  if (/\b(?:medior|mid[ -]?level|midweight|intermediate)\b/.test(title)) {
    return { score: 65, reason: 'The role is advertised as mid-level; this is a seniority mismatch, not an exclusion.' };
  }
  if (/\b(?:senior|lead|principal|staff)\b/.test(title)) {
    return { score: 100, reason: 'The advertised seniority aligns with the candidate’s senior experience.' };
  }
  if (/\b(?:medior|mid[ -]?level|midweight|intermediate)\b/.test(text)) {
    return { score: 65, reason: 'The role is described as mid-level; this is a seniority mismatch, not an exclusion.' };
  }

  const isCandidateRequirementContext = (match: RegExpMatchArray): boolean => {
    const matchIndex = match.index ?? 0;
    const precedingText = text.slice(0, matchIndex);
    const segmentStart = Math.max(
      precedingText.lastIndexOf('\n'),
      precedingText.lastIndexOf('.'),
      precedingText.lastIndexOf('!'),
      precedingText.lastIndexOf('?'),
      precedingText.lastIndexOf(';'),
    ) + 1;
    const followingDelimiters = ['\n', '.', '!', '?', ';']
      .map((delimiter) => text.indexOf(delimiter, matchIndex))
      .filter((index) => index >= 0);
    const segmentEnd = followingDelimiters.length === 0
      ? text.length
      : Math.min(...followingDelimiters);
    const segment = text.slice(segmentStart, segmentEnd).trim();
    const prefix = text.slice(segmentStart, matchIndex).trim();

    if (
      /\b(?:backed by|drawing on|built on|company history|years in business|operating for|trusted for)\b/.test(prefix) ||
      /\b(?:our|the|this)\s+(?:company|business|organisation|organization|group|brand)\s+(?:has|brings?|offers?)\b/.test(prefix)
    ) {
      return false;
    }
    if (prefix.length === 0 || /^[-*•]\s*$/u.test(prefix)) return true;
    return (
      /\b(?:you(?:'ve| have| bring| possess| need)|your|candidate|applicant|we (?:ask|require|expect|seek)|we(?:'re| are) (?:looking|searching)|looking for|seeking|required|requirements?|minimum|at least|proven|must have|should have|need(?:ed)?|ideally|preferably)\b/.test(segment) ||
      /\b(?:professional|commercial|hands-on|relevant|frontend|front-end|software development|engineering)\s+experience\b/.test(segment)
    );
  };
  const maximumPlausibleRequirementYears = 20;
  const range = [...text.matchAll(/\b(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\s+years?\b/g)].find(
    (match) =>
      Number(match[2]) <= maximumPlausibleRequirementYears &&
      isCandidateRequirementContext(match),
  );
  if (range !== undefined) {
    const upper = Number(range[2]);
    if (upper <= 5) {
      return { score: 65, reason: `The advertised ${range[1]}-${range[2]} years is below the candidate’s experience; the role remains eligible.` };
    }
  }

  const years = [...text.matchAll(/\b(\d{1,2})\s*\+?\s+years?\b/g)].find(
    (match) =>
      Number(match[1]) <= maximumPlausibleRequirementYears &&
      isCandidateRequirementContext(match),
  );
  if (years !== undefined) {
    const requiredYears = Number(years[1]);
    if (requiredYears <= 3) {
      return { score: 60, reason: `${requiredYears}+ years indicates a material seniority mismatch, but is not a standalone rejection.` };
    }
    if (requiredYears <= 5) {
      return { score: 75, reason: `${requiredYears}+ years is somewhat below the candidate’s senior experience.` };
    }
    if (requiredYears > profile.experienceYears) {
      return { score: 70, reason: `The role asks for ${requiredYears}+ years versus ${profile.experienceYears} in the profile.` };
    }
    return { score: 95, reason: 'The experience requirement is compatible with the candidate’s background.' };
  }

  return { score: 90, reason: 'No material seniority mismatch is stated.' };
}

export function detectDutchRequirement(vacancy: NormalizedVacancy): DutchRequirementAssessment {
  const normalizedTitle = normalizeForMatching(vacancy.title);
  if (
    new RegExp(
      `(?:${DUTCH_TERM}[^|/]{0,20}(?:speaker|speaking)|(?:speaker|speaking)[^|/]{0,20}${DUTCH_TERM}|\\bnederlandstalig(?:e)?\\b)`,
      'i',
    ).test(normalizedTitle)
  ) {
    return { dutchRequired: true, dutchPreferred: false, evidence: [vacancy.title] };
  }
  const segments = createSegments(vacancy.description);
  const preferredEvidence: string[] = [];
  const requiredEvidence: string[] = [];

  for (const segment of segments) {
    if (!new RegExp(DUTCH_TERM, 'i').test(segment.normalized)) continue;
    const negated = DUTCH_NEGATED_PATTERN.test(segment.normalized);
    const directlyPreferred = DUTCH_DIRECT_PREFERRED_PATTERN.test(segment.normalized);
    const nonCandidateSubject = DUTCH_NON_CANDIDATE_SUBJECT_PATTERN.test(segment.normalized);
    const required =
      !nonCandidateSubject &&
      (DUTCH_REQUIRED_PATTERNS.some((pattern) => pattern.test(segment.normalized)) ||
        (segment.context === 'requirement' &&
          (DUTCH_CONTEXTUAL_REQUIRED_PATTERNS.some((pattern) =>
            pattern.test(segment.normalized),
          ) ||
            DUTCH_LANGUAGE_CAPABILITY_PATTERN.test(segment.normalized))));
    if (negated) {
      preferredEvidence.push(segment.original);
    } else if (required && !directlyPreferred) {
      requiredEvidence.push(segment.original);
    } else if (directlyPreferred || DUTCH_PREFERRED_PATTERN.test(segment.normalized)) {
      preferredEvidence.push(segment.original);
    }
  }

  const uniqueRequired = [...new Set(requiredEvidence)];
  const uniquePreferred = [...new Set(preferredEvidence)];
  return {
    dutchRequired: uniqueRequired.length > 0,
    dutchPreferred: uniqueRequired.length === 0 && uniquePreferred.length > 0,
    evidence: uniqueRequired.length > 0 ? uniqueRequired : uniquePreferred,
  };
}

function assessLanguage(
  assessment: DutchRequirementAssessment,
  profile: CandidateProfile,
): DimensionAssessment {
  if (assessment.dutchRequired) {
    if (profile.constraints.dutchRequired) {
      return { score: 100, reason: 'Dutch is mandatory and the profile explicitly permits Dutch-required roles.' };
    }
    return { score: 0, reason: `Dutch is explicitly mandatory: ${assessment.evidence.join(' | ')}` };
  }
  if (assessment.dutchPreferred) {
    return { score: 90, reason: `Dutch is preferred or optional, not mandatory: ${assessment.evidence.join(' | ')}` };
  }
  return { score: 100, reason: 'No explicit mandatory Dutch-language requirement was found.' };
}

function assessLocation(vacancy: NormalizedVacancy, profile: CandidateProfile): DimensionAssessment {
  const location = normalizeForMatching(vacancy.location ?? '');
  const description = normalizeForMatching(plainText(vacancy.description));
  const remote = vacancy.remote === true || /\bremote\b/.test(location);
  const netherlandsEmploymentExcluded = [
    /\b(?:cannot|can not|can't|unable to|do not|don't|does not|doesn't)\s+(?:currently\s+)?(?:hire|employ|offer\s+employment\s+to|support\s+employment\s+for)\s+(?:candidates?\s+)?(?:based\s+)?in\s+(?:the\s+)?(?:netherlands|nederland)\b/,
    /\b(?:netherlands|nederland)(?:-based)?\s+(?:employment|hiring|candidates?|workers?)\b[^.!?]{0,30}\b(?:is|are)\s+(?:currently\s+)?not\s+(?:supported|available|eligible|permitted)\b/,
    /\b(?:employment|hiring)\s+in\s+(?:the\s+)?(?:netherlands|nederland)\b[^.!?]{0,20}\b(?:is|are)\s+(?:currently\s+)?not\s+(?:supported|available|eligible|permitted)\b/,
    /\b(?:excluding|except(?:\s+for)?|not\s+(?:available|supported|offered)\s+in)\s+(?:the\s+)?(?:netherlands|nederland)\b/,
  ].some((pattern) => pattern.test(description));
  const dutchLocation =
    /\b(?:netherlands|nederland|amsterdam|rotterdam|utrecht|eindhoven|den haag|the hague|delft|leiden|groningen|tilburg|breda|arnhem|nijmegen|hoofddorp|schiphol|hilversum|zwolle|enschede)\b/.test(
      location,
    ) || /\bnl\b/.test(location);

  if (netherlandsEmploymentExcluded) {
    return {
      score: 0,
      reason: 'The vacancy explicitly excludes hiring or employment in the Netherlands.',
    };
  }

  if (dutchLocation) {
    return { score: 100, reason: remote ? 'The role supports remote work in the Netherlands.' : 'The role is based in the Netherlands.' };
  }

  const euLocation = /\b(?:eu|europe|european union|emea|european economic area|eea)\b/.test(location);
  if (remote && euLocation && profile.constraints.allowRemoteEuSupportingNetherlands) {
    return { score: 85, reason: 'The role is remote within Europe; Netherlands employment support still needs confirmation.' };
  }
  if (remote && location.length === 0 && profile.constraints.allowRemoteEuSupportingNetherlands) {
    return { score: 75, reason: 'The role is remote, but Netherlands or EU employment eligibility is not explicit.' };
  }
  if (remote && /\b(?:worldwide|global|anywhere)\b/.test(location)) {
    return { score: 75, reason: 'The role is globally remote; Netherlands employment support needs confirmation.' };
  }
  if (location.length === 0) {
    return { score: 55, reason: 'No location was supplied, so Netherlands eligibility is unknown.' };
  }
  if (remote) {
    return { score: 45, reason: `Remote work is stated for “${vacancy.location ?? 'unknown'}”, but Netherlands eligibility is unclear.` };
  }
  return { score: 20, reason: `The stated location “${vacancy.location ?? 'unknown'}” is not in the Netherlands.` };
}

function isExcludedPrimaryFamily(family: PrimaryRoleFamily, profile: CandidateProfile): boolean {
  const configured = profile.excludedRoleFamilies.map((value) =>
    normalizeForMatching(value).replace(/[^a-z0-9]+/g, ' ').trim(),
  );
  return ROLE_EXCLUSION_ALIASES[family].some((alias) =>
    configured.some((configuredFamily) => configuredFamily.includes(alias)),
  );
}

export function isDeterministicallyRelevant(
  score: Pick<DeterministicScore, 'deterministicScore'> | number,
  threshold = RELEVANCE_THRESHOLD,
): boolean {
  const numericScore = typeof score === 'number' ? score : score.deterministicScore;
  return numericScore >= threshold;
}

export function scoreVacancy(
  vacancy: NormalizedVacancy,
  profile: CandidateProfile,
): DeterministicScore {
  const segments = createSegments(vacancy.description);
  const conceptEvidence = collectConceptEvidence(vacancy.title, segments);
  const matchingSkills = findMatchingSkills(vacancy, profile);
  const role = classifyPrimaryRole(vacancy, conceptEvidence, segments);
  const technical = assessTechnicalFit(role, conceptEvidence, matchingSkills);
  const seniority = assessSeniority(vacancy, profile);
  const languageDetection = detectDutchRequirement(vacancy);
  const language = assessLanguage(languageDetection, profile);
  const location = assessLocation(vacancy, profile);
  const salary = assessNetherlandsSalary(
    `${vacancy.title}\n${vacancy.description}`,
    profile.constraints.minimumMonthlyBaseEur,
  );
  const excludedPrimaryFamily = isExcludedPrimaryFamily(role.family, profile);

  const weightedScore = Math.round(
    technical.score * 0.35 +
      role.score * 0.3 +
      seniority.score * 0.1 +
      language.score * 0.15 +
      location.score * 0.1,
  );
  let deterministicScore = weightedScore;
  if (excludedPrimaryFamily) deterministicScore = Math.min(deterministicScore, 45);
  if (languageDetection.dutchRequired && !profile.constraints.dutchRequired) {
    deterministicScore = Math.min(deterministicScore, 49);
  }
  if (location.score < 50) deterministicScore = Math.min(deterministicScore, 69);
  if (salary.decision === 'below') deterministicScore = Math.min(deterministicScore, 69);

  const gaps: string[] = [];
  if (matchingSkills.length === 0) gaps.push('No explicit candidate skill match found');
  if (seniority.score < 80) gaps.push('Advertised seniority is below the candidate’s experience');
  if (languageDetection.dutchRequired && !profile.constraints.dutchRequired) {
    gaps.push('Mandatory Dutch-language requirement');
  }
  if (location.score < 70) gaps.push('Netherlands employment location is not established');
  if (excludedPrimaryFamily) gaps.push(`Excluded primary role family: ${role.primaryFit}`);
  if (salary.decision === 'unverified') gaps.push('Minimum EUR base salary is not advertised');
  if (salary.decision === 'below') gaps.push('Advertised EUR base salary is below the configured minimum');

  const reasons = [
    `Technical fit (${technical.score}): ${technical.reason}`,
    `Role fit (${role.score}): ${role.reason}`,
    `Seniority fit (${seniority.score}): ${seniority.reason}`,
    `Language fit (${language.score}): ${language.reason}`,
    `Location fit (${location.score}): ${location.reason}`,
    `Salary gate: ${salary.reason}`,
  ];
  if (excludedPrimaryFamily) {
    reasons.push(`Hard cap applied because “${role.primaryFit}” matches a configured excluded role family.`);
  }
  if (languageDetection.dutchRequired && !profile.constraints.dutchRequired) {
    reasons.push('Hard cap applied because the vacancy explicitly requires Dutch.');
  }
  if (location.score < 50) {
    reasons.push('Eligibility cap applied because the stated work location does not establish Netherlands employment.');
  }
  if (salary.decision === 'below') {
    reasons.push('Eligibility cap applied because the advertised Netherlands salary is below the configured minimum.');
  }
  if (salary.decision === 'unverified') {
    reasons.push('No salary eligibility cap applied because vacancies with undisclosed salary remain reviewable.');
  }

  return deterministicScoreSchema.parse({
    relevant: isDeterministicallyRelevant(deterministicScore),
    deterministicScore,
    technicalFit: technical.score,
    roleFit: role.score,
    seniorityFit: seniority.score,
    languageFit: language.score,
    locationFit: location.score,
    dutchRequired: languageDetection.dutchRequired,
    dutchPreferred: languageDetection.dutchPreferred,
    languageEvidence: languageDetection.evidence,
    primaryFit: role.primaryFit,
    matchingSkills,
    gaps,
    reasons,
  });
}
