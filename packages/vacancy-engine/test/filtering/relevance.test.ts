import { describe, expect, it } from 'vitest';

import type { CandidateProfile } from '../../src/candidate/profile.js';
import type { NormalizedVacancy } from '../../src/domain/models.js';
import {
  DETERMINISTIC_SCORING_VERSION,
  RELEVANCE_THRESHOLD,
  detectDutchRequirement,
  isDeterministicallyRelevant,
  plainText,
  scoreVacancy,
} from '../../src/filtering/index.js';

const profile: CandidateProfile = {
  profileVersion: 'candidate-profile-v1',
  candidateName: 'Jake Ortega',
  currentRole: 'Senior Frontend Engineer',
  location: 'Netherlands',
  experienceYears: 10,
  strongestSkills: [
    'Angular',
    'TypeScript',
    'JavaScript',
    'RxJS',
    'NgRx',
    'React',
    'Web Components',
    'design systems',
    'accessibility',
    'Playwright',
    'Cypress',
    'Electron',
  ],
  additionalSkills: ['Node.js', 'NestJS', 'PostgreSQL', 'Docker'],
  targetRoles: [
    'Senior Frontend Engineer',
    'Frontend Engineer',
    'Angular Developer',
    'UI Engineer',
    'Design System Engineer',
  ],
  consideredRoles: [
    'React Engineer',
    'Product Engineer',
    'Software Engineer',
    'Full Stack TypeScript Engineer',
  ],
  excludedRoleFamilies: [
    'backend-only',
    'embedded',
    'firmware',
    'data science',
    'data engineering',
    'ERP consulting',
    'implementation consulting',
    'DevOps-only',
    'SRE-only',
    'QA-only',
    'management-only',
    'product management',
    'project management',
    'support',
    'operations',
  ],
  constraints: {
    professionalLanguage: 'English',
    dutchRequired: false,
    primaryCountry: 'Netherlands',
    allowRemoteEuSupportingNetherlands: true,
    minimumMonthlyBaseEur: 6_000,
  },
};

const frontendOnlyProfile: CandidateProfile = {
  ...profile,
  profileVersion: 'candidate-profile-v2',
  excludedRoleFamilies: [
    ...profile.excludedRoleFamilies,
    'full-stack',
    'generic software engineering',
  ],
};

function vacancy(
  title: string,
  description: string,
  overrides: Partial<NormalizedVacancy> = {},
): NormalizedVacancy {
  return {
    externalId: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    title,
    description: /(?:€|\bEUR\b)/iu.test(description)
      ? description
      : `${description}\nCompensation: €6,500 gross per month.`,
    location: 'Amsterdam, Netherlands',
    remote: null,
    workplaceMode: 'unknown',
    url: 'https://jobs.example.test/vacancy',
    postedAt: null,
    employmentType: 'Full-time',
    source: 'test',
    ...overrides,
  };
}

const acceptedCorpus: readonly {
  name: string;
  input: NormalizedVacancy;
  primaryFit: RegExp;
}[] = [
  {
    name: 'strong Angular work behind a generic Software Engineer title',
    input: vacancy(
      'Software Engineer',
      `Responsibilities
       Build and own an Angular and TypeScript web application.
       Create accessible UI components for our design system.
       Requirements
       Strong Angular, RxJS and frontend architecture experience.`,
    ),
    primaryFit: /frontend/i,
  },
  {
    name: 'React product engineering',
    input: vacancy(
      'Product Engineer',
      `What you'll do
       Build a React and TypeScript frontend for our customer-facing web application.
       Own UI engineering and accessible product experiences.`,
    ),
    primaryFit: /frontend/i,
  },
  {
    name: 'Angular and Electron product work',
    input: vacancy(
      'Software Developer',
      `Responsibilities
       Develop an Angular, TypeScript and Electron browser-based product.
       Own the desktop UI and web application architecture.`,
    ),
    primaryFit: /frontend/i,
  },
  {
    name: 'design-system engineering',
    input: vacancy(
      'Design System Engineer',
      `Responsibilities
       Build accessible Web Components and TypeScript UI primitives for our design system.
       Improve WCAG compliance across frontend products.`,
    ),
    primaryFit: /frontend|ui/i,
  },
  {
    name: 'mixed full-stack TypeScript with substantial frontend work',
    input: vacancy(
      'Full Stack TypeScript Engineer',
      `Responsibilities
       Build our React and TypeScript frontend and customer-facing web application.
       Develop Node.js and NestJS APIs and own UI delivery end to end.`,
    ),
    primaryFit: /full-stack typescript/i,
  },
  {
    name: 'full-stack JavaScript title with substantial frontend product work',
    input: vacancy(
      'Senior Software Engineer - Fullstack',
      `Responsibilities
       Architect customer-facing web applications and own frontend architecture.
       Build interfaces with JavaScript, React, Angular, Vue and HTML alongside backend services.`,
    ),
    primaryFit: /full-stack javascript/i,
  },
];

