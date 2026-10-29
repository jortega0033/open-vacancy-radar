import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentEventEnvelope } from '@agent-dock/shared';
import {
  EMPTY_CANDIDATE_PROFILE,
  applyFocusedScanCriteria,
  type CandidateProfile,
  type DiscoveryVacancyAudit,
  type GlobalRemoteScanOptions,
  type GlobalRemoteScanResult,
} from '@open-vacancy-radar/vacancy-engine';
import { captureVacancyRunIntent } from '../electron/vacancy-run-intent.js';
import { runVacancyScanBranches, type AiWebSearchRunState } from '../electron/vacancy-scan-orchestration.js';
import { parseVacancyScanRequest } from '../electron/vacancy-scan-query.js';
import { runAiWebDiscovery, type RunAiWebDiscoveryOptions } from '../electron/vacancy-web-discovery.js';

// ---------------------------------------------------------------------------------------------
// #684: one frozen intent snapshot feeds BOTH branches of a run. These tests drive the real
// orchestration function and the real `runAiWebDiscovery` (prompt, session request, normalisation)
// with a fake daemon client and a fake `runGlobalRemoteScan`, and inspect what each of them was
// actually called with -- not source text.
// ---------------------------------------------------------------------------------------------

const WORKSPACE = '/tmp/ai-workspace-684';
const BROWSE_ALL_CAP = 5000;

const SAVED_FRONTEND_NL: CandidateProfile = {
  ...EMPTY_CANDIDATE_PROFILE,
  profileVersion: 'test',
  candidateName: 'Jane Doe',
  currentRole: 'Senior Frontend Engineer',
  location: 'Amsterdam',
  targetRoles: ['Frontend Engineer'],
  strongestSkills: ['TypeScript', 'React'],
  experienceYears: 5,
  constraints: {
    ...EMPTY_CANDIDATE_PROFILE.constraints,
    primaryCountry: 'Netherlands',
    allowRemoteEuSupportingNetherlands: true,
  },
};

function fencedJson(payload: unknown): string {
  return '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
}

function rawCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    company: 'Acme Corp',
    title: 'UI Engineer',
    url: 'https://acme.example/careers/ui-engineer-1',
    location: 'Berlin, Germany',
    description: null,
    employmentType: null,
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    postedAt: null,
    evidence: {
      salary: { stated: false, quote: null },
      location: { stated: true, quote: 'Berlin, Germany' },
      employmentType: { stated: false, quote: null },
      postedAt: { stated: false, quote: null },
      visaSponsorship: 'unknown',
      exactUrlVerified: true,
    },
    ...overrides,
  };
}

type SessionRequest = { provider: string; cwd: string; prompt: string };

