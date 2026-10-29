import { z } from 'zod';
import {
  COMPANY_EVIDENCE_TOPICS,
  type CompanyEvidenceProseFact,
  type CompanyEvidenceResult,
  type CompanyEvidenceTopic,
} from './company-evidence.js';
import {
  addFact,
  cancelResearch,
  confirmDomain,
  confirmFact,
  correctFact,
  decideLink,
  deleteRecordFor,
  getView,
  proseEvidence,
  refreshEvidence,
  researchCompany,
  resolveContradiction,
  withdrawFact,
  type CompanyEvidenceDeps,
  type CompanyEvidenceRuns,
  type EvidenceTarget,
} from './company-evidence-service.js';
import { WorkspaceNotFoundError } from './workspace/repository.js';

/**
 * The `company-evidence:*` IPC surface (#689) as plain functions, so `main.ts` only registers them
 * and the tests drive exactly what the renderer reaches. Input is parsed strictly (unknown keys are
 * refused), every mutation runs through the caller's data-reset gate, and nothing here accepts a
 * CV, a note or a letter: the only candidate-side data that can arrive is an attempt or application
 * id, which resolves to public vacancy fields in the service.
 */

const Id = z.string().trim().min(1).max(200);
const TargetShape = { attemptId: Id.optional(), applicationId: Id.optional() };
const Topic = z.enum(COMPANY_EVIDENCE_TOPICS as [CompanyEvidenceTopic, ...CompanyEvidenceTopic[]]);

interface TargetFields {
  attemptId?: string | undefined;
  applicationId?: string | undefined;
}

function withTarget<T extends z.ZodRawShape>(shape: T) {
  return z
    .object({ ...TargetShape, ...shape })
    .strict()
    .refine(
      (value) => {
        const fields = value as TargetFields;
        return (fields.attemptId === undefined) !== (fields.applicationId === undefined);
      },
      { message: 'exactly one of attemptId or applicationId is required' },
    );
}

const GetInput = withTarget({});
const ConfirmDomainInput = withTarget({ domain: z.string().trim().min(3).max(253), entityRef: z.string().trim().max(80).optional() });
const AddFactInput = withTarget({
  claim: z.string().trim().min(1).max(2000),
  sourceUrl: z.string().trim().min(1).max(2048),
  quote: z.string().max(4000).default(''),
  scope: z.enum(['company', 'role']),
  topic: Topic.default('general'),
  sourceKind: z.enum(['company_site', 'ats_posting', 'public_web', 'ind_register']).optional(),
  observedAt: z.string().max(40).optional(),
});
const FactInput = withTarget({ factId: Id });
const CorrectInput = withTarget({ factId: Id, claim: z.string().trim().min(1).max(2000), quote: z.string().trim().max(4000).optional() });
const ResolveInput = withTarget({ contradictionId: Id, keepFactId: Id });
const LinkInput = withTarget({ linkId: Id, decision: z.enum(['confirmed', 'rejected']) });
const ResearchInput = withTarget({ topics: z.array(Topic).max(9).optional(), includeRole: z.boolean().optional() });

function targetOf(input: unknown): EvidenceTarget {
  const value = input as TargetFields;
  return value.attemptId !== undefined ? { attemptId: value.attemptId } : { applicationId: value.applicationId! };
}

export interface CompanyEvidenceIpcDeps {
  service(): Promise<CompanyEvidenceDeps>;
  runs: CompanyEvidenceRuns;
  /** The data-reset gate: mutations wait for / are refused during a reset. */
  mutate<T>(task: () => T | Promise<T>): Promise<T>;
}

type Handler = (input: unknown) => Promise<unknown>;

const INVALID: CompanyEvidenceResult = { ok: false, code: 'invalid_request', message: 'That request was not understood.' };

