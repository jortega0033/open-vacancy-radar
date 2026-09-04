import { type NormalizedVacancy } from '../domain/models.js';
import { isCandidateProfileConfigured, type CandidateProfile } from '../candidate/profile.js';

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
    .replace(/[–—]/g, '-')
    .replace(/[’]/g, "'")
    .toLowerCase();
}

const NAMED_ENTITY: Record<string, string> = {
  nbsp: ' ',
  '#160': ' ',
  amp: '&',
  quot: '"',
  '#34': '"',
  '#39': "'",
  apos: "'",
};

const NAMED_ENTITY_PATTERN = new RegExp(`&(${Object.keys(NAMED_ENTITY).join('|')});`, 'gi');

/**
 * Decodes the handful of HTML entities job-description markup actually uses, in one pass. The
 * previous version ran a separate `.replace(/&amp;/gi, '&')` before the `&quot;`/`&#39;` passes, so
 * a source string containing an already-escaped entity — `&amp;quot;`, literally the text `&quot;`
 * on the page — got decoded twice: once to `&quot;` by the `&amp;` pass, then again to `"` by the
 * pass after it, same as CodeQL's `js/double-escaping` finding on this function. Matching the whole
 * `&name;`/`&#nn;` token in one alternation and replacing each match exactly once removes the
 * possibility structurally: `String.replace` with `/g` never rescans text it just inserted.
 * `NAMED_ENTITY_PATTERN` is derived from `NAMED_ENTITY`'s own keys so the two can't drift apart.
 */
