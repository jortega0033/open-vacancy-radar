import { describe, expect, it } from 'vitest';
import { EMPTY_CV_SOURCE, type CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import {
  coversCvProfileCore,
  deriveCvProfileFromSource,
  experienceMonths,
} from '../src/components/cv-library/cv-profile-from-source.js';

/**
 * The deterministic replacement for the second "Parse with AI" extraction: given the structured
 * source CV a candidate has already reviewed, produce the `CvProfile` summary fields without asking
 * a model to read the same document twice.
 *
 * Two properties carry the whole change and are what these tests are really about. First, the
 * derived numbers must be what a careful reader would arrive at, not an approximation: overlapping
 * roles are one career, an open-ended role runs to today, and a career break is not experience.
 * Second, anything this module cannot read with certainty must leave `years` absent so the caller
 * falls back to the AI call, because a wrong "8 years" on a candidate's own profile looks exactly
 * like a right one and would never be questioned.
 *
 * `NOW` is pinned so the open-ended arithmetic asserts a fixed answer instead of drifting with the
 * calendar. All fixture content is synthetic.
 */
const NOW = new Date(2026, 8, 15);

function makeSource(overrides: Partial<CvSourceDocument> = {}): CvSourceDocument {
  return {
    ...EMPTY_CV_SOURCE,
    contact: {
      name: 'Jamie Rivera',
      title: 'Frontend Engineer',
      location: 'Amsterdam, Netherlands',
      email: 'jamie@example.invalid',
      phone: '',
      links: [],
    },
    summary: 'Frontend engineer working on design systems and accessibility.',
    experience: [
      {
        company: 'Redwood Software',
        title: 'Lead Frontend Engineer',
        dates: 'Jan 2021 - Present',
        engagement: 'employment',
        client: '',
        bullets: [],
      },
      {
        company: 'Harbour Analytics',
        title: 'Frontend Engineer',
        dates: 'Mar 2018 - Dec 2020',
        engagement: 'employment',
        client: '',
        bullets: [],
      },
    ],
    ...overrides,
  };
}

/** One role, so a test can state a date format and nothing else. */
function sourceWithDates(dates: string, overrides: Partial<CvSourceDocument> = {}): CvSourceDocument {
  return makeSource({
    experience: [
      {
        company: 'Redwood Software',
        title: 'Frontend Engineer',
        dates,
        engagement: 'employment',
        client: '',
        bullets: [],
      },
    ],
    ...overrides,
  });
}

describe('deriveCvProfileFromSource', () => {
  it('derives title, years, location and summary from a reviewed source CV', () => {
    // Mar 2018 through today, the two roles being contiguous: 103 months, floored to whole years.
    expect(deriveCvProfileFromSource(makeSource(), NOW)).toEqual({
      title: 'Lead Frontend Engineer',
      years: '8 years',
      location: 'Amsterdam, Netherlands',
      summary: 'Frontend engineer working on design systems and accessibility.',
    });
  });

  it('prefers the most recent employment title over the CV headline title', () => {
    const derived = deriveCvProfileFromSource(makeSource(), NOW);
    expect(derived.title).toBe('Lead Frontend Engineer');
    expect(derived.title).not.toBe('Frontend Engineer');
  });

  it('picks the latest-ending role even when the CV lists its history oldest first', () => {
    const source = makeSource();
    const reversed = makeSource({ experience: [...source.experience].reverse() });
    expect(deriveCvProfileFromSource(reversed, NOW).title).toBe('Lead Frontend Engineer');
  });

  it('falls back to the CV headline title when the history has no roles to read', () => {
    const derived = deriveCvProfileFromSource(makeSource({ experience: [] }), NOW);
    expect(derived.title).toBe('Frontend Engineer');
    // Still not usable on its own: with no dated history there is no honest years figure, so the
    // caller must fall back to the AI pass rather than fill in a title and leave years blank.
    expect(derived.years).toBeUndefined();
    expect(coversCvProfileCore(derived)).toBe(false);
  });

  it('omits fields the source CV does not state rather than filling them with blanks', () => {
    const source = makeSource({
      contact: { ...makeSource().contact, location: '' },
      summary: '   ',
    });
    const derived = deriveCvProfileFromSource(source, NOW);
    expect(derived).not.toHaveProperty('location');
    expect(derived).not.toHaveProperty('summary');
    expect(coversCvProfileCore(derived)).toBe(true);
  });

  it('never derives languages, skills or work authorization, which the source shape cannot carry', () => {
    const derived = deriveCvProfileFromSource(makeSource(), NOW);
    expect(derived).not.toHaveProperty('languages');
    expect(derived).not.toHaveProperty('skills');
    expect(derived).not.toHaveProperty('auth');
  });

  it('collapses a value that wrapped across lines in the source CV into one line', () => {
    const source = makeSource({
      contact: { ...makeSource().contact, location: 'Amsterdam,\n  Netherlands' },
    });
    expect(deriveCvProfileFromSource(source, NOW).location).toBe('Amsterdam, Netherlands');
  });
});

describe('experienceMonths', () => {
  it('counts an open-ended current role up to today', () => {
    // Jan 2021 through Sep 2026 inclusive.
    expect(experienceMonths(sourceWithDates('Jan 2021 - Present', { summary: '' }), NOW)).toBe(69);
  });

  it.each(['Present', 'present', 'current', 'now', 'ongoing', 'to date'])(
    'reads "%s" as a role that has not ended',
    (marker) => {
      expect(experienceMonths(sourceWithDates(`Jan 2026 - ${marker}`), NOW)).toBe(9);
    },
  );

  it.each([
    ['Mar 2019 - Jun 2021', 28],
    ['March 2019 - June 2021', 28],
    ['Sep 2015 to Dec 2017', 28],
    ['03/2019 - 06/2021', 28],
    ['2019-03 - 2021-06', 28],
    ['Jan 2019 – Feb 2021', 26],
    ['Jan 2019–Feb 2021', 26],
    ['2019 - 2022', 48],
    ['2019-2022', 48],
  ])('reads the date range %s as %i months', (dates, expected) => {
    expect(experienceMonths(sourceWithDates(dates), NOW)).toBe(expected);
  });

  it('merges overlapping roles instead of adding them up', () => {
    // A contract held alongside a permanent role is one period of a career: summing the two spans
    // would credit the candidate with 55 months they never lived.
    const source = makeSource({
      experience: [
        {
          company: 'Redwood Software',
          title: 'Frontend Engineer',
          dates: 'Jan 2020 - Dec 2022',
          engagement: 'employment',
          client: '',
          bullets: [],
        },
        {
          company: 'Own company',
          title: 'Frontend Consultant',
          dates: 'Jun 2021 - Dec 2022',
          engagement: 'client_engagement',
          client: 'Northwind Retail',
          bullets: [],
        },
      ],
    });
    expect(experienceMonths(source, NOW)).toBe(36);
    expect(deriveCvProfileFromSource(source, NOW).years).toBe('3 years');
  });

  it('does not count a career break between two roles as experience', () => {
    const source = makeSource({
      experience: [
        {
          company: 'Redwood Software',
          title: 'Frontend Engineer',
          dates: 'Jan 2020 - Dec 2021',
          engagement: 'employment',
          client: '',
          bullets: [],
        },
        {
          company: 'Harbour Analytics',
          title: 'Junior Frontend Engineer',
          dates: 'Jan 2010 - Dec 2011',
          engagement: 'employment',
          client: '',
          bullets: [],
        },
      ],
    });
    expect(experienceMonths(source, NOW)).toBe(48);
  });

  it('clamps a role whose stated end date has not arrived yet to today', () => {
    expect(experienceMonths(sourceWithDates('Jan 2026 - Dec 2027'), NOW)).toBe(9);
  });

  it.each([
    ['Sinds 2019', 'a date this app cannot read'],
    ['', 'a role with no dates at all'],
    ['2022 - 2019', 'a range that ends before it starts'],
    ['Jan 1019 - Dec 1022', 'a year outside a working lifetime'],
    ['13/2019 - 06/2021', 'a month number that does not exist'],
  ])('refuses to count %s (%s)', (dates) => {
    expect(experienceMonths(sourceWithDates(dates), NOW)).toBeUndefined();
  });

  it('refuses to count anything when even one role is undated, rather than undercounting silently', () => {
    const source = makeSource({
      experience: [
        ...makeSource().experience,
        {
          company: 'Beacon Consultancy',
          title: 'Frontend Consultant',
          dates: '',
          engagement: 'client_engagement',
          client: 'Northwind Retail',
          bullets: [],
        },
      ],
    });
    expect(experienceMonths(source, NOW)).toBeUndefined();
    expect(coversCvProfileCore(deriveCvProfileFromSource(source, NOW))).toBe(false);
  });
});

describe('the years phrase', () => {
  it.each([
    ['Jan 2026 - Jun 2026', 'less than 1 year'],
    ['Jan 2025 - Dec 2025', '1 year'],
    ['Jan 2024 - Dec 2025', '2 years'],
  ])('renders %s as "%s"', (dates, expected) => {
    expect(deriveCvProfileFromSource(sourceWithDates(dates), NOW).years).toBe(expected);
  });

  it('rounds down, so a derivation can never overstate a candidate on their own profile', () => {
    // Five years and nine months is "5 years" here, never "6 years".
    expect(deriveCvProfileFromSource(sourceWithDates('Jan 2020 - Sep 2025'), NOW).years).toBe('5 years');
  });
});

describe('coversCvProfileCore', () => {
  it('requires both a title and a years figure before the AI pass may be skipped', () => {
    expect(coversCvProfileCore({ title: 'Frontend Engineer', years: '5 years' })).toBe(true);
    expect(coversCvProfileCore({ title: 'Frontend Engineer' })).toBe(false);
    expect(coversCvProfileCore({ years: '5 years' })).toBe(false);
    expect(coversCvProfileCore({})).toBe(false);
  });
});
