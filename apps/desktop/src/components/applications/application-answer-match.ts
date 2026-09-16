/**
 * A renderer-local mirror of `electron/workspace/application-answer-key.ts`'s
 * `normalizeAnswerLabel`/`applicationAnswerKey` (#372), not an import of it: that file lives under
 * `electron/`, and this codebase's convention (see `src/window.d.ts`'s own header comment) is that
 * nothing crosses from `electron/` into the renderer bundle except types. This is intentionally the
 * same small, pure algorithm (no Node/Electron API either implementation touches) for one purpose
 * only -- deciding which of an already-fetched `ApplicationAnswerRecord[]` list to *suggest* next to
 * a matching unanswered field. The authoritative `normalizedKey` a saved answer is actually stored
 * and looked up under is always computed main-process side, at save time (`saveApplicationAnswer`);
 * if this copy ever drifted from that one, the failure mode is a missed suggestion, never a wrong
 * write, since confirming a suggestion still only ever fills the one live field it was shown next to.
 */
export function normalizeAnswerLabelForMatch(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function applicationAnswerKeyForMatch(label: string, controlType: 'text' | 'textarea'): string {
  return `${controlType}::${normalizeAnswerLabelForMatch(label)}`;
}