export function plainText(value: string): string {
  return value
    .replace(/<(?:br|\/p|\/li|\/h[1-6]|\/div)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(NAMED_ENTITY_PATTERN, (match, entity: string) => NAMED_ENTITY[entity.toLowerCase()] ?? match)
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

function findMatchingSkills(
  vacancy: Pick<NormalizedVacancy, 'title' | 'description'>,
  profile: CandidateProfile,
): string[] {
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
  vacancy: Pick<NormalizedVacancy, 'title'>,
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

function assessSeniority(
  vacancy: Pick<NormalizedVacancy, 'title' | 'description'>,
  profile: CandidateProfile,
): DimensionAssessment {
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

function isExcludedPrimaryFamily(family: PrimaryRoleFamily, profile: CandidateProfile): boolean {
  const configured = profile.excludedRoleFamilies.map((value) =>
    normalizeForMatching(value).replace(/[^a-z0-9]+/g, ' ').trim(),
  );
  return ROLE_EXCLUSION_ALIASES[family].some((alias) =>
    configured.some((configuredFamily) => configuredFamily.includes(alias)),
  );
}

export function isDeterministicallyRelevant(score: number, threshold = RELEVANCE_THRESHOLD): boolean {
  return score >= threshold;
}

export type WorldwideDeterministicScore = {
  relevant: boolean;
  deterministicScore: number;
  technicalFit: number;
  roleFit: number;
  seniorityFit: number;
  primaryFit: string;
  matchingSkills: string[];
  gaps: string[];
  reasons: string[];
};

export type WorldwideScorableVacancy = {
  title: string;
  /** Null where the source carried no description text at all -- see `DiscoveryVacancyAudit`. */
  description: string | null;
  /** Null where no deterministic USD/annual figure could be established -- see `annualizedMinimumUsd`. */
  annualizedMinimumUsd: number | null;
};

/**
 * The sole deterministic scorer left in this package: the curated Netherlands pipeline's own
 * `scoreVacancy` (five dimensions -- technical, role, seniority, Dutch-language, Netherlands
 * location -- weighted 0.35/0.30/0.10/0.15/0.10) was removed with the rest of that pipeline. This
 * function reuses only the sub-assessors that never encoded a Netherlands assumption -- technical
 * fit, role classification, and seniority fit -- plus the excluded-role-family hard cap, which is
 * candidate-profile data, not NL-specific. Dutch language fit and Netherlands location fit have no
 * honest replacement for a worldwide-remote vacancy, so they are dropped entirely rather than
 * stubbed to a neutral value. Their combined 0.25 weight (0.15 language + 0.10 location) is
 * dropped, and the three remaining dimensions are re-weighted so the composite still sums to 100
 * while keeping their original relative order (technical > role > seniority): technical 0.45, role
 * 0.40, seniority 0.15. This is not a proportional scaling of the deleted scorer's 0.35/0.30/0.10
 * ratio -- it's a deliberate new weighting for a scorer with three dimensions instead of five.
 *
 * The salary gate is the worldwide pipeline's own USD/annual floor
 * (`GlobalRemoteConfig.criteria.minimumAnnualBaseUsd`, passed in as `minimumAnnualBaseUsd`), never
 * the Netherlands EUR/monthly floor -- `CandidateProfile` carries no worldwide salary field at all.
 *
 * Returns null, never a real-looking zero, when the candidate profile has no target roles and no
 * strongest skills configured (see `isCandidateProfileConfigured`): every dimension would be
 * scoring against an absence rather than a real preference.
 */
export function scoreWorldwideVacancy(
  vacancy: WorldwideScorableVacancy,
  profile: CandidateProfile,
  minimumAnnualBaseUsd: number | null,
): WorldwideDeterministicScore | null {
  if (!isCandidateProfileConfigured(profile)) return null;

  const description = vacancy.description ?? '';
  const segments = createSegments(description);
  const conceptEvidence = collectConceptEvidence(vacancy.title, segments);
  const matchingSkills = findMatchingSkills({ title: vacancy.title, description }, profile);
  const role = classifyPrimaryRole({ title: vacancy.title }, conceptEvidence, segments);
  const technical = assessTechnicalFit(role, conceptEvidence, matchingSkills);
  const seniority = assessSeniority({ title: vacancy.title, description }, profile);
  const excludedPrimaryFamily = isExcludedPrimaryFamily(role.family, profile);

  const weightedScore = Math.round(
    technical.score * 0.45 + role.score * 0.4 + seniority.score * 0.15,
  );
  let deterministicScore = weightedScore;
  if (excludedPrimaryFamily) deterministicScore = Math.min(deterministicScore, 45);

  const salaryBelowThreshold =
    vacancy.annualizedMinimumUsd !== null &&
    minimumAnnualBaseUsd !== null &&
    vacancy.annualizedMinimumUsd < minimumAnnualBaseUsd;
  if (salaryBelowThreshold) deterministicScore = Math.min(deterministicScore, 69);

  const gaps: string[] = [];
  if (matchingSkills.length === 0) gaps.push('No explicit candidate skill match found');
  if (seniority.score < 80) gaps.push('Advertised seniority is below the candidate’s experience');
  if (excludedPrimaryFamily) gaps.push(`Excluded primary role family: ${role.primaryFit}`);
  if (vacancy.annualizedMinimumUsd === null) {
    gaps.push('Minimum USD annual base salary is not advertised');
  } else if (salaryBelowThreshold) {
    gaps.push('Advertised USD annual base salary is below the configured minimum');
  }

  const reasons = [
    `Technical fit (${technical.score}): ${technical.reason}`,
    `Role fit (${role.score}): ${role.reason}`,
    `Seniority fit (${seniority.score}): ${seniority.reason}`,
  ];
  if (excludedPrimaryFamily) {
    reasons.push(`Hard cap applied because “${role.primaryFit}” matches a configured excluded role family.`);
  }
  if (salaryBelowThreshold) {
    reasons.push('Eligibility cap applied because the advertised USD annual base salary is below the configured minimum.');
  } else if (vacancy.annualizedMinimumUsd === null) {
    reasons.push('No salary eligibility cap applied because vacancies with an unadvertised USD base floor remain reviewable.');
  }

  return {
    relevant: isDeterministicallyRelevant(deterministicScore),
    deterministicScore,
    technicalFit: technical.score,
    roleFit: role.score,
    seniorityFit: seniority.score,
    primaryFit: role.primaryFit,
    matchingSkills,
    gaps,
    reasons,
  };
}
