import {
  GATES,
  SENT_CLASSES,
  copiesSeenOf,
  outcomeOfStatus,
  type ApplicationObservation,
  type EvidenceType,
  type JobObservation,
  type NoGoReason,
  type RecordedOutcome,
  type Verdict,
} from './contract.js';

/**
 * View 1: funnel observations by source / query variant / role family.
 *
 * Rules (each is covered by a test):
 *  - The unit is a DISTINCT REQUISITION (`JobObservation`), never a source row. Syndicated copies were
 *    collapsed before this point and TWO overlapping measures of that are reported, never added:
 *    saved-job rows merged (`savedRowsCollapsed`) and source contributions that brief aliases merged before the
 *    job was saved (`aliasContributionsMerged`). The duplicate gate uses `copiesSeen` = per requisition the larger
 *    of the two, a stated lower bound (a saved copy and a contribution can be the same copy).
 *  - Query variants: a variant cell also splits its requisitions by `QueryRef.via`: `fetchedUpstream` = the source
 *    received that query at least once for this requisition; `matchedLocallyOnly` = only the shared local filter
 *    found it under that variant. Pooling the two would credit a variant the source never saw, so the projected
 *    selected-of-exposed ratio counts fetchedUpstream only. (`QueryRef.field` title/description is carried, not split.)
 *  - A requisition seen through several sources/variants is counted in EACH of those cells, so the cells
 *    overlap by design. Every table carries the distinct total and `overlap = sum(cells) - distinct`; the
 *    cells are never presented as a partition. No "first source wins" partition is offered because no
 *    contribution carries a first-seen time.
 *  - Funnel stages use only recorded facts: selected (saved/tracked) -> has an application row -> SENT
 *    (receipt_backed | user_reported | user_stated). Prepared, handed off, failed and unconfirmed are not sent.
 *  - Outcomes are counted only over MATURE sent applications (sent at least `maturityDays` before `asOf`).
 *    Younger ones are right-censored and reported separately; undated ones cannot be placed and are reported.
 *  - `no_recorded_outcome` is its own bucket. It is not rejection, ineligibility or failed delivery, and it
 *    stays in the denominator. Rates are returned only as bounds: lower = known / n, upper = (known + unknown) / n.
 *  - A reapplication (another sent application for the same requisition) is counted as one requisition; the
 *    extra rows are reported, and the requisition's outcome is that of its latest sent application.
 */

export type FunnelDimension = 'source' | 'queryVariant' | 'roleFamily';

export interface FunnelOptions {
  dimension: FunnelDimension;
  asOf: string;
  maturityDays?: number;
  /** PROJECTED (not recorded in production): distinct requisitions shown per cell label, from a scan digest. */
  exposure?: Record<string, number> | null;
}

export interface Bounds {
  known: number;
  unknown: number;
  n: number;
  lower: number | null;
  upper: number | null;
}

export interface FunnelCell {
  label: string;
  requisitions: number;
  /** Query-variant cells only (null for source / role family): how the requisitions in this cell reached the variant. Sums to `requisitions`. */
  via: { fetchedUpstream: number; matchedLocallyOnly: number } | null;
  withApplicationRow: number;
  sent: number;
  sentByEvidence: Record<Exclude<EvidenceType, 'app_recorded' | 'derived_at_read' | 'not_recorded'>, number>;
  matureSent: number;
  censoredSent: number;
  undatedSent: number;
  outcomes: Record<RecordedOutcome, number>;
  reapplicationRows: number;
  progressed: Bounds;
  rejectedRecorded: Bounds;
  weakKeyRequisitions: number;
  smallSample: boolean;
  /** Selected share of distinct requisitions shown, only when exposure was supplied (projected lane). */
  selectedOfExposed: { exposed: number; selected: number } | null;
}

