/**
 * The lookup key for the reusable application-answer library (#372).
 *
 * Shared by both sides of the feature: the repository code in this directory, which saves and
 * looks up `applicationAnswers` rows by this key, and the (separately implemented) review-flow
 * confirm code that suggests a saved answer for a field on a live form. Both must derive the same
 * key from the same field the same way, which is why this is one small module rather than logic
 * duplicated on each side.
 *
 * Normalization folds away differences that are incidental to what question is being asked --
 * diacritics, casing, and stray whitespace -- so the same question re-typed slightly differently
 * on a second posting (a trailing space, a curly vs. straight apostrophe's accent, "Why do you
 * want to work here?" vs. "why do you want to work here?") still matches. It deliberately does
 * NOT go any further than that: no fuzzy matching, no semantic/embedding comparison, no stemming.
 * That is #372's explicit V1 boundary -- a near-match (a differently-worded question that asks
 * for similar information) remains a new question, because guessing wrong here would offer a
 * saved answer to the wrong prompt, and this feature already requires an explicit confirm before
 * anything is filled precisely so a wrong guess is never applied silently.
 *
 * Pure string work: no database, no Electron, exhaustively unit-testable on its own.
 */

/**
 * A field label reduced to an equality key: diacritics folded, case dropped, incidental
 * whitespace collapsed. Punctuation is deliberately left alone -- unlike
 * `application-identity.ts`'s `normalizeEmployerName`, which strips punctuation entirely because a
 * company name's punctuation carries no meaning, a question's wording (including its punctuation)
 * is part of what makes it the same or a different question, so this function only removes
 * variation that is not meaningful: accents and repeated/leading/trailing spaces.
 */
export function normalizeAnswerLabel(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The full lookup key: normalized label plus control type. Control type is part of the key, not
 * just the label, because the same wording can legitimately appear as a short `text` field on one
 * posting and a `textarea` on another, and a short answer that fits one is not necessarily a good
 * answer for the other.
 */
export function applicationAnswerKey(label: string, controlType: 'text' | 'textarea'): string {
  return `${controlType}::${normalizeAnswerLabel(label)}`;
}
