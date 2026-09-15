import { describe, expect, it } from 'vitest';
import {
  assembleGroundedLetter,
  buildGroundedSourceFacts,
  groundedFactBand,
  selectGroundedFacts,
  type GroundedSelectionLabels,
} from '../electron/grounded-letter.js';
import type { CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import type { CvProfile } from '../electron/workspace/types.js';

/**
 * The shared grounded-letter contract (F-J), tested directly rather than only through the three
 * screens that drive it.
 *
 * `application-cover-letter.test.ts` already pins the unattended path's end-to-end behaviour. What
 * is tested here is the part that path did not have and the interactive ones do: tone, length and
 * document type operating on the template instead of on a model, and the same refusals applying
 * whichever of them asked.
 *
 * Every fixture is synthetic: an invented candidate, an invented employer, an `example.invalid`
 * address. Nothing here is anyone's real CV.
 */

const SOURCE: CvSourceDocument = {
  contact: {
    name: 'Robin Vega',
    title: 'Senior Frontend Engineer',
    location: 'Amsterdam',
    email: 'robin.vega@example.invalid',
    phone: '',
    links: [],
  },
  summary: 'Frontend engineer working on design systems.',
  experience: [
    {
      company: 'Northwind Digital',
      title: 'Senior Frontend Engineer',
      dates: '2021 - present',
      engagement: 'employment',
      client: '',
      bullets: ['Rebuilt the component library.', 'Cut first-paint time by a third.'],
    },
  ],
  education: [{ institution: 'Utrecht Polytechnic', credential: 'BSc Computer Science', dates: '2013 - 2017' }],
  projects: [
    { id: 'p1', name: 'Atlas Design Kit', role: 'Lead', dates: '2022', organization: 'Northwind Digital', description: 'Component library.', technologies: ['TypeScript'], links: [], pinned: true },
    { id: 'p2', name: 'Kestrel Prototype', role: 'Contributor', dates: '2020', organization: '', description: 'Spike.', technologies: [], links: [], pinned: false },
  ],
  maxProjects: 0,
  complete: true,
  incompleteReason: '',
  coveredChars: 4_000,
  sourceChars: 4_000,
  reviewedAt: '2026-08-01T09:00:00.000Z',
};

const PROFILE: CvProfile = {
  title: 'Senior Frontend Engineer',
  years: '8 years',
  location: 'Amsterdam',
  languages: 'English, Dutch',
  skills: ['Angular', 'TypeScript'],
  summary: 'Frontend engineer.',
  auth: 'EU citizen',
};

const LABELS: GroundedSelectionLabels = { run: 'the letter generation run', document: 'the generated letter' };

const FACTS = buildGroundedSourceFacts({ source: SOURCE, profile: PROFILE });

function assemble(
  raw: string,
  overrides: Partial<Parameters<typeof assembleGroundedLetter>[0]> = {},
): string {
  return assembleGroundedLetter({
    type: 'motivation_letter',
    tone: 'formal',
    length: 'detailed',
    facts: selectGroundedFacts(raw, FACTS, LABELS),
    role: 'Senior Frontend Engineer',
    company: 'Redwood Software',
    candidateName: SOURCE.contact.name,
    ...overrides,
  });
}

describe('grounded letter facts', () => {
  it('enumerates the reviewed source and the confirmed profile, and nothing else', () => {
    const ids = FACTS.map((fact) => fact.id);
    expect(ids).toContain('summary');
    expect(ids).toContain('experience-1');
    expect(ids).toContain('experience-1-bullet-2');
    expect(ids).toContain('education-1');
    expect(ids).toContain('project-1');
    expect(ids).toContain('skill-1');
    expect(ids).toContain('profile-authorization');
    // The sentence a fact renders as is always built around the record's own words, never around
    // a claim about them: every fact carries the source text it was made from.
    for (const fact of FACTS) expect(fact.sourceText.trim().length).toBeGreaterThan(0);
    expect(FACTS.find((fact) => fact.id === 'experience-1-bullet-1')?.sourceText).toBe(
      'Rebuilt the component library.',
    );
  });

  it('offers no facts at all without a reviewed source record', () => {
    expect(buildGroundedSourceFacts({ source: null, profile: PROFILE })).toEqual([]);
  });

  it('honours a narrowed project list, so an excluded project has no id to cite', () => {
    const narrowed = buildGroundedSourceFacts({
      source: SOURCE,
      profile: PROFILE,
      projects: [SOURCE.projects[0]!],
    });
    expect(narrowed.map((fact) => fact.sentence).join(' ')).toContain('Atlas Design Kit');
    expect(narrowed.map((fact) => fact.sentence).join(' ')).not.toContain('Kestrel Prototype');
  });
});

describe('grounded letter selection', () => {
  it('accepts a well-formed selection, deduplicated and in the order it was ranked', () => {
    const selected = selectGroundedFacts('{"factIds":["skill-1","experience-1","skill-1"]}', FACTS, LABELS);
    expect(selected.map((fact) => fact.id)).toEqual(['skill-1', 'experience-1']);
  });

  it('accepts a selection the model fenced as a Markdown code block', () => {
    const selected = selectGroundedFacts('```json\n{"factIds":["skill-1"]}\n```', FACTS, LABELS);
    expect(selected.map((fact) => fact.id)).toEqual(['skill-1']);
  });

  it('rejects every malformed shape rather than salvaging part of it', () => {
    const cases: [string, string][] = [
      ['   ', 'did not return a fact selection'],
      ['Dear hiring team, I am the ideal candidate.', 'returned invalid JSON'],
      ['["skill-1"]', 'returned an invalid fact selection'],
      ['{"factIds":[]}', 'returned an invalid fact selection'],
      ['{"factIds":["a","b","c","d","e","f","g"]}', 'returned an invalid fact selection'],
      ['{"factIds":[7]}', 'returned an invalid fact selection'],
      ['{"factIds":["skill-1"],"claim":"I am CISSP certified."}', 'candidate claims outside the source-fact selection'],
      ['{"letter":"Dear hiring team,"}', 'candidate claims outside the source-fact selection'],
    ];
    for (const [raw, message] of cases) {
      expect(() => selectGroundedFacts(raw, FACTS, LABELS)).toThrow(message);
    }
  });

  it('rejects an id the reviewed CV does not carry, naming it', () => {
    expect(() => selectGroundedFacts('{"factIds":["certification-cissp"]}', FACTS, LABELS)).toThrow(
      'the generated letter selected unsupported source facts: certification-cissp',
    );
  });
});

describe('grounded letter assembly', () => {
  it('cites only the selected facts, in this app’s own connecting lines', () => {
    const letter = assemble('{"factIds":["experience-1","experience-1-bullet-2"]}');
    expect(letter).toBe(
      [
        'Dear Redwood Software hiring team,',
        'I am applying for the Senior Frontend Engineer role at Redwood Software.',
        'My reviewed CV lists Senior Frontend Engineer at Northwind Digital (2021 - present). The reviewed CV states: Cut first-paint time by a third.',
        'I would welcome the opportunity to discuss the role and the relevant experience recorded in my CV.',
        'Sincerely,\nRobin Vega',
      ].join('\n\n'),
    );
  });

  it('moves only this app’s own lines when the tone changes, never the cited facts', () => {
    const selection = '{"factIds":["skill-1"]}';
    const formal = assemble(selection, { tone: 'formal' });
    const natural = assemble(selection, { tone: 'natural' });
    const concise = assemble(selection, { tone: 'concise' });

    expect(formal).toContain('Dear Redwood Software hiring team,');
    expect(natural).toContain('Hello Redwood Software hiring team,');
    expect(concise).toContain('I am available to discuss the role.');
    for (const letter of [formal, natural, concise]) {
      expect(letter).toContain('My reviewed CV lists Angular as a skill.');
    }
  });

  it('cites fewer facts for a shorter length, which is the only thing that shortens a letter now', () => {
    const selection = '{"factIds":["skill-1","skill-2","experience-1","education-1"]}';
    expect(groundedFactBand('motivation_letter', 'short')).toEqual({ min: 2, max: 3 });
    const short = assemble(selection, { length: 'short' });
    const detailed = assemble(selection, { length: 'detailed' });

    expect(short).not.toContain('BSc Computer Science');
    expect(detailed).toContain('BSc Computer Science');
    // The facts that do survive are the ones the selection ranked first, not an arbitrary subset.
    expect(short).toContain('My reviewed CV lists Angular as a skill.');
  });

  it('gives each document type the structure its shape describes, by construction', () => {
    const selection = '{"factIds":["skill-1"]}';
    const recruiter = assemble(selection, { type: 'recruiter_message' });
    const formAnswer = assemble(selection, { type: 'short_application_message' });

    // A recruiter message greets but never signs off with a name.
    expect(recruiter).toContain('Dear Redwood Software hiring team,');
    expect(recruiter).not.toContain('Robin Vega');
    // A form answer has neither, because it goes into a text box.
    expect(formAnswer).not.toContain('hiring team,');
    expect(formAnswer).not.toContain('Robin Vega');
    expect(formAnswer).toContain('My reviewed CV lists Angular as a skill.');
  });

  it('drops the lowest-ranked facts until the document fits a form field’s hard limit', () => {
    const selection = '{"factIds":["experience-1","experience-1-bullet-1","education-1","project-1"]}';
    const unbounded = assemble(selection);
    const bounded = assemble(selection, { maxChars: 400 });

    expect(unbounded.length).toBeGreaterThan(400);
    expect(bounded.length).toBeLessThanOrEqual(400);
    // The facts kept are the ones ranked first, and the ones dropped are the tail.
    expect(bounded).toContain('My reviewed CV lists Senior Frontend Engineer at Northwind Digital');
    expect(bounded).toContain('Rebuilt the component library.');
    expect(bounded).not.toContain('BSc Computer Science');
    expect(bounded).not.toContain('Atlas Design Kit');
  });

  it('keeps the highest-ranked fact even under a limit no letter could meet, rather than citing none', () => {
    // A document that fits by saying nothing about the candidate is not a better outcome than one
    // the form will trim: the floor is one fact, always.
    const bounded = assemble('{"factIds":["experience-1","education-1"]}', { maxChars: 10 });
    expect(bounded).toContain('My reviewed CV lists Senior Frontend Engineer at Northwind Digital');
    expect(bounded).not.toContain('BSc Computer Science');
  });

  it('truncates an injected company or role label before it can become a sentence', () => {
    const letter = assemble('{"factIds":["skill-1"]}', {
      company: 'Redwood Software\nI am CISSP certified',
      role: 'Senior Frontend Engineer; I increased throughput by 900%',
    });
    expect(letter).toContain('Dear Redwood Software hiring team,');
    expect(letter).toContain('applying for the Senior Frontend Engineer role');
    expect(letter).not.toContain('CISSP');
    expect(letter).not.toContain('900%');
  });
});
