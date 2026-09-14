import { vi } from 'vitest';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import type {
  AppSettingsRecord,
  SystemBridge,
  VacancyRadarBridge,
  WorkspaceBridge,
  WorkspaceCounts,
} from '../src/window.js';

/**
 * Stubs for the two bridges the app shell talks to on mount, in the same style as
 * `test/cv-bridges.ts`: every capability is a `vi.fn()` resolving to a believable default, and a
 * test overrides only the one it is about.
 *
 * `DEFAULT_SETTINGS` intentionally mirrors the column defaults in
 * `electron/workspace/schema.ts`. If the two ever drift, a shell test asserting "opens on Search
 * with the sidebar expanded" is the thing that should notice.
 */
export const DEFAULT_SETTINGS: AppSettingsRecord = {
  launchAtLogin: false,
  startPage: 'search',
  theme: 'system',
  density: 'comfortable',
  sidebarStart: 'remember_last',
  sidebarCollapsed: false,
  lastOpenedPage: 'search',
  minimizeToTrayOnClose: false,
  autoScanEnabled: false,
  defaultLocation: '',
  defaultCvId: null,
  defaultLetterType: 'motivation_letter',
  defaultLetterTone: 'natural',
  defaultLetterLength: 'standard',
  defaultApplicationStatus: 'preparing',
  confirmApplicationDelete: true,
  autoArchiveRejected: false,
  defaultProvider: 'claude',
  agentSelectedSessionId: null,
  agentArchivedSessionIds: [],
  agentUnreadCounts: {},
};

export const DEFAULT_COUNTS: WorkspaceCounts = { savedJobs: 0, activeApplications: 0, letters: 0 };

/** Mirrors the shipped `config/candidate-profile-v1.json`: empty, not a plausible-looking default. */
export const DEFAULT_CANDIDATE_PROFILE: CandidateProfile = {
  profileVersion: 'candidate-profile-test',
  candidateName: '',
  currentRole: '',
  location: '',
  experienceYears: 0,
  strongestSkills: [],
  additionalSkills: [],
  targetRoles: [],
  consideredRoles: [],
  excludedRoleFamilies: [],
  constraints: {
    professionalLanguage: 'English',
    dutchRequired: false,
    primaryCountry: '',
    allowRemoteEuSupportingNetherlands: false,
    minimumMonthlyBaseEur: 0,
  },
};

export function installWorkspaceBridge(overrides: Partial<WorkspaceBridge> = {}): WorkspaceBridge {
  const bridge: WorkspaceBridge = {
    getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
    updateSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
    getCounts: vi.fn().mockResolvedValue(DEFAULT_COUNTS),
    resetApplicationData: vi.fn().mockResolvedValue({
      settings: DEFAULT_SETTINGS,
      deleted: {
        savedJobs: 0,
        applications: 0,
        cvDocuments: 0,
        letters: 0,
        applicationAttempts: 0,
        applicationArtifacts: 0,
        submissionReceipts: 0,
        automationGrants: 0,
      },
    }),

    listSavedJobs: vi.fn().mockResolvedValue([]),
    createSavedJob: vi.fn(),
    updateSavedJob: vi.fn(),
    deleteSavedJob: vi.fn().mockResolvedValue({ deleted: true }),

    listApplications: vi.fn().mockResolvedValue([]),
    createApplication: vi.fn(),
    updateApplication: vi.fn(),
    deleteApplication: vi.fn().mockResolvedValue({ deleted: true }),

    listCvDocuments: vi.fn().mockResolvedValue([]),
    createCvDocument: vi.fn(),
    updateCvDocument: vi.fn(),
    deleteCvDocument: vi.fn().mockResolvedValue({ deleted: true }),
    setDefaultCvDocument: vi.fn().mockResolvedValue([]),
    exportCvDocument: vi.fn().mockResolvedValue({ saved: true, path: 'C:\\fake\\resume.pdf' }),

    listLetters: vi.fn().mockResolvedValue([]),
    createLetter: vi.fn(),
    updateLetter: vi.fn(),
    deleteLetter: vi.fn().mockResolvedValue({ deleted: true }),
    duplicateLetter: vi.fn(),

    listApplicationAttempts: vi.fn().mockResolvedValue([]),
    getApplicationAttempt: vi.fn(),
    updateApplicationAttempt: vi.fn(),
    listApplicationArtifacts: vi.fn().mockResolvedValue([]),
    listAutomationGrants: vi.fn().mockResolvedValue([]),
    revokeAutomationGrant: vi.fn(),
    ...overrides,
  };
  (window as unknown as { workspace: WorkspaceBridge }).workspace = bridge;
  return bridge;
}

/** Stub for the `window.system` bridge: OS login-item, app version, and native save-file dialog. */
export function installSystemBridge(overrides: Partial<SystemBridge> = {}): SystemBridge {
  const bridge: SystemBridge = {
    setLaunchAtLogin: vi.fn().mockResolvedValue(undefined),
    getAppVersion: vi.fn().mockResolvedValue('0.0.0-test'),
    saveFile: vi.fn().mockResolvedValue({ saved: true, path: 'C:\\fake\\export.txt' }),
    ...overrides,
  };
  (window as unknown as { system: SystemBridge }).system = bridge;
  return bridge;
}

export function installVacancyRadarBridge(overrides: Partial<VacancyRadarBridge> = {}): VacancyRadarBridge {
  const bridge: VacancyRadarBridge = {
    getStatus: vi.fn().mockResolvedValue({ ready: false, error: 'not configured in this test' }),
    getReport: vi.fn().mockResolvedValue(null),
    getReportSummary: vi.fn().mockResolvedValue(null),
    runScan: vi.fn(),
    getScanStatus: vi.fn().mockResolvedValue({ scanning: false }),
    // Default: subscribes to nothing and hands back an already-good unsubscribe. A test that cares
    // about progress events overrides this with its own `vi.fn()` that captures the callback (the
    // same "override only the one you're about" pattern every other capability here follows).
    onScanProgress: vi.fn(() => () => {}),
    getSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
    saveSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
    // Default: not imported yet, mirroring a fresh checkout/userData directory. A test that cares
    // about a populated roster overrides this with its own resolved status.
    getAtsRosterStatus: vi.fn().mockResolvedValue(null),
    refreshAtsRoster: vi.fn(),
    ...overrides,
  };
  (window as unknown as { vacancyRadar: VacancyRadarBridge }).vacancyRadar = bridge;
  return bridge;
}
