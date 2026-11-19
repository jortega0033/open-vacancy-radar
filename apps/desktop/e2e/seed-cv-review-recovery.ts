import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import { EMPTY_CV_SOURCE, type CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import * as workspace from '../electron/workspace/repository.js';
import { APPLY_COMPANY, APPLY_ROLE, APPLY_VACANCY_KEY, APPLY_VACANCY_URL, applyWorkspaceReport } from './apply-workspace-seed.js';

/**
 * Synthetic workspaces for #756/#757, written through the real repository before launch: one
 * uploaded CV whose records are already reviewed (the drawer then opens on them without an AI read,
 * which e2e cannot run) and one application whose preparation stopped on the "no reviewed source
 * record" reason. Every value is made up; the employer link is on the reserved `.invalid` domain.
 */
export const RECOVERY_CV_NAME = 'jamie-rivera-cv.pdf';
export const RECOVERY_SKILLS = ['React', 'TypeScript', 'Playwright'];
export const RECOVERY_LANGUAGES = 'Dutch (native), English (C1)';
export const REVIEW_REQUIRED_DETAIL =
  'Automatic CV tailoring stopped: this CV has no reviewed source record. Review the CV source before automatic tailoring, or use the original CV.';

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  contact: { name: 'Jamie Rivera', title: 'Frontend Developer', location: 'Utrecht, Netherlands', email: 'jamie@example.invalid', phone: '', links: [] },
  summary: 'Frontend developer who builds accessible React applications.',
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Developer', dates: 'Jan 2019 - Dec 2023', engagement: 'employment', client: '', bullets: ['Built the booking UI in React and TypeScript.'] },
  ],
  education: [{ institution: 'Hogeschool Utrecht', credential: 'BSc Software Engineering', dates: '2015 - 2019' }],
  projects: [],
  maxProjects: 0,
  complete: true,
  coveredChars: 400,
  sourceChars: 400,
  reviewedAt: '2026-10-01T10:00:00.000Z',
};

export interface SeededRecovery {
  userDataDir: string;
  vacancyEngineDataRoot: string;
  cvId: string;
  attemptId: string;
  cleanup: () => Promise<void>;
}

export async function seedCvReviewRecovery(prefix: string, options: { skills?: string[] } = {}): Promise<SeededRecovery> {
  const userDataDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const vacancyEngineDataRoot = await mkdtemp(join(tmpdir(), `${prefix}-engine-`));
  const reportDirectory = join(vacancyEngineDataRoot, 'reports', 'global-remote');
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, 'latest.json'), JSON.stringify(applyWorkspaceReport()), 'utf8');

  const seeded = createWorkspaceDb(userDataDir);
  let cvId: string;
  let attemptId: string;
  try {
    const cv = workspace.createCvDocument(seeded.db, {
      name: RECOVERY_CV_NAME,
      kind: 'uploaded',
      text: 'Jamie Rivera. Frontend Developer, Utrecht. Redwood Software 2019-2023. SKILLS: React, TypeScript, Playwright. LANGUAGES: Dutch (native), English (C1).',
      profile: {
        title: 'Frontend Developer',
        years: '5',
        location: 'Utrecht, Netherlands',
        languages: RECOVERY_LANGUAGES,
        skills: options.skills ?? RECOVERY_SKILLS,
        summary: SOURCE.summary,
        auth: '',
      },
      source: SOURCE,
    });
    cvId = cv.id;
    const attempt = workspace.createApplicationAttempt(seeded.db, {
      vacancyKey: APPLY_VACANCY_KEY,
      canonicalUrl: APPLY_VACANCY_URL,
      company: APPLY_COMPANY,
      role: APPLY_ROLE,
      sourceCvId: cv.id,
      sourceCvContentHash: 'source-cv-content-hash',
      jdSnapshot: 'Build accessible product interfaces for an international team with React and TypeScript.',
      jdSnapshotHash: 'jd-content-hash',
      jdComplete: true,
      checkpoint: 'needs_user',
      checkpointDetail: REVIEW_REQUIRED_DETAIL,
    });
    attemptId = attempt.id;
  } finally {
    seeded.close();
  }

  return {
    userDataDir,
    vacancyEngineDataRoot,
    cvId,
    attemptId,
    cleanup: async () => {
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      await rm(vacancyEngineDataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
