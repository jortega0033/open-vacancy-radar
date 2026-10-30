// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { app, contribution, job, key, score, variant } from './builders.js';
import { GATES, deepFreeze, outcomeOfStatus } from './contract.js';
import { boundsOf, buildFunnel, cellLabelsOf, outcomeOfApplication } from './funnel.js';

const AS_OF = '2026-10-30T00:00:00.000Z';
const old = '2026-08-01T00:00:00.000Z'; // 90 days before AS_OF: mature
const fresh = '2026-10-20T00:00:00.000Z'; // 10 days: censored

describe('funnel denominators and observation windows', () => {
  it('counts a requisition once even when it was seen through two sources, and reports the overlap instead of summing it away', () => {
    const multi = job('multi', { contributions: [contribution('greenhouse'), contribution('remotive')], copies: 2, applications: [app('a1', 'user_stated', { sentAt: old })] });
    const single = job('single', { contributions: [contribution('greenhouse')] });
    const view = buildFunnel(deepFreeze([multi, single]), { dimension: 'source', asOf: AS_OF });
    expect(view.totals.distinctRequisitions).toBe(2);
    expect(view.totals.sumOfCells).toBe(3);
    expect(view.totals.overlap).toBe(1);
    expect(view.totals.sourceRowsRead).toBe(3);
    expect(view.totals.copiesCollapsed).toBe(1);
    const sentCells = view.cells.filter((cell) => cell.sent > 0);
    expect(sentCells.map((cell) => cell.label).sort()).toEqual(['greenhouse', 'remotive']);
    // The one sent requisition is in both cells but only once in the total.
    expect(view.totals.sentRequisitions).toBe(1);
    expect(view.notes.join(' ')).toContain('overlap');
  });

  it('keeps no recorded outcome in the denominator and returns bounds, never an imputed rate', () => {
    const jobs = [
      job('r', { applications: [app('r1', 'user_stated', { sentAt: old, status: 'rejected' })] }),
      job('i', { applications: [app('i1', 'user_reported', { sentAt: old, status: 'interview' })] }),
      job('u1', { applications: [app('u11', 'user_stated', { sentAt: old, status: 'applied' })] }),
      job('u2', { applications: [app('u21', 'receipt_backed', { sentAt: old, status: 'applied' })] }),
    ];
    const cell = buildFunnel(jobs, { dimension: 'source', asOf: AS_OF }).cells[0]!;
    expect(cell.matureSent).toBe(4);
    expect(cell.outcomes).toMatchObject({ no_recorded_outcome: 2, rejected_recorded: 1, reply_recorded: 1 });
    expect(cell.progressed).toEqual({ known: 1, unknown: 2, n: 4, lower: 0.25, upper: 0.75 });
    expect(cell.rejectedRecorded).toMatchObject({ lower: 0.25, upper: 0.75 });
  });

  it('treats a recent send as censored, an undated send as undated, and neither as "no outcome"', () => {
    const jobs = [
      job('young', { applications: [app('y', 'user_stated', { sentAt: fresh })] }),
      job('undated', { applications: [app('n', 'user_stated', { sentAt: null })] }),
      job('mature', { applications: [app('m', 'user_stated', { sentAt: old })] }),
    ];
    const view = buildFunnel(jobs, { dimension: 'source', asOf: AS_OF });
    expect(view.totals).toMatchObject({ sentRequisitions: 3, matureSent: 1, censoredSent: 1, undatedSent: 1, unknownOutcomes: 1 });
    const cell = view.cells[0]!;
    expect(cell.outcomes.no_recorded_outcome).toBe(1);
    expect(cell.censoredSent + cell.undatedSent + cell.matureSent).toBe(cell.sent);
  });

  it('does not count prepared, unconfirmed or tracked-only rows as sent', () => {
    const jobs = [
      job('prep', { applications: [app('p', 'prepared', { status: 'preparing' })] }),
      job('unconf', { applications: [app('u', 'unconfirmed', { sentAt: old, status: 'preparing' })] }),
      job('none', { applications: [app('n', 'not_recorded', { status: 'preparing' })] }),
      job('selected-only'),
    ];
    const view = buildFunnel(jobs, { dimension: 'source', asOf: AS_OF });
    expect(view.totals.sentRequisitions).toBe(0);
    expect(view.cells[0]).toMatchObject({ requisitions: 4, withApplicationRow: 3, sent: 0, matureSent: 0 });
  });

  it('counts a reapplication once as a requisition and takes the outcome of the latest sent application', () => {
    const reapplied = job('re', {
      applications: [
        app('first', 'receipt_backed', { sentAt: '2026-06-01T00:00:00.000Z', status: 'rejected' }),
        app('second', 'user_reported', { sentAt: '2026-08-01T00:00:00.000Z', status: 'interview', reapplicationOf: 'first' }),
      ],
    });
    const view = buildFunnel([reapplied], { dimension: 'source', asOf: AS_OF });
    expect(view.totals).toMatchObject({ distinctRequisitions: 1, sentRequisitions: 1, matureSent: 1, reapplicationRows: 1 });
    expect(view.cells[0]!.outcomes).toMatchObject({ reply_recorded: 1, rejected_recorded: 0 });
  });

  it('isolates a second role at the same employer: it is its own requisition and own outcome', () => {
    const one = job('role-a', { requisition: key('requisition', 'ats:acme:1'), applications: [app('a', 'user_stated', { sentAt: old, status: 'rejected' })] });
    const two = job('role-b', { requisition: key('requisition', 'ats:acme:2'), applications: [app('b', 'user_stated', { sentAt: old, status: 'applied' })] });
    const cell = buildFunnel([one, two], { dimension: 'source', asOf: AS_OF }).cells[0]!;
    expect(cell.requisitions).toBe(2);
    expect(cell.outcomes).toMatchObject({ rejected_recorded: 1, no_recorded_outcome: 1 });
  });

  it('puts unscored jobs in an explicit bucket instead of a zero-fit or an inferred role family', () => {
    const unscored = job('u', { score: score(null), applications: [app('x', 'user_stated', { sentAt: old })] });
    expect(unscored.score).toEqual({ state: 'unscored', value: null, roleFamily: null });
    const view = buildFunnel([unscored, job('s', { score: score(80, 'Platform Engineer') })], { dimension: 'roleFamily', asOf: AS_OF });
    expect(view.cells.map((cell) => cell.label).sort()).toEqual(['(not scored: role family unknown)', 'Platform Engineer']);
    expect(cellLabelsOf(job('t', { score: score(null) }), 'roleFamily')).toEqual(['(not scored: role family unknown)']);
  });

  it('treats a held interview round as a recorded reply even when the status was never updated, and says which evidence', () => {
    const held = app('h', 'user_stated', { sentAt: old, status: 'applied', heldRounds: 1 });
    expect(outcomeOfStatus('applied')).toBe('no_recorded_outcome');
    expect(outcomeOfApplication(held)).toBe('reply_recorded');
  });

  it('gives bounds a null rate when there is nothing to divide', () => {
    expect(boundsOf(0, 0, 0)).toEqual({ known: 0, unknown: 0, n: 0, lower: null, upper: null });
  });

  it('does not mutate its input', () => {
    const input = deepFreeze([job('a', { applications: [app('x', 'user_stated', { sentAt: old })] })]);
    expect(() => buildFunnel(input, { dimension: 'queryVariant', asOf: AS_OF })).not.toThrow();
  });
});

