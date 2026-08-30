/**
 * Public surface of the Letters feature. The app shell only needs `LettersPage` — it takes no
 * required props and covers both prototype routes (`/letters/new` and `/letters`) itself. The
 * pieces below are exported for tests and for any later layout that wants the generator on its
 * own (for example straight from a vacancy on the Search page).
 */
export { LettersPage } from './LettersPage.js';
export type { LettersPageProps } from './LettersPage.js';
export { LetterGenerator } from './LetterGenerator.js';
export type { LetterGeneratorProps } from './LetterGenerator.js';
export { LettersLibrary } from './LettersLibrary.js';
export type { LettersLibraryProps } from './LettersLibrary.js';
export { buildLetterPrompt, MAX_INSTRUCTION_CHARS } from './prompt.js';
export type { LetterPromptOptions } from './prompt.js';
export {
  formatUpdatedAt,
  labelFor,
  LETTER_LENGTH_OPTIONS,
  LETTER_STATUS_BADGE_CLASS,
  LETTER_STATUS_OPTIONS,
  LETTER_TONE_OPTIONS,
  LETTER_TYPE_OPTIONS,
} from './types.js';
export type { LetterOption, SelectedVacancy } from './types.js';