describe('deterministic relevance scoring', () => {
  it('exports a stable scoring version and a separately usable default threshold', () => {
    expect(DETERMINISTIC_SCORING_VERSION).toBe('deterministic-relevance-v11');
    expect(RELEVANCE_THRESHOLD).toBe(70);
    expect(isDeterministicallyRelevant(79, 80)).toBe(false);
    expect(isDeterministicallyRelevant(80, 80)).toBe(true);
  });

  it.each(acceptedCorpus)('accepts $name', ({ input, primaryFit }) => {
    const result = scoreVacancy(input, profile);

    expect(result.relevant).toBe(true);
    expect(result.deterministicScore).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
    expect(result.technicalFit).toBeGreaterThanOrEqual(70);
    expect(result.roleFit).toBeGreaterThanOrEqual(80);
    expect(result.primaryFit).toMatch(primaryFit);
    expect(result.matchingSkills.length).toBeGreaterThan(0);
    expect(result.reasons).toHaveLength(6);
  });

  it('supports a framework-neutral frontend-only profile while excluding full-stack roles', () => {
    const fullStack = scoreVacancy(
      vacancy(
        'Senior Software Engineer - Fullstack',
        `Responsibilities
         Architect customer-facing web applications and own frontend architecture.
         Build interfaces with JavaScript, React, Angular, Vue and HTML alongside backend services.`,
      ),
      frontendOnlyProfile,
    );
    const frameworkNeutralFrontend = scoreVacancy(
      vacancy(
        'Senior Frontend Developer',
        `Responsibilities
         Build accessible browser user interfaces with TypeScript, JavaScript and Web Components.
         Own frontend architecture and design-system quality.`,
      ),
      frontendOnlyProfile,
    );

    expect(fullStack.relevant).toBe(false);
    expect(fullStack.deterministicScore).toBeLessThan(RELEVANCE_THRESHOLD);
    expect(fullStack.gaps).toContain(
      'Excluded primary role family: Full-stack JavaScript with substantial frontend work',
    );
    expect(frameworkNeutralFrontend.relevant).toBe(true);
    expect(frameworkNeutralFrontend.primaryFit).toBe('Frontend / UI engineering');
  });

  it.each([
    {
      name: 'realistic customer-facing full-stack TypeScript product role',
      title: 'Software Engineer, Product Builder',
      description: `About the role
        This is full-stack, customer-facing product engineering.
        What you'll be doing:
        Own features across the full stack, from frontend flows to backend logic.
        What you'll need:
        Experience with TypeScript, React and Node.js.`,
    },
    {
      name: 'realistic full-stack JavaScript role with substantial web UI work',
      title: 'Senior Javascript Developer',
      description: `Job Description
        We run a full stack architecture and build reusable user-facing applications.
        Responsibilities:
        Create maintainable web experiences for millions of end users.
        Qualifications:
        Production knowledge of JavaScript, React, HTML and modern web technologies.`,
    },
  ])('accepts $name without weakening excluded families', ({ title, description }) => {
    const result = scoreVacancy(vacancy(title, description), profile);

    expect(result.relevant).toBe(true);
    expect(result.deterministicScore).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
    expect(result.roleFit).toBeGreaterThanOrEqual(80);
    expect(result.primaryFit).toMatch(/full-stack/i);
  });

  it.each([
    {
      name: 'Java backend mentioning Angular once',
      input: vacancy(
        'Senior Java Backend Developer',
        `Responsibilities
         Build Spring Boot microservices and Java APIs.
         Collaborate with the Angular team that consumes those APIs.`,
      ),
    },
    {
      name: 'manager supervising frontend engineers',
      input: vacancy(
        'Engineering Manager',
        'Lead a team of Angular, React and TypeScript frontend engineers. Own hiring, performance and delivery management.',
      ),
    },
    {
      name: 'QA automation using TypeScript',
      input: vacancy(
        'QA Automation Engineer',
        'Build Playwright and Cypress test automation in TypeScript for our frontend web application.',
      ),
    },
    {
      name: 'data engineering with one React dashboard',
      input: vacancy(
        'Data Engineer',
        'Build Spark data pipelines and warehouse models. Maintain one React dashboard used to inspect jobs.',
      ),
    },
    {
      name: 'embedded engineering using JavaScript tooling',
      input: vacancy(
        'Embedded Software Engineer',
        'Develop C++ firmware for controllers and maintain JavaScript build tooling.',
      ),
    },
    {
      name: 'DevOps maintaining Node build pipelines',
      input: vacancy(
        'DevOps Engineer',
        'Own Kubernetes infrastructure, Terraform and CI pipelines that run Node.js frontend builds.',
      ),
    },
    {
      name: 'backend NestJS work',
      input: vacancy(
        'Backend NestJS Engineer',
        'Design NestJS microservices, PostgreSQL schemas and backend APIs for other teams.',
      ),
    },
    {
      name: 'backend-dominant full-stack title with a small internal React screen',
      input: vacancy(
        'Senior Full Stack Engineer',
        `Responsibilities
         Build Java and Spring Boot microservices, Kafka integrations, database systems, backend architecture and operations.
         Requirements
         Deep Java, Spring, Kafka and PostgreSQL experience. TypeScript and React are used for a small internal admin screen.`,
      ),
    },
    {
      name: 'product design rather than UI engineering',
      input: vacancy(
        'Product Designer',
        'Create accessible UI designs and design-system specifications. Collaborate with React engineers.',
      ),
    },
    {
      name: 'technical support',
      input: vacancy(
        'Technical Support Engineer',
        'Troubleshoot customer Angular applications and explain TypeScript configuration issues.',
      ),
    },
    {
      name: 'implementation consulting despite frontend-stack language',
      input: vacancy(
        'Implementation Consultant',
        'Implement Angular and TypeScript applications, React interfaces and customer design systems.',
      ),
    },
    {
      name: 'product ownership despite a frontend platform qualifier',
      input: vacancy(
        'Technical Product Owner - Frontend Platform',
        'Own the Angular and TypeScript frontend platform roadmap, backlog and design-system priorities.',
      ),
    },
    {
      name: 'customer-success management despite frontend-stack language',
      input: vacancy(
        'Customer Success Manager',
        'Guide customers using Angular, TypeScript and React applications and our design system.',
      ),
    },
  ])('rejects $name', ({ input }) => {
    const result = scoreVacancy(input, profile);
    expect(result.relevant).toBe(false);
    expect(result.deterministicScore).toBeLessThan(RELEVANCE_THRESHOLD);
  });

  it('does not reward keyword stuffing or repeated mentions', () => {
    const keywords = 'Angular TypeScript React JavaScript UI frontend web application design system RxJS NgRx';
    const oneCopy = scoreVacancy(
      vacancy(
        'Senior Java Backend Developer',
        `Build Java and Spring backend microservices. Technology index: ${keywords}.`,
      ),
      profile,
    );
    const stuffed = scoreVacancy(
      vacancy(
        'Senior Java Backend Developer',
        `Build Java and Spring backend microservices. Technology index: ${Array.from({ length: 20 }, () => keywords).join(' ')}`,
      ),
      profile,
    );

    expect(stuffed.deterministicScore).toBe(oneCopy.deterministicScore);
    expect(stuffed.deterministicScore).toBeLessThan(RELEVANCE_THRESHOLD);
    expect(stuffed.reasons.join(' ')).toContain('counted once');
  });

  it('rejects generic-title Java backend responsibilities despite a stuffed frontend technology index', () => {
    const result = scoreVacancy(
      vacancy(
        'Software Engineer',
        `Responsibilities
         Build Java and Spring Boot backend microservices and Kafka integrations.
         Technology index: Angular TypeScript React JavaScript UI frontend web application design system RxJS NgRx.`,
      ),
      profile,
    );

    expect(result.primaryFit).toBe('Backend engineering');
    expect(result.deterministicScore).toBeLessThan(RELEVANCE_THRESHOLD);
    expect(result.relevant).toBe(false);
  });

  it('does not treat collaboration with an Angular team as primary frontend responsibility', () => {
    const result = scoreVacancy(
      vacancy(
        'Software Engineer',
        'Build Java services and database integrations. You will collaborate with the Angular frontend team.',
      ),
      profile,
    );

    expect(result.relevant).toBe(false);
    expect(result.roleFit).toBeLessThan(70);
  });

  it('keeps the explicitly requested Angular and Electron generic-title edge case', () => {
    const result = scoreVacancy(
      vacancy(
        'Software Developer',
        `Responsibilities
         Build the product with Angular and Electron.
         Requirements
         Strong Angular and Electron experience.`,
      ),
      profile,
    );

    expect(result.relevant).toBe(true);
    expect(result.primaryFit).toMatch(/frontend/i);
  });
});

