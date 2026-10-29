import { SUGGESTED_TITLES_HEADING } from './prompts.js';

export interface SuggestedSearchTitle {
  title: string;
  /** The language the title is written in, or empty when the answer stated none. */
  language: string;
}

const MAX_SUGGESTIONS = 12;
const MAX_TITLE_CHARS = 100;
const MAX_LANGUAGE_CHARS = 40;

/**
 * Reads the "Suggested search titles" list from a Resume Toolkit best-fit answer (#686).
 *
 * Model output is untrusted free text, so this keeps only short plain bullet lines under that one
 * heading, drops anything that looks like markup or a sentence rather than a title, and caps the list.
 * What it returns is a set of SUGGESTIONS for the person to review; nothing here approves, saves or
 * searches anything.
 */
export function parseSuggestedSearchTitles(answer: string): SuggestedSearchTitle[] {
  const lines = answer.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === SUGGESTED_TITLES_HEADING.toLowerCase());
  if (start < 0) return [];
  const found: SuggestedSearchTitle[] = [];
  const seen = new Set<string>();
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (line.startsWith('#')) break;
    const bullet = /^[-*•]\s+(.+)$/u.exec(line);
    if (!bullet) continue;
    const [titlePart = '', languagePart = ''] = bullet[1]!.split('|');
    const title = titlePart.replace(/[*_`]/gu, '').trim().replace(/\s+/gu, ' ');
    const language = languagePart.replace(/[*_`]/gu, '').trim().replace(/\s+/gu, ' ');
    if (!title || title.length > MAX_TITLE_CHARS || language.length > MAX_LANGUAGE_CHARS) continue;
    if (/[<>[\]{}]|https?:/iu.test(title) || /[.!?]\s*$/u.test(title) || title.split(' ').length > 8) continue;
    const key = `${title.toLowerCase()}::${language.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ title, language });
    if (found.length === MAX_SUGGESTIONS) break;
  }
  return found;
}