export interface FunnelView {
  contract: 'funnel/0.1.0-research';
  dimension: FunnelDimension;
  asOf: string;
  maturityDays: number;
  cells: FunnelCell[];
  totals: {
    distinctRequisitions: number;
    sumOfCells: number;
    overlap: number;
    /** Saved-job rows read, and how many of them were extra copies of a requisition already counted. */
    savedRowsRead: number;
    savedRowsCollapsed: number;
    /** Distinct source contributions (provider + link) the brief aliases carry, and how many were merged into a requisition before saving. */
    sourceContributions: number;
    aliasContributionsMerged: number;
    /** The larger of the two per requisition, summed (never their sum), and the extra copies it implies. The duplicate gate reads these. */
    copiesSeen: number;
    copiesCollapsed: number;
    weakKeyRequisitions: number;
    sentRequisitions: number;
    matureSent: number;
    censoredSent: number;
    undatedSent: number;
    unknownOutcomes: number;
    reapplicationRows: number;
  };
  metrics: {
    outcomeDistribution: Verdict;
    perCellOutcomeComparison: Verdict;
    leadToSelected: Verdict;
    timeToReply: Verdict;
  };
  notes: string[];
}

const DAY = 24 * 60 * 60 * 1000;
const UNATTRIBUTED: Record<FunnelDimension, string> = {
  source: '(source not recorded)',
  queryVariant: '(query variant not recorded)',
  roleFamily: '(not scored: role family unknown)',
};

export function boundsOf(known: number, unknown: number, n: number): Bounds {
  return n === 0 ? { known, unknown, n, lower: null, upper: null } : { known, unknown, n, lower: known / n, upper: (known + unknown) / n };
}

function emptyOutcomes(): Record<RecordedOutcome, number> {
  return { no_recorded_outcome: 0, reply_recorded: 0, offer_recorded: 0, rejected_recorded: 0, withdrawn_recorded: 0 };
}

/** For a query-variant label: did the source receive this variant's query for the requisition (`fetched_upstream`), or did only the local filter find it? */
export function viaOfVariant(observation: JobObservation, variantId: string): 'fetched_upstream' | 'matched_locally_only' {
  for (const contribution of observation.contributions) {
    if (contribution.queryRefs === 'not_recorded') continue;
    if (contribution.queryRefs.some((ref) => ref.variantId === variantId && ref.via === 'fetched_upstream')) return 'fetched_upstream';
  }
  return 'matched_locally_only';
}

export function cellLabelsOf(observation: JobObservation, dimension: FunnelDimension): string[] {
  if (dimension === 'roleFamily') return [observation.score.roleFamily ?? UNATTRIBUTED.roleFamily];
  const labels = new Set<string>();
  for (const contribution of observation.contributions) {
    if (dimension === 'source') {
      if (contribution.provider !== null) labels.add(contribution.provider);
    } else if (contribution.queryRefs !== 'not_recorded') {
      for (const ref of contribution.queryRefs) labels.add(ref.variantId);
    }
  }
  return labels.size === 0 ? [UNATTRIBUTED[dimension]] : [...labels].sort();
}

/** Sent applications of a requisition, oldest first; undated first (they cannot be ordered, so they never outrank a dated one). */
export function sentApplicationsOf(observation: JobObservation): ApplicationObservation[] {
  return observation.applications
    .filter((application) => SENT_CLASSES.has(application.submission))
    .sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? '') || a.applicationId.localeCompare(b.applicationId));
}

/** The recorded outcome of one sent application: its status, or a held interview round if the status was never updated. */
export function outcomeOfApplication(application: ApplicationObservation): RecordedOutcome {
  const fromStatus = outcomeOfStatus(application.status);
  if (fromStatus === 'no_recorded_outcome' && application.heldRounds > 0) return 'reply_recorded';
  return fromStatus;
}

