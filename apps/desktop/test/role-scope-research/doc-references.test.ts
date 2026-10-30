// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every repository path the #694 memo cites in backticks must exist, every `path:line` must be inside the file, and
 * the load-bearing citations must still point at the code they describe. If a cited file moves, this fails rather
 * than leaving the memo pointing at nothing.
 *
 * Maintenance: the anchors below are production line numbers at the memo's base commit. A later change that moves a
 * cited line (follow-ups #713 and #714 will, e.g. relevance.ts:67 and language.ts:137) must update the `path:line`
 * citation in docs/role-scope-research.md and the matching ANCHORS entry here in the same PR. This is expected
 * upkeep, not a sign the research is wrong.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const memo = readFileSync(join(root, 'docs', 'role-scope-research.md'), 'utf8');

const REFERENCE = /`((?:apps|packages|docs)\/[^`\s:*<>]+?)(?::(\d+))?`/gu;
const references = [...memo.matchAll(REFERENCE)].map((match) => ({ path: match[1]!, line: match[2] ? Number(match[2]) : null }));
const linesOf = (path: string) => readFileSync(join(root, path), 'utf8').split(/\r?\n/u);

/** Citations the decision rests on: the cited line must still contain this text. */
const ANCHORS: readonly [string, string][] = [
  ['packages/vacancy-engine/src/candidate/profile.ts:25', 'targetRoles'],
  ['packages/vacancy-engine/src/candidate/profile.ts:130', 'export function isCandidateProfileConfigured'],
  ['packages/vacancy-engine/src/filtering/relevance.ts:67', 'const CONCEPTS'],
  ['packages/vacancy-engine/src/filtering/relevance.ts:272', 'function classifyPrimaryRole'],
  ['packages/vacancy-engine/src/filtering/relevance.ts:326', 'test engineer'],
  ['packages/vacancy-engine/src/filtering/relevance.ts:369', 'ui engineer'],
  ['packages/vacancy-engine/src/filtering/relevance.ts:450', 'function assessTechnicalFit'],
  ['packages/vacancy-engine/src/filtering/relevance.ts:572', 'function isExcludedPrimaryFamily'],
  ['packages/vacancy-engine/src/filtering/relevance.ts:608', 'UNMET_MANDATORY_LANGUAGE_SCORE_CAP = 45'],
  ['packages/vacancy-engine/src/filtering/relevance.ts:640', 'export function scoreWorldwideVacancy'],
  ['packages/vacancy-engine/src/filtering/relevance.ts:645', 'isCandidateProfileConfigured(profile)'],
  ['packages/vacancy-engine/src/pipeline/global-remote.ts:275', 'scoreWorldwideVacancy('],
  ['packages/vacancy-engine/src/pipeline/global-remote.ts:280', 'relevant: _relevant'],
  ['packages/vacancy-engine/src/global-remote/focused-scan.ts:280', 'export function vacancyMatchesRole'],
  ['packages/vacancy-engine/src/global-remote/focused-scan.ts:288', 'export function vacancyTitleMatches'],
  ['packages/vacancy-engine/src/global-remote/search-plan.ts:123', 'export function compileSearchPlanQueries'],
  ['packages/vacancy-engine/src/candidate/search-plan.ts:244', 'export function approveSearchPlanDraft'],
  ['packages/vacancy-engine/src/candidate/search-plan.ts:268', 'export function addSearchPlanSuggestions'],
  ['packages/vacancy-engine/src/candidate/search-plan.ts:322', 'export function captureSearchPlanSnapshot'],
  ['packages/vacancy-engine/src/eligibility/language.ts:137', 'export function detectLanguageRequirements'],
  ['packages/vacancy-engine/src/eligibility/language.ts:145', "heading = 'mandatory'"],
  ['apps/desktop/electron/vacancy-scan-query.ts:135', 'export function scheduledScanQueryFromProfile'],
  ['apps/desktop/src/components/search/SearchPage.tsx:956', 'currentProfileScanQuery'],
  ['apps/desktop/src/components/search/results.ts:723', 'export function sortSearchResultIndex'],
  ['apps/desktop/src/components/cv/prompts.ts:395', 'export function buildBestFitRolesPrompt'],
  ['packages/vacancy-engine/src/global-remote/evaluation.ts:13', 'const FRONTEND_ROLE'],
  ['packages/vacancy-engine/src/global-remote/evaluation.ts:14', 'const UI_ROLE'],
  ['packages/vacancy-engine/src/global-remote/evaluation.ts:15', 'const ROLE_EXCLUSIONS'],
  ['packages/vacancy-engine/src/global-remote/evaluation.ts:90', 'export function classifyDiscoveryVacancy'],
  ['packages/vacancy-engine/src/pipeline/global-remote.ts:1067', 'function withApprovedTitleClassification'],
  ['apps/desktop/src/components/search/SearchResultList.tsx:56', 'deliberately does'],
  ['packages/vacancy-engine/src/global-remote/report.ts:89', "'role_mismatch', 'non_vacancy'"],
  ['packages/vacancy-engine/src/global-remote/report.ts:194', 'latest.audit.ndjson'],
  ['README.md:25', 'frontend-only'],
];

describe('#694 memo references', () => {
  it('cites real files and in-range lines', () => {
    expect(references.length).toBeGreaterThan(30);
    const broken = references.filter(({ path, line }) => {
      if (!existsSync(join(root, path))) return true;
      return line !== null && (line < 1 || line > linesOf(path).length);
    });
    expect(broken).toEqual([]);
  });

  it('keeps the load-bearing citations pointing at the code they describe', () => {
    for (const [reference, text] of ANCHORS) {
      expect(memo, `memo cites ${reference}`).toContain(`\`${reference}\``);
      const [path, line] = reference.split(':') as [string, string];
      expect(linesOf(path)[Number(line) - 1], reference).toContain(text);
    }
  });
});
