import { describe, expect, it } from 'vitest';
import { parseTailoringSummary, formatRemovalSummary } from '../../../src/components/applications/tailoring-summary-parser.js';

describe('parseTailoringSummary', () => {
  it('returns empty removedGroups when there is no removal text', () => {
    const result = parseTailoringSummary('CV tailored for this vacancy.');
    expect(result.hasRemovals).toBe(false);
    expect(result.removedGroups).toEqual([]);
    expect(result.base).toBe('CV tailored for this vacancy.');
  });

  it('parses a single skill removal', () => {
    const result = parseTailoringSummary(
      'CV tailored for this vacancy. Removed unsupported output: skill "React" is not in your reviewed CV profile.',
    );
    expect(result.hasRemovals).toBe(true);
    expect(result.removedGroups).toHaveLength(1);
    expect(result.removedGroups[0]!).toEqual({
      kind: 'skill',
      label: 'skill',
      items: ['React'],
      count: 1,
    });
  });

  it('parses multiple skill removals', () => {
    const result = parseTailoringSummary(
      'CV tailored for this vacancy. Removed unsupported output: skill "React" is not in your reviewed CV profile; skill "TypeScript" is not in your reviewed CV profile; skill "Python" is not in your reviewed CV profile.',
    );
    expect(result.hasRemovals).toBe(true);
    expect(result.removedGroups).toHaveLength(1);
    expect(result.removedGroups[0]!).toEqual({
      kind: 'skill',
      label: 'skills',
      items: ['React', 'TypeScript', 'Python'],
      count: 3,
    });
  });

  it('parses bullet removals', () => {
    const result = parseTailoringSummary(
      'CV tailored for this vacancy. Removed unsupported output: rewritten bullet for "Software Engineer at Acme Corp" was not an exact reviewed fact.',
    );
    expect(result.hasRemovals).toBe(true);
    expect(result.removedGroups).toHaveLength(1);
    expect(result.removedGroups[0]!).toEqual({
      kind: 'bullet',
      label: 'bullet',
      items: ['Software Engineer at Acme Corp'],
      count: 1,
    });
  });

  it('parses summary removals', () => {
    const result = parseTailoringSummary(
      'CV tailored for this vacancy. Removed unsupported output: summary rewrite was not an exact reviewed fact.',
    );
    expect(result.hasRemovals).toBe(true);
    expect(result.removedGroups).toHaveLength(1);
    expect(result.removedGroups[0]!.kind).toBe('summary');
  });

  it('groups mixed removal types', () => {
    const result = parseTailoringSummary(
      'CV tailored for this vacancy. Removed unsupported output: skill "Rust" is not in your reviewed CV profile; skill "Go" is not in your reviewed CV profile; rewritten bullet for "DevOps Engineer at StartupXYZ" was not an exact reviewed fact; summary rewrite was not an exact reviewed fact.',
    );
    expect(result.hasRemovals).toBe(true);
    expect(result.removedGroups).toHaveLength(3);
    expect(result.removedGroups[0]!.kind).toBe('skill');
    expect(result.removedGroups[0]!.count).toBe(2);
    expect(result.removedGroups[1]!.kind).toBe('bullet');
    expect(result.removedGroups[2]!.kind).toBe('summary');
  });

  it('handles the base text correctly', () => {
    const result = parseTailoringSummary(
      'Original reviewed CV used by your explicit choice after automatic tailoring stopped. Removed unsupported output: skill "Rust" is not in your reviewed CV profile.',
    );
    expect(result.base).toBe('Original reviewed CV used by your explicit choice after automatic tailoring stopped.');
  });
});

describe('formatRemovalSummary', () => {
  it('formats a single skill removal', () => {
    const groups = [
      {
        kind: 'skill' as const,
        label: 'skill',
        items: ['React'],
        count: 1,
      },
    ];
    const result = formatRemovalSummary(groups);
    expect(result).toBe('1 skill from this vacancy is not in your CV');
  });

  it('formats multiple skills removal', () => {
    const groups = [
      {
        kind: 'skill' as const,
        label: 'skills',
        items: ['React', 'TypeScript', 'Python'],
        count: 3,
      },
    ];
    const result = formatRemovalSummary(groups);
    expect(result).toBe('3 skills from this vacancy are not in your CV');
  });

  it('formats mixed removal types', () => {
    const groups = [
      {
        kind: 'skill' as const,
        label: 'skills',
        items: ['Rust', 'Go'],
        count: 2,
      },
      {
        kind: 'bullet' as const,
        label: 'bullet',
        items: ['DevOps Engineer at StartupXYZ'],
        count: 1,
      },
      {
        kind: 'summary' as const,
        label: 'summary',
        items: [],
        count: 1,
      },
    ];
    const result = formatRemovalSummary(groups);
    expect(result).toContain('skills');
    expect(result).toContain('bullet');
    expect(result).toContain('summary');
  });

  it('returns empty string for no removals', () => {
    const result = formatRemovalSummary([]);
    expect(result).toBe('');
  });
});