export function buildFunnel(observations: readonly JobObservation[], options: FunnelOptions): FunnelView {
  const maturityDays = options.maturityDays ?? GATES.defaultMaturityDays;
  const asOfMs = Date.parse(options.asOf);
  const cells = new Map<string, FunnelCell>();
  const cellFor = (label: string): FunnelCell => {
    let cell = cells.get(label);
    if (!cell) {
      cell = {
        label,
        requisitions: 0,
        via: options.dimension === 'queryVariant' ? { fetchedUpstream: 0, matchedLocallyOnly: 0 } : null,
        withApplicationRow: 0,
        sent: 0,
        sentByEvidence: { receipt_observed: 0, user_reported: 0, user_stated: 0 },
        matureSent: 0,
        censoredSent: 0,
        undatedSent: 0,
        outcomes: emptyOutcomes(),
        reapplicationRows: 0,
        progressed: boundsOf(0, 0, 0),
        rejectedRecorded: boundsOf(0, 0, 0),
        weakKeyRequisitions: 0,
        smallSample: true,
        selectedOfExposed: null,
      };
      cells.set(label, cell);
    }
    return cell;
  };

  const totals = {
    distinctRequisitions: observations.length,
    sumOfCells: 0,
    overlap: 0,
    savedRowsRead: 0,
    savedRowsCollapsed: 0,
    sourceContributions: 0,
    aliasContributionsMerged: 0,
    copiesSeen: 0,
    copiesCollapsed: 0,
    weakKeyRequisitions: 0,
    sentRequisitions: 0,
    matureSent: 0,
    censoredSent: 0,
    undatedSent: 0,
    unknownOutcomes: 0,
    reapplicationRows: 0,
  };
  let anyOutcomeWithoutTime = false;

  for (const observation of observations) {
    totals.savedRowsRead += observation.savedRows;
    totals.savedRowsCollapsed += Math.max(0, observation.savedRows - 1);
    totals.sourceContributions += observation.contributions.length;
    totals.aliasContributionsMerged += Math.max(0, observation.contributions.length - 1);
    totals.copiesSeen += copiesSeenOf(observation);
    totals.copiesCollapsed += copiesSeenOf(observation) - 1;
    const weak = observation.requisition.strength === 'weak' || observation.requisition.strength === 'none';
    if (weak) totals.weakKeyRequisitions += 1;

    const sent = sentApplicationsOf(observation);
    const primary = sent.length > 0 ? sent[sent.length - 1]! : null;
    const extra = Math.max(0, sent.length - 1);
    let bucket: 'none' | 'undated' | 'censored' | 'mature' = 'none';
    let outcome: RecordedOutcome = 'no_recorded_outcome';
    if (primary) {
      totals.sentRequisitions += 1;
      totals.reapplicationRows += extra;
      if (primary.sentAt === null) bucket = 'undated';
      else bucket = asOfMs - Date.parse(primary.sentAt) >= maturityDays * DAY ? 'mature' : 'censored';
      outcome = outcomeOfApplication(primary);
      if (bucket === 'mature') {
        totals.matureSent += 1;
        if (outcome === 'no_recorded_outcome') totals.unknownOutcomes += 1;
        else if (primary.statusHistory === 'current_value_only') anyOutcomeWithoutTime = true;
      } else if (bucket === 'censored') totals.censoredSent += 1;
      else totals.undatedSent += 1;
    }

    for (const label of cellLabelsOf(observation, options.dimension)) {
      const cell = cellFor(label);
      cell.requisitions += 1;
      if (cell.via) {
        if (viaOfVariant(observation, label) === 'fetched_upstream') cell.via.fetchedUpstream += 1;
        else cell.via.matchedLocallyOnly += 1;
      }
      if (weak) cell.weakKeyRequisitions += 1;
      if (observation.applications.length > 0) cell.withApplicationRow += 1;
      if (primary) {
        cell.sent += 1;
        const evidence = primary.evidence;
        if (evidence === 'receipt_observed' || evidence === 'user_reported' || evidence === 'user_stated') cell.sentByEvidence[evidence] += 1;
        cell.reapplicationRows += extra;
        if (bucket === 'mature') {
          cell.matureSent += 1;
          cell.outcomes[outcome] += 1;
        } else if (bucket === 'censored') cell.censoredSent += 1;
        else cell.undatedSent += 1;
      }
    }
  }

  for (const cell of cells.values()) {
    const unknown = cell.outcomes.no_recorded_outcome;
    cell.progressed = boundsOf(cell.outcomes.reply_recorded + cell.outcomes.offer_recorded, unknown, cell.matureSent);
    cell.rejectedRecorded = boundsOf(cell.outcomes.rejected_recorded, unknown, cell.matureSent);
    cell.smallSample = cell.requisitions < GATES.minRequisitionsPerCell || cell.matureSent < GATES.minRequisitionsPerCell;
    if (options.exposure && options.exposure[cell.label] !== undefined) {
      // The projected digest counts leads the SOURCE returned for the variant, so only requisitions it actually fetched are comparable.
      cell.selectedOfExposed = { exposed: options.exposure[cell.label]!, selected: cell.via ? cell.via.fetchedUpstream : cell.requisitions };
    }
  }

  const ordered = [...cells.values()].sort((a, b) => b.requisitions - a.requisitions || a.label.localeCompare(b.label));
  totals.sumOfCells = ordered.reduce((sum, cell) => sum + cell.requisitions, 0);
  totals.overlap = totals.sumOfCells - totals.distinctRequisitions;

  // ---- verdicts, per metric, so a missing denominator blocks one metric and not the others.
  const common: NoGoReason[] = [];
  if (totals.matureSent < GATES.minMatureSent) common.push('too_few_mature_sent');
  if (totals.matureSent > 0 && totals.unknownOutcomes / totals.matureSent > GATES.maxUnknownOutcomeShare) common.push('unknown_outcomes_dominate');
  if (totals.distinctRequisitions > 0 && totals.weakKeyRequisitions / totals.distinctRequisitions > GATES.maxWeakKeyShare) common.push('weak_identity_dominates');
  if (totals.copiesSeen > 0 && totals.copiesCollapsed / totals.copiesSeen > GATES.maxCopyShare) common.push('duplicate_copies_dominate');

  const unattributed = UNATTRIBUTED[options.dimension];
  const attributedCells = ordered.filter((cell) => cell.label !== unattributed);
  const perCell: NoGoReason[] = [...common];
  if (options.dimension === 'queryVariant' && attributedCells.length === 0) perCell.push('no_query_attribution');
  if (options.dimension !== 'queryVariant' && attributedCells.length < 2) perCell.push('nothing_to_compare');
  const leadToSelected: NoGoReason[] = [];
  if (!options.exposure) leadToSelected.push('no_exposure_denominator');
  const timeToReply: NoGoReason[] = [];
  const everyOutcomeHasEvents = observations.every((observation) =>
    sentApplicationsOf(observation).every((application) => outcomeOfApplication(application) === 'no_recorded_outcome' || (typeof application.statusHistory === 'object' && application.statusHistory.events.length > 0)),
  );
  if (anyOutcomeWithoutTime || !everyOutcomeHasEvents) timeToReply.push('no_status_timestamps');

  const verdict = (reasons: NoGoReason[]): Verdict => ({ verdict: reasons.length === 0 ? 'go_review' : 'no_go', reasons: [...new Set(reasons)] });

  return {
    contract: 'funnel/0.1.0-research',
    dimension: options.dimension,
    asOf: options.asOf,
    maturityDays,
    cells: ordered,
    totals,
    metrics: {
      outcomeDistribution: verdict(common),
      perCellOutcomeComparison: verdict(perCell),
      leadToSelected: verdict(leadToSelected),
      timeToReply: verdict(timeToReply),
    },
    notes: [
      'Cells count distinct requisitions and overlap when a requisition was seen through more than one source or variant; the distinct total is totals.distinctRequisitions.',
      'Copies are reported as two overlapping measures (saved rows; alias-merged source contributions) and the duplicate gate uses the larger per requisition, a lower bound; they are never added.',
      'A query-variant cell splits fetched_upstream (the source received the query) from matched_locally_only; the projected selected-of-exposed ratio uses fetched_upstream only.',
      'no_recorded_outcome is not a rejection, an ineligibility or a failed delivery. Bounds assume nothing about it: lower treats every unknown as "no", upper as "yes".',
      `Maturity (${maturityDays} days) is a view parameter with no empirical basis; younger sent applications are censored, not counted as no outcome.`,
      'Prepared, handed-off, failed and unconfirmed applications are not sent and are never in an outcome denominator.',
    ],
  };
}