describe('query variant attribution', () => {
  it('lists a requisition under every variant that reached it, and under "not recorded" when none was stored', () => {
    const attributed = job('a', { contributions: [contribution('greenhouse', [variant('literal'), variant('title-2', 'matched_locally')])] });
    const unattributed = job('b', { contributions: [contribution('greenhouse')] });
    const view = buildFunnel([attributed, unattributed], { dimension: 'queryVariant', asOf: AS_OF });
    expect(view.cells.map((cell) => cell.label).sort()).toEqual(['(query variant not recorded)', 'literal', 'title-2']);
    expect(view.totals.distinctRequisitions).toBe(2);
    expect(view.totals.overlap).toBe(1);
  });

  it('has no query-variant view at all when attribution was not stored', () => {
    const view = buildFunnel([job('a'), job('b')], { dimension: 'queryVariant', asOf: AS_OF });
    expect(view.metrics.perCellOutcomeComparison.verdict).toBe('no_go');
    expect(view.metrics.perCellOutcomeComparison.reasons).toContain('no_query_attribution');
  });
});

describe('no-go verdicts, per metric', () => {
  const many = (count: number, make: (index: number) => ReturnType<typeof job>) => Array.from({ length: count }, (_, index) => make(index));

  it('refuses every outcome view on a small sample and names the reason', () => {
    const view = buildFunnel([job('a', { applications: [app('x', 'user_stated', { sentAt: old, status: 'rejected' })] })], { dimension: 'source', asOf: AS_OF });
    expect(view.metrics.outcomeDistribution).toEqual({ verdict: 'no_go', reasons: ['too_few_mature_sent'] });
  });

  it('refuses outcome views when unknown outcomes dominate', () => {
    const jobs = many(GATES.minMatureSent + 2, (index) =>
      job(`j${index}`, { contributions: [contribution(index % 2 ? 'greenhouse' : 'lever')], applications: [app(`a${index}`, 'user_stated', { sentAt: old, status: index < 4 ? 'interview' : 'applied' })] }),
    );
    const view = buildFunnel(jobs, { dimension: 'source', asOf: AS_OF });
    expect(view.metrics.outcomeDistribution.reasons).toContain('unknown_outcomes_dominate');
    expect(view.metrics.outcomeDistribution.verdict).toBe('no_go');
  });

  it('refuses when copies dominate the rows read, and when weak identities dominate the requisitions', () => {
    const copies = many(GATES.minMatureSent, (index) => job(`c${index}`, { copies: 4, applications: [app(`a${index}`, 'user_stated', { sentAt: old, status: 'interview' })] }));
    expect(buildFunnel(copies, { dimension: 'source', asOf: AS_OF }).metrics.outcomeDistribution.reasons).toContain('duplicate_copies_dominate');
    const weak = many(GATES.minMatureSent, (index) =>
      job(`w${index}`, { requisition: key('semantic', `co :: role ${index} :: nl`), applications: [app(`a${index}`, 'user_stated', { sentAt: old, status: 'interview' })] }),
    );
    expect(buildFunnel(weak, { dimension: 'source', asOf: AS_OF }).metrics.outcomeDistribution.reasons).toContain('weak_identity_dominates');
  });

  it('allows review of the outcome distribution only when every gate passes, still without lead-to-saved or time-to-reply', () => {
    const jobs = many(GATES.minMatureSent + 4, (index) =>
      job(`ok${index}`, { contributions: [contribution(index % 2 ? 'greenhouse' : 'lever')], applications: [app(`a${index}`, 'user_stated', { sentAt: old, status: index % 3 === 0 ? 'rejected' : 'interview' })] }),
    );
    const view = buildFunnel(jobs, { dimension: 'source', asOf: AS_OF });
    expect(view.metrics.outcomeDistribution).toEqual({ verdict: 'go_review', reasons: [] });
    expect(view.metrics.perCellOutcomeComparison.verdict).toBe('go_review');
    expect(view.metrics.leadToSelected).toEqual({ verdict: 'no_go', reasons: ['no_exposure_denominator'] });
    expect(view.metrics.timeToReply).toEqual({ verdict: 'no_go', reasons: ['no_status_timestamps'] });
  });

  it('lets a lead-to-selected share exist only when an exposure count was supplied for that cell (projected lane)', () => {
    const jobs = [job('a', { contributions: [contribution('lever')] })];
    const view = buildFunnel(jobs, { dimension: 'source', asOf: AS_OF, exposure: { lever: 40 } });
    expect(view.cells[0]!.selectedOfExposed).toEqual({ exposed: 40, selected: 1 });
    expect(view.metrics.leadToSelected.reasons).not.toContain('no_exposure_denominator');
  });
});