describe('Dutch-language requirement detection', () => {
  it.each([
    'Fluent Dutch required',
    'Professional Dutch is mandatory for this role',
    'Nederlands vereist',
    'Vloeiend Nederlands',
    'C1 Dutch',
    'You must communicate professionally in Dutch',
    'Native Dutch required',
    'Goede beheersing van de Nederlandse taal',
    'Fluency in business English and Dutch',
    'Fluency in Dutch and English, any other European language is a plus!',
    'Je spreekt Nederlands in woord en geschrift; dit is een essentiële vereiste!',
    'Uitstekende communicatieve vaardigheden in het Nederlands',
    'Je schrijft en spreekt foutloos Nederlands',
    'Effectieve communicatieve vaardigheden in het Nederlands en Engels',
    'Excellent command of Dutch and English',
    'Business proficiency in Dutch and English',
    'Working languages are English and Dutch',
  ])('detects a mandatory requirement: %s', (languageLine) => {
    const input = vacancy(
      'Senior Frontend Engineer',
      `Build Angular and TypeScript web applications and own the UI design system. Requirements: ${languageLine}.`,
    );
    const detection = detectDutchRequirement(input);
    const result = scoreVacancy(input, profile);

    expect(detection.dutchRequired).toBe(true);
    expect(detection.dutchPreferred).toBe(false);
    expect(detection.evidence).toEqual([expect.stringContaining(languageLine)]);
    expect(result.dutchRequired).toBe(true);
    expect(result.languageFit).toBe(0);
    expect(result.relevant).toBe(false);
    expect(result.deterministicScore).toBeLessThan(RELEVANCE_THRESHOLD);
  });

  it.each([
    'Dutch preferred',
    'Dutch is a plus',
    'Dutch is nice to have',
    'Dutch is optional',
    'Nederlands is een pre',
    'No Dutch required',
    'Dutch fluency is a plus',
    'Fluency in Dutch or French is a strong advantage',
    'Business proficiency in Dutch is preferred',
  ])('keeps an optional or preferred requirement: %s', (languageLine) => {
    const input = vacancy(
      'Senior Frontend Engineer',
      `Build Angular and TypeScript web applications and own the UI design system. Nice to have: ${languageLine}.`,
    );
    const result = scoreVacancy(input, profile);

    expect(result.dutchRequired).toBe(false);
    expect(result.dutchPreferred).toBe(true);
    expect(result.languageEvidence).toEqual([expect.stringContaining(languageLine)]);
    expect(result.languageFit).toBe(90);
    expect(result.relevant).toBe(true);
  });

  it('does not infer a requirement merely from Dutch-language site content', () => {
    const input = vacancy(
      'Senior Frontend Engineer',
      'Je werkt in een Nederlands team. Bouw Angular en TypeScript web applications voor onze gebruikers.',
    );
    expect(detectDutchRequirement(input)).toEqual({
      dutchRequired: false,
      dutchPreferred: false,
      evidence: [],
    });
  });

  it('does not attach an English proficiency qualifier to a later Dutch team reference', () => {
    const input = vacancy(
      'Senior Frontend Engineer',
      'You are a native English speaker working in a Dutch product team. Build Angular web applications.',
    );
    expect(detectDutchRequirement(input).dutchRequired).toBe(false);
  });

  it.each([
    'Our customers have excellent command of Dutch and English.',
    'The customer support team has business proficiency in Dutch and English.',
    'We build products for teams whose working languages are English and Dutch.',
  ])('does not treat another party\'s Dutch capability as a candidate requirement: %s', (languageLine) => {
    const input = vacancy(
      'Senior Frontend Engineer',
      `Build Angular and TypeScript web applications and own the UI design system. ${languageLine}`,
    );
    const result = scoreVacancy(input, profile);

    expect(detectDutchRequirement(input)).toEqual({
      dutchRequired: false,
      dutchPreferred: false,
      evidence: [],
    });
    expect(result.dutchRequired).toBe(false);
    expect(result.relevant).toBe(true);
  });

  it.each([
    'Our clients require fluent Dutch from every consultant.',
    'The team requires professional Dutch for this position.',
    'Our customers need native Dutch from the engineer.',
  ])('keeps an explicit candidate requirement even when a client or team is the grammatical subject: %s', (languageLine) => {
    const input = vacancy(
      'Senior Frontend Engineer',
      `Requirements\n${languageLine}\nAngular and TypeScript experience.`,
    );

    expect(detectDutchRequirement(input)).toMatchObject({
      dutchRequired: true,
      dutchPreferred: false,
    });
    expect(scoreVacancy(input, profile).relevant).toBe(false);
  });

  it.each([
    'Je beheerst Nederlands',
    'Beheersing van de Nederlandse taal',
    'Goede mondelinge en schriftelijke beheersing van Nederlands',
    'You have an excellent command of both English and Dutch',
    'Dutch is essential',
    'Dutch is needed',
    'Dutch is a prerequisite',
    'The role requires Dutch and English',
    'We require Dutch and English',
    'Dutch at B1 level',
    'Kennis van de Nederlandse taal',
    'Goede mondelinge en schriftelijke vaardigheden in het Nederlands',
    'Minimum B1 Dutch',
  ])('detects an unambiguous requirement phrasing: %s', (languageLine) => {
    const input = vacancy(
      'Senior Frontend Engineer',
      `Requirements\n${languageLine}.\nAngular and TypeScript experience.`,
    );

    expect(detectDutchRequirement(input)).toMatchObject({
      dutchRequired: true,
      dutchPreferred: false,
    });
    expect(scoreVacancy(input, profile).relevant).toBe(false);
  });

  it('treats a Nederlandstalige role title as mandatory language evidence', () => {
    const input = vacancy(
      'Nederlandstalige Frontend Developer',
      'Build Angular and TypeScript customer-facing web applications.',
    );
    expect(detectDutchRequirement(input)).toEqual({
      dutchRequired: true,
      dutchPreferred: false,
      evidence: ['Nederlandstalige Frontend Developer'],
    });
  });

  it('treats an explicit language capability under Requirements as mandatory', () => {
    const input = vacancy(
      'Senior Frontend Engineer',
      `Requirements
       Dutch language proficiency
       Angular and TypeScript experience`,
    );
    expect(detectDutchRequirement(input)).toMatchObject({
      dutchRequired: true,
      dutchPreferred: false,
    });
  });

  it('treats Dutch-speaking role titles as mandatory language evidence', () => {
    const input = vacancy(
      'Senior Frontend Engineer – Dutch speaking',
      'Build Angular and TypeScript customer-facing web applications.',
    );
    expect(detectDutchRequirement(input)).toEqual({
      dutchRequired: true,
      dutchPreferred: false,
      evidence: ['Senior Frontend Engineer – Dutch speaking'],
    });
  });

  it('recognizes preferable as a non-mandatory Dutch qualifier', () => {
    const input = vacancy(
      'Senior Frontend Engineer',
      'Build Angular applications. Proficiency in Dutch is preferable.',
    );
    expect(detectDutchRequirement(input)).toMatchObject({
      dutchRequired: false,
      dutchPreferred: true,
    });
  });
});