export function createCompanyEvidenceHandlers(deps: CompanyEvidenceIpcDeps): Record<string, Handler> {
  async function run<S extends z.ZodTypeAny>(
    schema: S,
    input: unknown,
    body: (parsed: z.infer<S>, service: CompanyEvidenceDeps) => CompanyEvidenceResult | Promise<CompanyEvidenceResult>,
    mutation: boolean,
  ): Promise<CompanyEvidenceResult> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return INVALID;
    const task = async (): Promise<CompanyEvidenceResult> => {
      try {
        return await body(parsed.data, await deps.service());
      } catch (error) {
        if (error instanceof WorkspaceNotFoundError) {
          return { ok: false, code: 'not_found', message: 'That application is no longer in your list.' };
        }
        // Stable, content-free failure: never echo an error that could carry stored text.
        return { ok: false, code: 'failed', message: 'Something went wrong. Nothing was changed.' };
      }
    };
    return mutation ? deps.mutate(task) : task();
  }

  return {
    'company-evidence:get': (input) =>
      run(GetInput, input, (v, s) => ({ ok: true, view: getView(s, targetOf(v)), notice: '' }), false),
    'company-evidence:prose': async (input): Promise<{ ok: boolean; facts: CompanyEvidenceProseFact[] }> => {
      const parsed = GetInput.safeParse(input);
      if (!parsed.success) return { ok: false, facts: [] };
      try {
        return { ok: true, facts: proseEvidence(await deps.service(), targetOf(parsed.data), 'interview') };
      } catch {
        return { ok: false, facts: [] };
      }
    },
    'company-evidence:confirm-domain': (input) =>
      run(ConfirmDomainInput, input, (v, s) => confirmDomain(s, targetOf(v), { domain: v.domain, ...(v.entityRef ? { entityRef: v.entityRef } : {}) }), true),
    'company-evidence:add-fact': (input) =>
      run(
        AddFactInput,
        input,
        (v, s) =>
          addFact(s, targetOf(v), {
            claim: v.claim,
            sourceUrl: v.sourceUrl,
            quote: v.quote,
            scope: v.scope,
            topic: v.topic,
            ...(v.sourceKind ? { sourceKind: v.sourceKind } : {}),
            ...(v.observedAt ? { observedAt: v.observedAt } : {}),
          }),
        true,
      ),
    'company-evidence:confirm-fact': (input) => run(FactInput, input, (v, s) => confirmFact(s, targetOf(v), v.factId), true),
    'company-evidence:correct-fact': (input) => run(CorrectInput, input, (v, s) => correctFact(s, targetOf(v), v.factId, v.claim, v.quote ?? ''), true),
    'company-evidence:withdraw-fact': (input) => run(FactInput, input, (v, s) => withdrawFact(s, targetOf(v), v.factId), true),
    'company-evidence:resolve-contradiction': (input) =>
      run(ResolveInput, input, (v, s) => resolveContradiction(s, targetOf(v), v.contradictionId, v.keepFactId), true),
    'company-evidence:decide-link': (input) => run(LinkInput, input, (v, s) => decideLink(s, targetOf(v), v.linkId, v.decision), true),
    'company-evidence:delete': (input) => run(GetInput, input, (v, s) => deleteRecordFor(s, targetOf(v), deps.runs), true),
    // Long-running actions are NOT wrapped in the reset gate for their whole duration (a reset would
    // be blocked for up to a minute); the reset cancels them first and every write they make
    // re-checks that the record still exists.
    'company-evidence:refresh': (input) => run(GetInput, input, (v, s) => refreshEvidence(s, targetOf(v), deps.runs), false),
    'company-evidence:research': (input) =>
      run(
        ResearchInput,
        input,
        (v, s) =>
          researchCompany(
            s,
            targetOf(v),
            { ...(v.topics ? { topics: v.topics } : {}), ...(v.includeRole !== undefined ? { includeRole: v.includeRole } : {}) },
            deps.runs,
          ),
        false,
      ),
    'company-evidence:cancel': async (input) => {
      const parsed = GetInput.safeParse(input);
      if (!parsed.success) return { ok: false };
      try {
        return { ok: true, cancelled: cancelResearch(await deps.service(), targetOf(parsed.data), deps.runs) };
      } catch {
        return { ok: false };
      }
    },
  };
}

export const COMPANY_EVIDENCE_CHANNELS = [
  'company-evidence:get',
  'company-evidence:prose',
  'company-evidence:confirm-domain',
  'company-evidence:add-fact',
  'company-evidence:confirm-fact',
  'company-evidence:correct-fact',
  'company-evidence:withdraw-fact',
  'company-evidence:resolve-contradiction',
  'company-evidence:decide-link',
  'company-evidence:delete',
  'company-evidence:refresh',
  'company-evidence:research',
  'company-evidence:cancel',
] as const;
