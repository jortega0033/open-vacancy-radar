import { createHash } from 'node:crypto';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import { EMPTY_CV_SOURCE, stableCvSourceJson, type CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import * as workspace from '../electron/workspace/repository.js';
import { makeFact, makeVariant } from '../test/fixtures/cv-evidence.js';
import { FULL_JD } from '../test/fixtures/job-description.js';

/**
 * Seeds a reviewed CV source and an approved tailoring case, with synthetic data, in a user-data
 * directory before the app is launched on it (#434). Same approach as the other seeded e2e specs: the
 * rows are written through the real repository functions, because the AI steps that normally produce a
 * reviewed source, requirement mapping and clarified facts cannot run in e2e.
 *
 * The CV is deliberately long (many roles, each with several bullets) so its PDF runs to more than
 * one page. A single-page file cannot show that confirming waits for every page.
 */
export const PDF_REVIEW_CV_NAME = 'Jamie Rivera CV';
export const PDF_REVIEW_CASE_LABEL = 'Logistics Platform Engineer at Northwind Freight';
export const PDF_REVIEW_APPROVED_BULLET = 'Built the booking screens, using Angular';

const ROLE_COUNT = 11;

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  contact: { ...EMPTY_CV_SOURCE.contact, name: 'Jamie Rivera', email: 'jamie@example.invalid' },
  summary: 'Frontend engineer who builds booking tools.',
  experience: Array.from({ length: ROLE_COUNT }, (_unused, index) => ({
    id: `experience-${index + 1}`,
    company: `Redwood Software Group ${index + 1}`,
    title: 'Frontend Engineer',
    dates: `${2010 + index} - ${2011 + index}`,
    engagement: 'employment' as const,
    client: '',
    bullets: [
      `Maintained the reporting dashboards for team ${index + 1} and kept their load time under two seconds.`,
      `Reviewed pull requests for team ${index + 1} and wrote the release notes that went to support.`,
      `Ran the monthly accessibility check for the screens owned by team ${index + 1}.`,
    ],
  })),
  projects: [
    { id: 'project-1', name: 'Booking Toolkit', role: 'Lead', dates: '2023', organization: '', description: 'Shared booking components.', technologies: ['TypeScript'], links: [], pinned: true },
  ],
  maxProjects: 1,
};

export function seedPdfReviewCase(userDataDir: string): { cvId: string; overlayId: string } {
  const seeded = createWorkspaceDb(userDataDir);
  try {
    const { db } = seeded;
    const cv = workspace.createCvDocument(db, {
      name: PDF_REVIEW_CV_NAME,
      kind: 'manual',
      text: 'Jamie Rivera. Frontend Engineer at Redwood Software, 2021 to present. Skills: TypeScript.',
      profile: { title: 'Frontend Engineer', years: '5', location: '', languages: 'English', skills: ['TypeScript'], summary: '', auth: '' },
      source: SOURCE,
    });
    const created = workspace.createCvEvidenceOverlay(db, {
      cvId: cv.id,
      vacancyKey: 'url:https://jobs.example.invalid/logistics-platform-engineer',
      caseTitle: 'Logistics Platform Engineer',
      caseCompany: 'Northwind Freight',
      sourceCvContentHash: createHash('sha256').update(stableCvSourceJson(workspace.getCvDocument(db, cv.id).source!)).digest('hex'),
      jdSnapshot: FULL_JD,
      jdSnapshotHash: 'b'.repeat(64),
    });
    workspace.updateCvEvidenceOverlay(db, created.id, {
      facts: [makeFact({ factId: 'fact-1', parentId: 'experience-1', activity: 'Built the booking screens', mechanism: 'Angular' })],
      requirementCoverage: { status: 'complete', batches: 1 },
    });
    workspace.updateCvEvidenceOverlay(db, created.id, {
      wordingVariants: [
        makeVariant({ variantId: 'v-1', targetField: 'experience_bullet', parentId: 'experience-1', factIds: ['fact-1'], text: PDF_REVIEW_APPROVED_BULLET, approvedAt: '', sourceRevision: '' }),
      ],
    });
    workspace.approveCvProjectSelection(db, created.id, workspace.getCvEvidenceOverlayById(db, created.id).caseRevision);
    const revision = workspace.getCvEvidenceOverlayById(db, created.id).caseRevision;
    const approved = workspace.approveCvEvidenceOverlay(db, created.id, revision);
    return { cvId: cv.id, overlayId: approved.id };
  } finally {
    seeded.close();
  }
}
