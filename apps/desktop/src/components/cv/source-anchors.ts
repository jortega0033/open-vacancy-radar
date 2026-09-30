import type { CvSourceDocument } from '../../window.js';

export interface SourceAnchor {
  id: string;
  type: 'experience' | 'project';
  label: string;
}

/**
 * Every reviewed-source experience/project entry as a labelled anchor, one definition shared by
 * `ClarificationForm.tsx` (the role/project picker in the clarification form) and
 * `RequirementMapping.tsx` (the read-only anchor label shown on an already-anchored requirement
 * row) -- so the two surfaces can never show two different labels for the same role or project.
 */
export function sourceAnchors(source: CvSourceDocument | null | undefined): SourceAnchor[] {
  if (!source) return [];
  return [
    ...source.experience.map((entry) => ({
      id: entry.id,
      type: 'experience' as const,
      label: `${entry.title || 'Role'} at ${entry.company || 'unknown employer'}`,
    })),
    ...source.projects.map((entry) => ({
      id: entry.id,
      type: 'project' as const,
      label: `Project: ${entry.name || 'unnamed'}`,
    })),
  ];
}
