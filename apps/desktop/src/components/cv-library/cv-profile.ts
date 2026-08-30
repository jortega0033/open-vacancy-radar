import type { CvDocumentRecord, CvKind } from '../../window.js';

export const CV_KIND_LABEL: Record<CvKind, string> = {
  uploaded: 'Uploaded',
  manual: 'Manual',
};

/**
 * Comma-separated free text <-> the `string[]` the bridge stores. Blank entries (a trailing
 * comma, repeated spaces) are dropped so they never become a phantom empty skill chip.
 */
export function skillsToText(skills: readonly string[]): string {
  return skills.join(', ');
}

export function textToSkills(text: string): string[] {
  return text
    .split(',')
    .map((skill) => skill.trim())
    .filter((skill) => skill.length > 0);
}

export type ParseStatusTone = 'success' | 'warning' | 'neutral';

export interface ParseStatus {
  label: string;
  tone: ParseStatusTone;
}

/**
 * There is no persisted "parse status" column on `CvDocumentRecord` — it is derived from what the
 * record already tells us. A manual profile was never parsed (that's the point of typing it in by
 * hand), so it is neither a success nor a failure, just "not applicable." An uploaded CV either
 * produced usable extracted text or it didn't (e.g. a scanned PDF with no selectable text), which
 * is a real success/warning distinction worth the state hue per DESIGN-TOKENS.md.
 */
export function cvParseStatus(doc: CvDocumentRecord): ParseStatus {
  if (doc.kind === 'manual') return { label: 'Manual entry', tone: 'neutral' };
  return doc.text.trim().length > 0
    ? { label: 'Parsed', tone: 'success' }
    : { label: 'No text extracted', tone: 'warning' };
}

export function formatCvDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}
