import { describe, expect, it } from 'vitest';
import { detectWorkArrangement, isOnsiteOrHybrid } from '../../src/global-remote/work-arrangement.js';

const detect = (description: string, title = 'Engineer', location: string | null = null) =>
  detectWorkArrangement({ title, location, description });

describe('detectWorkArrangement', () => {
  it('flags the Mejuri style listing as hybrid even when tagged remote', () => {
    const result = detectWorkArrangement({
      title: 'Senior Front End Engineer',
      location: 'Canada',
      description:
        'Work from the Toronto office three days per week and remotely two days per week. This position requires in-office work 3 days a week.',
    });
    expect(result.arrangement).toBe('hybrid');
    expect(result.evidence).toContain('three days per week');
  });

  it.each([
    ['We offer a hybrid working model.'],
    ['Hybrid role based in Berlin'],
    ['This is a hybrid position.'],
    ['You will be in the office 3 days a week.'],
    ['Expect 2-3 days in the office each week.'],
    ['Two days a week on-site with the team.'],
    ['In-office 4 days, remote Friday.'],
    ['We work from the office three days per week.'],
    ['Partly remote with regular office days.'],
    ['Split between home and office.'],
  ])('hybrid: %s', (description) => {
    expect(detect(description).arrangement).toBe('hybrid');
  });

  it.each([
    ['This is an on-site role in Austin.'],
    ['Onsite position, no remote work.'],
    ['This is an office-based role.'],
    ['You must work in the office five days a week.'],
    ['Candidates must be located in or near Denver.'],
    ['You must be based in Munich.'],
    ['Willing to relocate to Singapore is required.'],
    ['Relocation is required for this role.'],
    ['Office presence is required.'],
    ['Required to be in the office daily.'],
    ['Must live within commuting distance of our HQ.'],
    ['Work from the Lisbon office.'],
  ])('onsite: %s', (description) => {
    expect(detect(description).arrangement).toBe('onsite');
  });

  it('reads the title and location too', () => {
    expect(detect('', 'Product Designer (Hybrid)').arrangement).toBe('hybrid');
    expect(detect('', 'Nurse', 'Leeds (On-site)').arrangement).toBe('onsite');
    expect(detect('', 'Engineer', 'Amsterdam, hybrid').arrangement).toBe('hybrid');
  });

  it('reports remote only from a label or an explicit statement', () => {
    expect(detect('', 'Engineer', 'Remote').arrangement).toBe('remote');
    expect(detect('We are a remote-first company.').arrangement).toBe('remote');
    expect(detect('This job is fully remote.').arrangement).toBe('remote');
    expect(detect('You can work from anywhere.').arrangement).toBe('remote');
    expect(detect('We value remote collaboration tools.').arrangement).toBe('unknown');
  });

  it('prefers hybrid wording over a remote location label', () => {
    expect(detect('Hybrid, two days in the office.', 'Engineer', 'Remote').arrangement).toBe('hybrid');
  });

  it.each([
    ['We are remote-first and have no office.'],
    ['This role is fully remote. Hybrid is not required.'],
    ['Fully remote, with an optional on-site week.'],
    ['You may visit the office once a year.'],
    ['We meet at an annual on-site retreat.'],
    ['We have no on-site requirement.'],
    ['This is not an office-based job.'],
    ['Non-hybrid, work from home.'],
    ['Experience with hybrid cloud infrastructure.'],
    ['You will build hybrid mobile apps.'],
    ['On-site interviews happen in the final round.'],
    ['Relocation assistance is available.'],
    ['Relocation package offered.'],
    ['You must be located in the United States.'],
    ['Must be based in Canada.'],
    ['Applicants must be located in the EU.'],
    ['Must be located in a CET time zone.'],
    ['We offer remote work five days a week.'],
    ['Team meets in person occasionally.'],
    ['We run 3 days a week of support coverage.'],
    ['Our headquarters are in Paris.'],
    ['Join our office hours events online.'],
  ])('stays conservative: %s', (description) => {
    const arrangement = detect(description).arrangement;
    expect(['unknown', 'remote']).toContain(arrangement);
    expect(isOnsiteOrHybrid(arrangement)).toBe(false);
  });

  it('returns unknown with no evidence for empty or unrelated text', () => {
    expect(detectWorkArrangement({})).toEqual({ arrangement: 'unknown', evidence: null });
    expect(detect('Build great software with a friendly team.')).toEqual({ arrangement: 'unknown', evidence: null });
  });

  it('keeps evidence short', () => {
    const long = `${'Lorem ipsum dolor sit amet '.repeat(20)}hybrid ${'consectetur '.repeat(20)}`;
    const result = detect(long);
    expect(result.arrangement).toBe('hybrid');
    expect(result.evidence!.length).toBeLessThanOrEqual(150);
    expect(result.evidence).toContain('hybrid');
  });

  it('handles html and odd whitespace', () => {
    expect(detect('<p>Hybrid&nbsp;role</p><p>Office 3 days a week</p>').arrangement).toBe('hybrid');
  });
});

describe('isOnsiteOrHybrid', () => {
  it('is true only for onsite and hybrid', () => {
    expect(isOnsiteOrHybrid('onsite')).toBe(true);
    expect(isOnsiteOrHybrid('hybrid')).toBe(true);
    expect(isOnsiteOrHybrid('remote')).toBe(false);
    expect(isOnsiteOrHybrid('unknown')).toBe(false);
    expect(isOnsiteOrHybrid(undefined)).toBe(false);
  });
});
