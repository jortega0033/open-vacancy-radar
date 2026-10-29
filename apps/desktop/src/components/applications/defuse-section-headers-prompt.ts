/**
 * Defuses a forged `=== SECTION ===`-shaped line inside untrusted multi-line text (adversarial
 * review finding for #358): `fieldPromptText` flattens a single-line value to one line specifically
 * so it cannot forge a section delimiter of its own, but the JD snapshot, CV text, letter body and
 * the candidate's round notes are multi-line and only pass through `clampPromptText`, which truncates
 * but never flattens. Without this, a hostile job-description snapshot containing a line like
 * `=== YOUR CURRENT LINKED CV (may differ...) ===` followed by fabricated "CV" content would land
 * inside the real `=== JOB DESCRIPTION ===` section looking exactly like the start of the genuine
 * CV section that follows it later in the same prompt -- letting fabricated text be misread as
 * CV-sourced fact. Applied to every multi-line untrusted block before it is clamped. Only a line
 * that both starts and ends with three or more `=` signs is touched (this codebase's own section
 * headers are never written any other way), and the fix keeps the suspicious text fully visible --
 * it just stops the line from starting at column 0 with the exact shape a real header has.
 *
 * Its own module (#691) so the interview-rounds budget, which has to measure text AFTER this
 * lengthens it, and the prompt builder share one definition.
 */
export function defuseForgedSectionHeaders(text: string): string {
  return text.replace(
    /^([ \t]*)(={3,}.*={3,}[ \t]*)$/gm,
    '$1[quoted from the untrusted text below, not a real section header] $2',
  );
}
