import { describe, expect, it } from 'vitest';
import { EMPTY_CV_SOURCE } from '../electron/workspace/cv-source-schema.js';
import { sourceAnchors } from '../src/components/cv/source-anchors.js';
import type { CvSourceDocument } from '../src/window.js';

describe('sourceAnchors (#419)', () => {
  it('returns an empty list for no source', () => {
    expect(sourceAnchors(null)).toEqual([]);
    expect(sourceAnchors(undefined)).toEqual([]);
  });

  it('labels an experience entry as "<title> at <company>" and a project as "Project: <name>"', () => {
    const source: CvSourceDocument = {
      ...EMPTY_CV_SOURCE,
      experience: [
        { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '', engagement: 'employment', client: '', bullets: [] },
      ],
      projects: [
        { id: 'project-1', name: 'Design System', role: '', dates: '', organization: '', description: '', technologies: [], links: [], pinned: false },
      ],
    };
    expect(sourceAnchors(source)).toEqual([
      { id: 'experience-1', type: 'experience', label: 'Frontend Engineer at Redwood Software' },
      { id: 'project-1', type: 'project', label: 'Project: Design System' },
    ]);
  });
});
