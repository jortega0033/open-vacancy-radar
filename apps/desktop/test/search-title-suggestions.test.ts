import { describe, expect, it } from 'vitest';
import { buildBestFitRolesPrompt, SUGGESTED_TITLES_HEADING } from '../src/components/cv/prompts.js';
import { parseSuggestedSearchTitles } from '../src/components/cv/search-title-suggestions.js';

describe('Resume Toolkit search-title suggestions (#686)', () => {
  it('asks the model for the list under the exact heading the parser reads', () => {
    const prompt = buildBestFitRolesPrompt({ fileName: 'cv.pdf', text: 'Frontend developer' });
    expect(prompt).toContain(SUGGESTED_TITLES_HEADING);
    expect(prompt).toContain('suggestions for the candidate to review');
  });

  it('reads short bullet titles with an optional language, and nothing else', () => {
    const answer = [
      '## Best-fit role directions',
      '- Frontend engineer',
      '## Suggested search titles',
      '- React developer',
      '- **Frontend ontwikkelaar** | Dutch',
      '- UI engineer',
      '- UI engineer',
      '- This is a whole sentence about why the candidate would be great at this kind of work.',
      '- <script>alert(1)</script>',
      '- https://example.invalid/jobs',
      'Some trailing prose',
      '## Another section',
      '- Not a title',
    ].join('\n');
    expect(parseSuggestedSearchTitles(answer)).toEqual([
      { title: 'React developer', language: '' },
      { title: 'Frontend ontwikkelaar', language: 'Dutch' },
      { title: 'UI engineer', language: '' },
    ]);
  });

  it('finds nothing when the answer has no such list, and caps a long one', () => {
    expect(parseSuggestedSearchTitles('## Best-fit role directions\n- Frontend engineer')).toEqual([]);
    const many = ['## Suggested search titles', ...Array.from({ length: 30 }, (_, index) => `- Title ${index}`)].join('\n');
    expect(parseSuggestedSearchTitles(many)).toHaveLength(12);
  });
});
