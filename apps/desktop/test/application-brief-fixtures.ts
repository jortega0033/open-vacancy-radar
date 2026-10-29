import { vacancyIdentityFor, type DiscoveryVacancyAudit } from '@open-vacancy-radar/vacancy-engine';
import { readPostingVerification } from '../electron/application-posting-verification.js';
import { getView as companyEvidenceView } from '../electron/company-evidence-service.js';
import {
  summariseCompanyView,
  type BriefProfile,
  type BriefReportRow,
  type BriefServiceDeps,
} from '../electron/application-brief-service.js';
import type { WorkspaceDb } from '../electron/workspace/client.js';
import type { CvRequirementMapping } from '../electron/workspace/cv-evidence-schema.js';
import type { CvSourceDocument } from '../electron/workspace/cv-source-schema.js';

/**
 * Shared synthetic fixtures for the application brief tests (#688): one scan row builder, one candidate
 * profile, one reviewed CV source and one set of eligibility answers, plus the seam that stands in for
 * the scan report. Every employer, person and posting here is invented; nothing reaches a network.
 */

export const T0 = new Date('2026-10-20T09:00:00.000Z');
export const DAY = 24 * 60 * 60 * 1000;

export const ATS_URL = 'https://job-boards.greenhouse.io/northwind/jobs/1001';
export const ATS_URL_OTHER_REQ = 'https://job-boards.greenhouse.io/northwind/jobs/1002';
export const AGG_URL = 'https://remotive.example/remote-jobs/platform-engineer-northwind-77';
export const AGG_ONLY_URL = 'https://jobs.example/listing/solo-role-9';

export const JD_V1 = [
  'Northwind Freight is hiring a Platform Engineer.',
  'You have 5+ years of TypeScript experience.',
  'Experience with Kubernetes is required.',
  'Dutch language is a plus.',
].join(' ');
export const JD_V2 = `${JD_V1} You will also own the on-call rota.`;

export const SOURCE: CvSourceDocument = {
  contact: { name: 'Jamie Rivera', title: 'Senior Engineer', location: 'Amsterdam', email: 'jamie@example.invalid', phone: '+31 6 0000 0000', links: [] },
  summary: 'Synthetic summary.',
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Senior Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: ['Built TypeScript services.'] },
  ],
  education: [],
  projects: [],
  maxProjects: 0,
  complete: true,
  incompleteReason: '',
  coveredChars: 100,
  sourceChars: 100,
  reviewedAt: '2026-01-01T00:00:00.000Z',
};

export const PROFILE: BriefProfile = {
  profileVersion: 'candidate-profile-1',
  location: 'Amsterdam',
  experienceYears: 8,
  strongestSkills: ['TypeScript'],
  additionalSkills: ['Kubernetes'],
  targetRoles: ['Platform Engineer'],
  consideredRoles: [],
  excludedRoleFamilies: [],
  constraints: {
    professionalLanguage: 'English',
    dutchRequired: false,
    primaryCountry: 'Netherlands',
    allowRemoteEuSupportingNetherlands: true,
    minimumMonthlyBaseEur: 0,
  },
};

export const ELIGIBILITY = {
  candidateWorkCountry: { answer: 'yes', source: 'vacancy_text', scope: 'this_vacancy', observedAt: '2026-10-19T00:00:00.000Z', freshness: 'fresh', detail: 'Open to candidates in the EU.' },
  mandatoryLanguage: { answer: 'unknown', source: 'absent', scope: 'this_vacancy', observedAt: null, freshness: 'unknown', detail: 'No language is stated as mandatory.' },
  visaSponsorship: { answer: 'no', source: 'vacancy_text', scope: 'this_vacancy', observedAt: '2026-10-19T00:00:00.000Z', freshness: 'fresh', detail: 'We cannot sponsor visas.' },
  employerOfRecord: { answer: 'unknown', source: 'absent', scope: 'this_vacancy', observedAt: null, freshness: 'unknown', detail: '' },
  candidateRelocationWillingness: { answer: 'unknown', source: 'candidate_profile', scope: 'candidate', observedAt: null, freshness: 'unknown', detail: 'You have not said.' },
  employerRelocationSupport: { answer: 'no', source: 'vacancy_text', scope: 'this_vacancy', observedAt: null, freshness: 'unknown', detail: '' },
};

