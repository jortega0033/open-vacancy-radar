/**
 * Public surface of the CV assistant feature. The app shell only needs `CvAssistant`; the
 * individual pieces are exported for tests and for a future layout that places gap analysis and
 * the cover letter on different screens.
 */
export { CvAssistant } from './CvAssistant.js';
export { CvUpload } from './CvUpload.js';
export { SaveCvToLibrary } from './SaveCvToLibrary.js';
export { GapAnalysis } from './GapAnalysis.js';
export { CoverLetter } from './CoverLetter.js';
export { AiOutput } from './AiOutput.js';
export { buildGapAnalysisPrompt, buildCoverLetterPrompt, formatVacancy } from './prompts.js';
export { useAgentRun, describeError, RUN_TIMEOUT_MS } from './useAgentRun.js';
export type { AgentRun, AgentRunStatus } from './useAgentRun.js';
export type { CvDocument, VacancyLead } from './types.js';
export type { CvAssistantProps } from './CvAssistant.js';
export type { CvUploadProps } from './CvUpload.js';
export type { SaveCvToLibraryProps } from './SaveCvToLibrary.js';
export type { GapAnalysisProps } from './GapAnalysis.js';
export type { CoverLetterProps } from './CoverLetter.js';
