import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';

/**
 * A synthetic workspace for the Review & apply workspace (#657): one saved search report with one
 * vacancy, and one manual application whose CV and cover letter are ready. Every value is made up;
 * the employer link is on the reserved `.invalid` domain, so nothing can reach a real employer.
 */
export const APPLY_VACANCY_KEY = 'manual-review-vacancy';
export const APPLY_VACANCY_URL = 'https://example.invalid/jobs/manual-review-vacancy';
export const APPLY_COMPANY = 'Northstar Product Engineering';
export const APPLY_ROLE = 'Senior Frontend Product Engineer';

export function applyWorkspaceReport() {
  return {
    runId: 'e2e-manual-application-review',
    generatedAt: '2026-09-12T00:00:00.000Z',
    profileVersion: 'global-remote-profile-v1',
    criteria: {
      role: 'frontend',
      fullyRemote: true,
      applicantLocation: 'anywhere-outside-us-nl',
      usCitizenshipRequired: false,
      minimumAnnualBaseUsd: 100_000,
      currency: 'USD',
    },
    statistics: {
      discoveryRequests: 1,
      discoveryListings: 1,
      discoveryUniqueListings: 1,
      discoveryOfficialReviewCandidates: 1,
      officialBoardsOrPagesAttempted: 0,
      officialRequests: 0,
      strictMatches: 0,
      manualReview: 0,
      nearMisses: 0,
      excludedOrInactive: 0,
      blockedOrErrored: 0,
      registrySources: 0,
      activeRegistrySources: 0,
      gatedRegistrySources: 0,
      manualOrProhibitedRegistrySources: 0,
    },
    sourceRegistry: [],
    discoverySources: [],
    strictMatches: [],
    manualReview: [],
    nearMisses: [],
    excludedOrInactive: [],
    blockedOrErrored: [],
    officialAudit: [],
    discoveryAudit: [
      {
        key: APPLY_VACANCY_KEY,
        provider: 'remotive',
        company: APPLY_COMPANY,
        title: APPLY_ROLE,
        url: APPLY_VACANCY_URL,
        location: 'Netherlands',
        employmentType: 'full_time',
        currency: 'EUR',
        salaryPeriod: 'year',
        advertisedMinimum: 70_000,
        annualizedMinimumUsd: 82_000,
        decision: 'official_review_candidate',
        reasons: ['Frontend role'],
        contentHash: 'manual-review-content-hash',
        description: 'Build accessible product interfaces for an international team.',
        postedAt: '2026-09-01T00:00:00.000Z',
        profileScore: 82,
        worldwideSponsorMatch: null,
      },
    ],
    methodology: [],
    attribution: [],
  };
}

export interface SeededApplyWorkspace {
  userDataDir: string;
  vacancyEngineDataRoot: string;
  cvPath: string;
  letterPath: string;
  attemptId: string;
  cleanup: () => Promise<void>;
}

/** Creates the throwaway user-data dir, the report and one manual application with both documents. */
export async function seedApplyWorkspace(prefix: string): Promise<SeededApplyWorkspace> {
  const userDataDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const vacancyEngineDataRoot = await mkdtemp(join(tmpdir(), `${prefix}-engine-`));
  const reportDirectory = join(vacancyEngineDataRoot, 'reports', 'global-remote');
  const cvPath = join(userDataDir, 'Northstar-Frontend-CV.pdf');
  const letterPath = join(userDataDir, 'Northstar-Frontend-Letter.pdf');
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(join(reportDirectory, 'latest.json'), JSON.stringify(applyWorkspaceReport()), 'utf8');
  await writeFile(cvPath, '%PDF-1.4', 'utf8');
  await writeFile(letterPath, '%PDF-1.4', 'utf8');

  let attemptId: string;
  const seeded = createWorkspaceDb(userDataDir);
  try {
    const cv = workspace.createCvDocument(seeded.db, {
      name: 'Reviewed Frontend CV.pdf',
      kind: 'manual',
      text: 'Senior frontend product engineer.',
    });
    const attempt = workspace.createApplicationAttempt(seeded.db, {
      vacancyKey: APPLY_VACANCY_KEY,
      canonicalUrl: APPLY_VACANCY_URL,
      company: APPLY_COMPANY,
      role: APPLY_ROLE,
      sourceCvId: cv.id,
      sourceCvContentHash: 'source-cv-content-hash',
      jdSnapshot: 'Build accessible product interfaces for an international team.',
      jdSnapshotHash: 'jd-content-hash',
      jdComplete: true,
      checkpoint: 'needs_user',
      checkpointDetail:
        'Your application documents are ready. This employer site requires a manual application.',
    });
    attemptId = attempt.id;
    workspace.createApplicationArtifact(seeded.db, {
      attemptId: attempt.id,
      kind: 'cv_pdf',
      fileName: 'Northstar-Frontend-CV.pdf',
      mimeType: 'application/pdf',
      byteSize: 128,
      contentHash: 'artifact-content-hash',
      storagePath: cvPath,
    });
    workspace.createApplicationArtifact(seeded.db, {
      attemptId: attempt.id,
      kind: 'cover_letter_pdf',
      fileName: 'Northstar-Frontend-Letter.pdf',
      mimeType: 'application/pdf',
      byteSize: 128,
      contentHash: 'letter-content-hash',
      storagePath: letterPath,
    });
  } finally {
    seeded.close();
  }

  return {
    userDataDir,
    vacancyEngineDataRoot,
    cvPath,
    letterPath,
    attemptId,
    cleanup: async () => {
      await rm(userDataDir, { recursive: true, force: true });
      await rm(vacancyEngineDataRoot, { recursive: true, force: true });
    },
  };
}