describe('seniority and location dimensions', () => {
  it.each([
    {
      title: 'Medior Frontend Engineer',
      description: 'Build Angular and TypeScript UI components for our web application and design system.',
    },
    {
      title: 'Frontend Engineer',
      description: 'Build Angular and TypeScript UI components for our web application. We ask for 3–5 years experience.',
    },
  ])('keeps a strong match despite lower advertised seniority', ({ title, description }) => {
    const result = scoreVacancy(vacancy(title, description), profile);
    expect(result.seniorityFit).toBe(65);
    expect(result.gaps).toContain('Advertised seniority is below the candidate’s experience');
    expect(result.relevant).toBe(true);
  });

  it('reduces seniority for a mid-level description even when the generic title omits it', () => {
    const result = scoreVacancy(
      vacancy(
        'Software Engineer',
        'This is a mid-level role. Build Angular and TypeScript UI for our frontend web application.',
      ),
      profile,
    );
    expect(result.seniorityFit).toBe(65);
    expect(result.relevant).toBe(true);
  });

  it('does not treat a company-history claim as required candidate experience', () => {
    const result = scoreVacancy(
      vacancy(
        'Frontend Developer',
        'Backed by 15 years of experience, we serve global customers. Build Angular and TypeScript UI for our web application.',
      ),
      profile,
    );

    expect(result.seniorityFit).toBe(90);
    expect(result.reasons.join(' ')).not.toContain('15+ years');
    expect(result.relevant).toBe(true);
  });

  it('does not treat a recurring sabbatical benefit as required candidate experience', () => {
    const result = scoreVacancy(
      vacancy(
        'Frontend Engineer',
        'Build Angular and TypeScript UI. The opportunity to take an unpaid 3-month sabbatical every 3 years.',
      ),
      profile,
    );

    expect(result.seniorityFit).toBe(90);
    expect(result.relevant).toBe(true);
  });

  it.each([
    {
      name: 'Netherlands office',
      location: 'Utrecht, Netherlands',
      remote: false,
      expected: 100,
    },
    {
      name: 'remote Netherlands',
      location: 'Remote - Netherlands',
      remote: true,
      expected: 100,
    },
    {
      name: 'remote EU',
      location: 'Remote within EU',
      remote: true,
      expected: 85,
    },
  ])('handles $name location eligibility', ({ location, remote, expected }) => {
    const result = scoreVacancy(
      vacancy(
        'Software Engineer',
        'Build Angular and TypeScript UI components for a frontend web application and design system.',
        { location, remote },
      ),
      profile,
    );
    expect(result.locationFit).toBe(expected);
    expect(result.relevant).toBe(true);
  });

  it('does not pass a known foreign on-site location despite an otherwise excellent match', () => {
    const result = scoreVacancy(
      vacancy(
        'Senior Angular Developer',
        'Build Angular and TypeScript UI components for our frontend web application and design system.',
        { location: 'Berlin, Germany', remote: false },
      ),
      profile,
    );
    expect(result.locationFit).toBe(20);
    expect(result.deterministicScore).toBe(69);
    expect(result.relevant).toBe(false);
  });

  it.each([
    'This role is only available in Germany, France, or Spain; we cannot employ in the Netherlands.',
    'Netherlands-based employment is not supported.',
    'This remote role is available across EMEA, excluding the Netherlands.',
  ])('rejects explicit Netherlands-employment exclusions: %s', (exclusion) => {
    const result = scoreVacancy(
      vacancy(
        'Senior Angular Developer',
        `Build Angular and TypeScript UI components for our frontend web application and design system. ${exclusion}`,
        { location: 'Remote, Europe', remote: true },
      ),
      profile,
    );

    expect(result.locationFit).toBe(0);
    expect(result.deterministicScore).toBeLessThan(RELEVANCE_THRESHOLD);
    expect(result.relevant).toBe(false);
    expect(result.gaps).toContain('Netherlands employment location is not established');
  });

  it.each([
    'We employ candidates in the Netherlands.',
    'Netherlands-based employment is supported.',
    'We cannot employ outside the Netherlands.',
  ])('does not confuse positive Netherlands support with an exclusion: %s', (support) => {
    const result = scoreVacancy(
      vacancy(
        'Senior Angular Developer',
        `Build Angular and TypeScript UI components for our frontend web application and design system. ${support}`,
        { location: 'Remote - Netherlands', remote: true },
      ),
      profile,
    );

    expect(result.locationFit).toBe(100);
    expect(result.relevant).toBe(true);
  });
});