function sessionClient(options: { answer?: (prompt: string) => unknown; duringSession?: () => void } = {}) {
  const create = vi.fn().mockResolvedValue({
    id: 'ai-web-session-684',
    provider: 'claude',
    cwd: WORKSPACE,
    prompt: 'x',
    status: 'starting',
    startedAt: new Date().toISOString(),
  });
  const client = {
    providers: {
      list: vi.fn().mockResolvedValue([
        { id: 'claude', name: 'Claude Code', installed: true, authenticated: 'authenticated', capabilities: {} },
      ]),
    },
    sessions: {
      createVacancyWebDiscovery: create,
      events: vi.fn().mockImplementation(async function* (): AsyncGenerator<AgentEventEnvelope, void, void> {
        // Whatever the person does while the session is running happens here, after the request was sent.
        options.duringSession?.();
        const prompt = (create.mock.calls[0]![0] as SessionRequest).prompt;
        const payload = options.answer ? options.answer(prompt) : { candidates: [], queriesUsed: ['q'] };
        const events: AgentEvent[] = [{ type: 'assistant.message', text: fencedJson(payload) }, { type: 'session.completed' }];
        for (const event of events) {
          yield { ...event, sequence: 0, timestamp: new Date().toISOString() } as AgentEventEnvelope;
        }
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
    },
  };
  return {
    client,
    create,
    /** The `{ provider, cwd, prompt }` object the daemon client really received. */
    sessionRequest(): SessionRequest {
      expect(create).toHaveBeenCalledTimes(1);
      return create.mock.calls[0]![0] as SessionRequest;
    },
  };
}

interface HarnessOptions {
  request: unknown;
  loadProfile?: () => Promise<CandidateProfile>;
  ensureAiWorkspace?: () => Promise<string>;
  client?: ReturnType<typeof sessionClient>;
  signal?: AbortSignal;
  /** Replaces the real AI branch, e.g. to build the pre-#684 request from the saved profile. */
  aiBranch?: (
    options: RunAiWebDiscoveryOptions,
    session: ReturnType<typeof sessionClient>,
  ) => ReturnType<typeof runAiWebDiscovery>;
}

function harness(options: HarnessOptions) {
  const session = options.client ?? sessionClient();
  const scanCalls: GlobalRemoteScanOptions[] = [];
  const aiStates: AiWebSearchRunState[] = [];
  const logged: Array<{ level: string; object: unknown; message: string }> = [];
  const loadProfile = vi.fn(options.loadProfile ?? (async () => SAVED_FRONTEND_NL));
  const ensureAiWorkspace = vi.fn(options.ensureAiWorkspace ?? (async () => WORKSPACE));
  const aiRuns: RunAiWebDiscoveryOptions[] = [];
  const log = (level: string) => (object: object, message: string) => {
    logged.push({ level, object, message });
  };
  const signal = options.signal ?? new AbortController().signal;
  const runScan = vi.fn(async (scanOptions: GlobalRemoteScanOptions): Promise<GlobalRemoteScanResult> => {
    scanCalls.push(scanOptions);
    return { report: { discoverySources: [] } } as unknown as GlobalRemoteScanResult;
  });
  const intent = captureVacancyRunIntent('scan-684-run', parseVacancyScanRequest(options.request));
  const run = () =>
    runVacancyScanBranches(
      {
        loadProfile,
        ensureAiWorkspace,
        runAiWebDiscovery: (aiOptions) => {
          aiRuns.push(aiOptions);
          return options.aiBranch ? options.aiBranch(aiOptions, session) : runAiWebDiscovery(session.client as never, aiOptions);
        },
        runGlobalRemoteScan: runScan,
        logger: { warn: log('warn'), info: log('info'), debug: log('debug') },
        signal,
        throwCancelled: () => {
          throw new Error('scan cancelled');
        },
        onAiState: (state) => aiStates.push(state),
        onProgress: vi.fn(),
        browseAllResultCap: BROWSE_ALL_CAP,
      },
      intent,
    );
  return { run, session, scanCalls, aiStates, logged, loadProfile, ensureAiWorkspace, aiRuns, runScan, intent };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runVacancyScanBranches: one submitted snapshot feeds both branches (#684)', () => {
  it('saved frontend/Netherlands + submitted UI engineer/Germany: the AI session and the scan options both carry the submitted criteria', async () => {
    const h = harness({
      request: { mode: 'query', query: 'UI engineer', country: 'Germany', employment: 'full_time', aiWebDiscovery: true },
      client: sessionClient({ answer: () => ({ candidates: [rawCandidate()], queriesUsed: ['ui engineer germany'] }) }),
    });
    await h.run();

    // The AI branch: the object the daemon client actually received.
    const request = h.session.sessionRequest();
    expect(request.provider).toBe('claude');
    expect(request.cwd).toBe(WORKSPACE);
    expect(request.prompt).toContain('- Role: "UI engineer"');
    expect(request.prompt).toContain('- Country: "Germany"');
    expect(request.prompt).not.toContain('Frontend Engineer');
    expect(request.prompt).not.toContain('Netherlands');

    // The deterministic branch: the options runGlobalRemoteScan actually received.
    expect(h.scanCalls).toHaveLength(1);
    const options = h.scanCalls[0]!;
    expect(options).toMatchObject({ query: 'UI engineer', country: 'Germany', employment: 'full_time' });
    expect(options).not.toHaveProperty('browseAll');
    expect(options.signal).toBeDefined();
    expect(options.onProgress).toBeTypeOf('function');
    expect(options).not.toHaveProperty('salary');

    // Both come from the one snapshot, and the AI step ran on the saved profile only as background.
    expect(h.aiRuns).toHaveLength(1);
    expect(h.aiRuns[0]!.intent).toBe(h.intent);
    expect(h.aiRuns[0]!.profile).toBe(SAVED_FRONTEND_NL);
    expect(h.aiStates).toEqual(['running', 'done']);
    expect(h.ensureAiWorkspace).toHaveBeenCalledTimes(1);

    // The AI rows and their audit, with the intent provenance, are handed on to the scan unchanged.
    expect(options.aiWebDiscoveryVacancies).toHaveLength(1);
    expect(options.aiWebDiscoveryVacancies![0]).toMatchObject({ provider: 'ai_web_search', company: 'Acme Corp' });
    expect(options.aiWebDiscoverySourceAudit).toMatchObject({
      id: 'ai_web_search',
      status: 'success',
      aiSearchIntent: {
        intentVersion: 1,
        scanId: 'scan-684-run',
        mode: 'query',
        criteria: {
          role: { value: 'UI engineer', pushdown: 'prompt_guidance' },
          country: { value: 'Germany', pushdown: 'prompt_guidance' },
          employment: { value: 'full_time', pushdown: 'prompt_guidance' },
        },
      },
    });
  });

  it('includes a submitted salary floor in the scan options and tells the model it is local-only', async () => {
    const h = harness({
      request: {
        mode: 'query',
        query: 'UI engineer',
        country: 'Germany',
        salary: { minimumAnnual: '65000', currency: 'eur', includeUnknown: false },
        aiWebDiscovery: true,
      },
    });
    await h.run();
    expect(h.scanCalls[0]!.salary).toEqual({ minimumAnnual: 65_000, currency: 'EUR', includeUnknown: false });
    expect(h.session.sessionRequest().prompt).toContain('web search cannot filter by salary');
    expect(h.scanCalls[0]!.aiWebDiscoverySourceAudit?.aiSearchIntent?.criteria.salary).toMatchObject({
      pushdown: 'unsupported',
      enforcedLocally: true,
    });
  });

  it('a profile (and request object) changed while the AI session is running cannot change either branch', async () => {
    const parsed = parseVacancyScanRequest({ mode: 'query', query: 'UI engineer', country: 'Germany', aiWebDiscovery: true });
    let savedProfile: CandidateProfile = SAVED_FRONTEND_NL;
    const h = harness({
      request: parsed,
      loadProfile: async () => savedProfile,
      client: sessionClient({
        duringSession: () => {
          // The person edits the saved profile and something mutates the parsed request mid-run.
          savedProfile = {
            ...SAVED_FRONTEND_NL,
            targetRoles: ['Data Scientist'],
            constraints: { ...SAVED_FRONTEND_NL.constraints, primaryCountry: 'Spain' },
          };
          SAVED_FRONTEND_NL.targetRoles.push('Data Scientist');
          (parsed as { query: string }).query = 'Data Scientist';
          (parsed as { country?: string }).country = 'Spain';
        },
      }),
    });
    try {
      await h.run();
    } finally {
      SAVED_FRONTEND_NL.targetRoles.pop();
    }
    const { prompt } = h.session.sessionRequest();
    expect(prompt).toContain('- Role: "UI engineer"');
    expect(prompt).toContain('- Country: "Germany"');
    expect(prompt).not.toContain('Data Scientist');
    expect(prompt).not.toContain('Spain');
    expect(h.scanCalls[0]).toMatchObject({ query: 'UI engineer', country: 'Germany' });
    expect(h.scanCalls[0]!.aiWebDiscoverySourceAudit?.aiSearchIntent?.criteria.role.value).toBe('UI engineer');
    // The saved profile is read once, up front, for background only.
    expect(h.loadProfile).toHaveBeenCalledTimes(1);
  });

  it('browse-all: no role or country reaches either branch, and saved target roles do not turn it into a query', async () => {
    const h = harness({ request: { mode: 'browse_all', aiWebDiscovery: true } });
    await h.run();
    const { prompt } = h.session.sessionRequest();
    expect(prompt).toContain('- Mode: browse all.');
    expect(prompt).toContain('- Role: none requested.');
    expect(prompt).not.toContain('Frontend Engineer');
    expect(prompt).not.toContain('- Mode: targeted search.');
    expect(h.scanCalls[0]).toMatchObject({ query: '', browseAll: true, browseAllResultCap: BROWSE_ALL_CAP });
    expect(h.scanCalls[0]).not.toHaveProperty('country');
    expect(h.scanCalls[0]).not.toHaveProperty('employment');
    expect(h.scanCalls[0]).not.toHaveProperty('salary');
    expect(h.scanCalls[0]!.aiWebDiscoverySourceAudit?.aiSearchIntent).toMatchObject({
      mode: 'browse_all',
      criteria: { role: { requested: false }, country: { requested: false } },
      candidateContext: { savedTargetRolesSearched: false },
    });
  });

  it('"Unspecified location" reaches the scan as the sentinel the engine filters on, and the AI step as a local-only rule', async () => {
    const h = harness({ request: { mode: 'query', query: 'UI engineer', country: '  unspecified LOCATION ', aiWebDiscovery: true } });
    await h.run();
    expect(h.scanCalls[0]).toMatchObject({ query: 'UI engineer', country: 'unspecified LOCATION' });
    const { prompt } = h.session.sessionRequest();
    expect(prompt.toLowerCase()).not.toContain('unspecified location');
    expect(prompt).toContain('no identifiable country');
    expect(h.scanCalls[0]!.aiWebDiscoverySourceAudit?.aiSearchIntent?.criteria.country).toMatchObject({
      requested: true,
      pushdown: 'unsupported',
      enforcedLocally: true,
    });
  });

  it('without AI search nothing AI is touched and the scan options carry no AI fields', async () => {
    const h = harness({ request: { mode: 'query', query: 'UI engineer', country: 'Germany' } });
    await h.run();
    expect(h.loadProfile).not.toHaveBeenCalled();
    expect(h.ensureAiWorkspace).not.toHaveBeenCalled();
    expect(h.aiRuns).toHaveLength(0);
    expect(h.session.create).not.toHaveBeenCalled();
    expect(h.aiStates).toEqual([]);
    expect(Object.keys(h.scanCalls[0]!).sort()).toEqual(['country', 'onProgress', 'query', 'signal']);
  });

  it('keeps the profile gate: an unconfigured profile starts no session but the scan still runs on the submitted criteria', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness({
      request: { mode: 'query', query: 'UI engineer', country: 'Germany', aiWebDiscovery: true },
      loadProfile: async () => EMPTY_CANDIDATE_PROFILE,
    });
    await h.run();
    expect(h.session.create).not.toHaveBeenCalled();
    expect(h.aiStates).toEqual(['running', 'failed']);
    expect(h.scanCalls[0]).toMatchObject({ query: 'UI engineer', country: 'Germany' });
    expect(h.scanCalls[0]!.aiWebDiscoverySourceAudit).toMatchObject({ status: 'blocked' });
    expect(h.scanCalls[0]!.aiWebDiscoverySourceAudit).not.toHaveProperty('aiSearchIntent');
    expect(h.scanCalls[0]!.aiWebDiscoveryVacancies).toEqual([]);
  });

  it('a failing profile read degrades to a scan without the AI step, never aborts it', async () => {
    const h = harness({
      request: { mode: 'query', query: 'UI engineer', country: 'Germany', aiWebDiscovery: true },
      loadProfile: async () => {
        throw new Error('profile file is malformed');
      },
    });
    await h.run();
    expect(h.session.create).not.toHaveBeenCalled();
    expect(h.aiStates).toEqual(['failed']);
    expect(h.logged.find((entry) => entry.level === 'warn')?.message).toContain('AI web discovery setup failed');
    expect(Object.keys(h.scanCalls[0]!).sort()).toEqual(['country', 'onProgress', 'query', 'signal']);
  });

  it('a stop requested during the AI step cancels the run before the scan starts', async () => {
    const controller = new AbortController();
    const h = harness({
      request: { mode: 'query', query: 'UI engineer', aiWebDiscovery: true },
      signal: controller.signal,
      client: sessionClient({ duringSession: () => controller.abort() }),
    });
    await expect(h.run()).rejects.toThrow('scan cancelled');
    expect(h.runScan).not.toHaveBeenCalled();
  });

  it('logs the intent provenance (search terms and counts) and never CV text, skill names or the prompt', async () => {
    const h = harness({ request: { mode: 'query', query: 'UI engineer', country: 'Germany', aiWebDiscovery: true } });
    await h.run();
    const info = h.logged.filter((entry) => entry.message === 'AI web discovery intent');
    expect(info).toHaveLength(1);
    expect(info[0]!.object).toMatchObject({
      aiSearchIntent: { scanId: 'scan-684-run', candidateContext: { skillCount: 2, savedTargetRolesSearched: false } },
    });
    const everything = JSON.stringify(h.logged.filter((entry) => entry.message === 'AI web discovery intent'));
    for (const forbidden of ['TypeScript', 'React', 'Jane Doe', 'Senior Frontend Engineer', 'WebSearch', 'YOUR TASK']) {
      expect(everything).not.toContain(forbidden);
    }
  });
});

describe('measurement on one synthetic fixture, through the orchestration wiring (#684)', () => {
  // WHAT THIS IS: a deterministic stand-in for the model that returns every fixture posting fitting
  // the Role and Country lines of the prompt it was really sent. Both branches run through the real
  // orchestration function: the AI branch is the real `runAiWebDiscovery` on a fake daemon client, and
  // the deterministic branch is a fake `runGlobalRemoteScan` that applies the engine's real
  // `applyFocusedScanCriteria` to the criteria it was really called with. The counts therefore show
  // what the prompt wording does to the stand-in, plus how many calls each branch made. They are NOT
  // a real-model result: nothing here measures recall, cost or search quality, and none is claimed.
  const FIXTURE_POSTINGS = [
    { company: 'A', title: 'Frontend Engineer', location: 'Amsterdam, Netherlands' },
    { company: 'B', title: 'Frontend Engineer', location: 'Utrecht, Netherlands' },
    { company: 'C', title: 'UI Engineer', location: 'Berlin, Germany' },
    { company: 'D', title: 'UI Engineer', location: 'Munich, Germany' },
    { company: 'E', title: 'UI Engineer', location: 'Amsterdam, Netherlands' },
    { company: 'F', title: 'Backend Engineer', location: 'Berlin, Germany' },
  ];

  function standInAnswer(prompt: string) {
    const role = /- Role: "([^"]*)"/u.exec(prompt)?.[1] ?? '';
    const country = /- Country: "([^"]*)"/u.exec(prompt)?.[1] ?? null;
    const found = FIXTURE_POSTINGS.filter(
      (posting) =>
        posting.title.toLowerCase().includes(role.toLowerCase()) && (country === null || posting.location.includes(country)),
    );
    return {
      candidates: found.map((posting) =>
        rawCandidate({
          company: posting.company,
          title: posting.title,
          location: posting.location,
          url: `https://fixture.example/${posting.company}`,
        }),
      ),
      queriesUsed: ['fixture'],
    };
  }

  /** Counts sessions and scan calls, and how many AI rows the scan's own criteria would reject. */
  async function measure(aiBranch?: HarnessOptions['aiBranch']) {
    const session = sessionClient({ answer: standInAnswer });
    const h = harness({
      request: { mode: 'query', query: 'UI engineer', country: 'Germany', aiWebDiscovery: true },
      client: session,
      ...(aiBranch ? { aiBranch } : {}),
    });
    await h.run();
    const scan = h.scanCalls[0]!;
    const aiRows: DiscoveryVacancyAudit[] = scan.aiWebDiscoveryVacancies ?? [];
    const kept = applyFocusedScanCriteria(aiRows, {
      role: scan.query ?? '',
      country: scan.country ?? null,
      employment: scan.employment ?? null,
    }).vacancies.length;
    return {
      aiSessionCalls: session.create.mock.calls.length,
      deterministicScanCalls: h.scanCalls.length,
      aiRowsReturned: aiRows.length,
      aiRowsKeptByLocalFilter: kept,
      aiRowsRejectedByLocalFilter: aiRows.length - kept,
    };
  }

  it('the stand-in finds only locally kept rows when the AI step is given the submitted intent; both branches make one call', async () => {
    const submitted = await measure();
    expect(submitted).toEqual({
      aiSessionCalls: 1,
      deterministicScanCalls: 1,
      aiRowsReturned: 2,
      aiRowsKeptByLocalFilter: 2,
      aiRowsRejectedByLocalFilter: 0,
    });
  });

  it('the same stand-in, given a request built from the saved profile (how the AI step ran before #684), returns rows the scan rejects', async () => {
    // Stand-in for the old wiring: the AI branch's intent comes from the saved profile while the scan
    // keeps the submitted criteria.
    const profileDerivedAiBranch: HarnessOptions['aiBranch'] = (options, session) =>
      runAiWebDiscovery(session.client as never, {
        ...options,
        intent: captureVacancyRunIntent('scan-684-legacy', {
          mode: 'query',
          query: options.profile.targetRoles[0]!,
          country: options.profile.constraints.primaryCountry,
          aiWebDiscovery: true,
        }),
      });
    const legacy = await measure(profileDerivedAiBranch);
    expect(legacy).toEqual({
      aiSessionCalls: 1,
      deterministicScanCalls: 1,
      aiRowsReturned: 2,
      aiRowsKeptByLocalFilter: 0,
      aiRowsRejectedByLocalFilter: 2,
    });
  });
});
