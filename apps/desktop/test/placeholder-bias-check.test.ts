import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const BANNED_WORDS = ['Netherlands', 'Amsterdam', 'Frontend', 'EUR', 'Redwood'];

/**
 * Component source files that contain placeholders to check.
 * These are the paths mentioned in issue #489.
 * Relative to the apps/desktop directory.
 */
const COMPONENT_FILES = [
  'src/components/search/SearchFilterBar.tsx',
  'src/components/cv/ResumeToolkit.tsx',
  'src/components/cv-library/CvDrawer.tsx',
  'src/components/letters/LetterGenerator.tsx',
  'src/components/saved/SavedJobDrawer.tsx',
];

describe('Placeholder bias check', () => {
  it('should not contain banned words in placeholders', () => {
    const violations: string[] = [];

    for (const filePath of COMPONENT_FILES) {
      const fullPath = resolve(process.cwd(), filePath);
      const content = readFileSync(fullPath, 'utf-8');

      // Extract all placeholder attribute values
      const placeholderMatches = Array.from(content.matchAll(/placeholder="([^"]*)"/g));

      for (const match of placeholderMatches) {
        const placeholder = match[1];
        if (!placeholder) continue;

        // Check for banned words
        for (const bannedWord of BANNED_WORDS) {
          if (placeholder.includes(bannedWord)) {
            violations.push(
              `${filePath}: placeholder contains "${bannedWord}": "${placeholder}"`,
            );
          }
        }

        // Check for missing "e.g." in example placeholders
        // (Skip placeholders that are just instructions or hints, not examples)
        const lowerPlaceholder = placeholder.toLowerCase();
        if (lowerPlaceholder.includes('example') || lowerPlaceholder.startsWith('e.g.')) {
          // It's an example placeholder, should start with "e.g." (case-insensitive)
          if (!lowerPlaceholder.startsWith('e.g.')) {
            // Some placeholders might be like "Comma-separated, e.g. ..." which is OK
            if (!lowerPlaceholder.includes('e.g.')) {
              // Only flag if it looks like an example but doesn't have "e.g."
              if (placeholder.match(/^[A-Z].*,.*[a-z]/) || placeholder.includes('such as')) {
                violations.push(
                  `${filePath}: placeholder missing "e.g." prefix: "${placeholder}"`,
                );
              }
            }
          }
        }
      }
    }

    expect(violations, violations.length > 0 ? violations.join('\n') : undefined).toHaveLength(0);
  });
});