export function scanRow(over: {
  key: string;
  url: string;
  title?: string;
  description?: string | null;
  sources?: { provider: string; key: string; url: string }[];
  profileScore?: number | null;
  eligibility?: unknown;
}): DiscoveryVacancyAudit {
  const title = over.title ?? 'Platform Engineer';
  const identity = vacancyIdentityFor({ url: over.url, company: 'Northwind Freight', title, location: 'Remote - Europe', provider: 'ats_roster_greenhouse', key: over.key });
  return {
    key: over.key,
    provider: 'ats_roster_greenhouse',
    company: 'Northwind Freight',
    title,
    url: over.url,
    location: 'Remote - Europe',
    employmentType: 'full_time',
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    annualizedMinimumUsd: null,
    decision: 'candidate',
    reasons: [],
    contentHash: 'h',
    description: over.description === undefined ? JD_V1 : over.description,
    postedAt: '2026-10-15T00:00:00.000Z',
    profileScore: over.profileScore === undefined ? 78 : over.profileScore,
    profileMatch:
      over.profileScore === null
        ? null
        : {
            technicalFit: 80,
            roleFit: 75,
            seniorityFit: 70,
            primaryFit: 'Platform Engineer',
            matchingSkills: ['TypeScript', 'Kubernetes'],
            gaps: ['No Go experience listed'],
            reasons: [],
            unmetMandatoryLanguages: [],
          },
    worldwideSponsorMatch: null,
    eligibility: over.eligibility === undefined ? ELIGIBILITY : over.eligibility,
    identity,
    sourceUrl: over.url,
    applyUrl: { status: 'unresolved', url: over.url, evidence: '' },
    sources: over.sources ?? [{ provider: 'ats_roster_greenhouse', key: over.key, url: over.url }],
  } as unknown as DiscoveryVacancyAudit;
}


export interface BriefWorld {
  clock: Date;
  profile: BriefProfile | null;
  runId: string;
  generatedAt: string;
  profileVersion: string;
  rows: Map<string, DiscoveryVacancyAudit>;
}

export function makeWorld(): BriefWorld {
  return { clock: new Date(T0), profile: structuredClone(PROFILE), runId: '', generatedAt: '', profileVersion: PROFILE.profileVersion, rows: new Map() };
}

export function setScan(world: BriefWorld, rows: DiscoveryVacancyAudit[], generatedAt: string, profileVersion = PROFILE.profileVersion): void {
  world.rows = new Map(rows.map((row) => [row.key, row]));
  world.generatedAt = generatedAt;
  world.runId = `run-${generatedAt}`;
  world.profileVersion = profileVersion;
}

export function makeDeps(
  db: WorkspaceDb,
  world: BriefWorld,
  extra: Partial<BriefServiceDeps> = {},
  calls: { postingView: number } = { postingView: 0 },
): BriefServiceDeps {
  return {
    db,
    now: () => new Date(world.clock),
    findReportRow(vacancyKey): BriefReportRow | null {
      const row = world.rows.get(vacancyKey);
      return row ? { row, runId: world.runId, generatedAt: world.generatedAt, profileVersion: world.profileVersion } : null;
    },
    loadProfile: async () => world.profile,
    postingView(attemptId) {
      calls.postingView += 1;
      return readPostingVerification({ db, now: () => new Date(world.clock) }, attemptId);
    },
    companyEvidence(attemptId) {
      const now = new Date(world.clock);
      return summariseCompanyView(companyEvidenceView({ db, now: () => now }, { attemptId }), now);
    },
    ...extra,
  };
}

export function requirement(
  over: Partial<CvRequirementMapping> & Pick<CvRequirementMapping, 'requirementId' | 'text' | 'jdAnchor'>,
): CvRequirementMapping {
  return {
    classification: 'required',
    evidenceClass: 'direct',
    anchorParentId: 'experience-1',
    candidateAdded: false,
    reviewed: true,
    quoteStart: -1,
    quoteEnd: -1,
    jdRevisionId: '',
    excluded: false,
    exclusionReason: '',
    sourceIds: [],
    factIds: [],
    ...over,
  };
}