describe('Netherlands salary gate', () => {
  it.each([
    ['monthly salary', 'Base salary: €6.000 - €7.500 gross per month.'],
    ['annual salary', 'Annual base salary: EUR 72,000 - EUR 90,000 per year.'],
  ])('accepts a qualifying %s', (_name, salaryText) => {
    const result = scoreVacancy(
      vacancy(
        'Senior Angular Developer',
        `Build Angular and TypeScript UI for our frontend web application. ${salaryText}`,
      ),
      profile,
    );

    expect(result.relevant).toBe(true);
    expect(result.reasons.join(' ')).toContain('Salary gate: Advertised EUR base floor is at least €6,000 per month.');
  });

  it('rejects an explicitly sub-threshold EUR base salary', () => {
    const result = scoreVacancy(
      vacancy(
        'Senior Angular Developer',
        'Build Angular and TypeScript UI. Base salary: €5,999 gross per month.',
      ),
      profile,
    );

    expect(result.deterministicScore).toBeLessThan(RELEVANCE_THRESHOLD);
    expect(result.relevant).toBe(false);
    expect(result.gaps).toContain('Advertised EUR base salary is below the configured minimum');
  });

  it.each([
    'Build Angular and TypeScript UI. Salary is competitive.',
    'Build Angular and TypeScript UI. Annual base salary is $120,000 USD.',
  ])('keeps an undisclosed or non-EUR salary eligible for review: %s', (description) => {
    const result = scoreVacancy(
      vacancy('Senior Angular Developer', description, { description }),
      profile,
    );

    expect(result.deterministicScore).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
    expect(result.relevant).toBe(true);
    expect(result.gaps).toContain('Minimum EUR base salary is not advertised');
    expect(result.reasons).toContain(
      'No salary eligibility cap applied because vacancies with undisclosed salary remain reviewable.',
    );
  });
});

describe('plainText (CodeQL js/double-escaping regression)', () => {
  it('decodes a single-escaped entity normally', () => {
    expect(plainText('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(plainText('5 &lt; 10')).toBe('5 &lt; 10'); // &lt; isn't in the decode list; left as-is on purpose
  });

  it('does not double-decode an entity that was already escaped in the source', () => {
    // `&amp;quot;` in source HTML displays the literal text `&quot;` on the page (the `&` was
    // escaped so the browser doesn't try to parse `&quot;` as an entity). Decoding this in two
    // independent passes turns it all the way into `"`, one level of decoding too far, which is
    // exactly what CodeQL's double-escaping query flags. A single pass must stop at `&quot;`.
    expect(plainText('&amp;quot;Angular&amp;quot; developer wanted')).toBe(
      '&quot;Angular&quot; developer wanted',
    );
  });

  it('still fully decodes entities that were only escaped once', () => {
    expect(plainText('&quot;Angular&quot; developer wanted')).toBe('"Angular" developer wanted');
  });

  it('handles every supported entity, including numeric forms, in one pass', () => {
    expect(plainText('A&nbsp;B&#160;C&quot;D&#34;E&#39;F&apos;G')).toBe("A B C\"D\"E'F'G");
  });
});
