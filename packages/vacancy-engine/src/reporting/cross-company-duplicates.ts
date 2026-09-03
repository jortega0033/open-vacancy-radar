import { createHash } from 'node:crypto';

import { normalizeVacancyText } from '../vacancies/hash.js';
import { descriptionTokens, substantiveDescriptionTokenSequence } from './ats-boilerplate.js';

/**
 * Cross-company duplicate *grouping* (issue #139).
 *
 * This is the narrow extension of the dedup that already ships. `repository.ts` already collapses
 * report rows keyed by `${companyId}:${createVacancySemanticFingerprint(vacancy)}`, which handles
 * the same listing arriving from two different boards for one company record. What that key cannot
 * see is the same real listing filed under two *different* company records: a staffing-agency
 * repost, or one employer scanned under two name variants.
 *
 * The house rule from the sponsor-match precedent (issue #117, see
 * `companies/worldwide-sponsor-match.ts`) applies here in full: a heuristic-level signal is never
 * presented with more confidence than it earned, and never acts on the user's behalf. So this
 * module *annotates*, it never filters. It returns a map from vacancy id to group membership; every
 * input row survives untouched, both members of a group stay independently visible, and the user
 * decides what to do with the suggestion. Collapsing two genuinely different roles would silently
 * lose a real vacancy, which is strictly worse than showing an occasional un-collapsed duplicate.
 *
 * Purely local: string normalization and set arithmetic over text the pipeline already has, plus
 * the fixed phrase table in `ats-boilerplate.ts`. No model, no network, no AI of any kind is
 * involved in producing a group.
 *
 * ## v3: what this feature is now, and what it gave up
 *
 * v1 and v2 both tried to detect a *related listing*: two company names that looked like they might
 * be one employer, plus posting text that was similar enough. Two rounds of adversarial review broke
 * both halves of that, and the second break is the one that settled the design.
 *
 * - The name half was never sound. `companyNameRelation`'s containment test compared token *sets*,
 *   so any one-word brand name ("Atlas", "Meta", "Delta") came out "strongly related" to every
 *   longer name containing that word ("Atlas Van Lines", "Meta Financial Group"). That is a common
 *   real shape, not a contrived one.
 * - The text half could not be rescued by tuning. Even at the hardened 0.90 threshold, two unrelated
 *   postings sharing an ordinary modern stack (Python, AWS, Docker, Kubernetes, PostgreSQL, Kafka)
 *   and differing in a single domain noun measured **0.944** bag-of-words Jaccard on substantive
 *   tokens -- *above* this module's own genuine-repost fixture at 0.917. No threshold separates a
 *   population whose adversarial ceiling sits above its true-positive floor.
 *
 * The conclusion of the second review is the premise of this file: **unordered token-set overlap,
 * however discounted, cannot tell "same posting, slightly reworded" from "different posting, same
 * buzzwords"** for ordinary technical job adverts, because those adverts genuinely share most of
 * their vocabulary. So the feature was narrowed to the one thing local text *can* establish, and the
 * measure was replaced with one that can establish it:
 *
 * - **Company names are no longer a detection signal at all.** `companyNameRelation`,
 *   `GENERIC_COMPANY_TOKENS`, the strong/weak split and the two-tier structure are gone. Names are
 *   still shown to the reader ("also posted under N other company records"), but nothing is grouped
 *   because of them.
 * - **Detection is near-verbatim repost detection only.** The measure is word-shingle overlap, which
 *   is sensitive to word order and sentence structure rather than to vocabulary alone. See
 *   `descriptionShingleSimilarity`.
 *
 * That is a deliberate loss of recall. A repost that a staffing agency genuinely rewrote in its own
 * words is now missed, and is meant to be: the second review demonstrated that the evidence needed
 * to catch it does not exist in the text.
 */
export const CROSS_COMPANY_DUPLICATE_VERSION = 'cross-company-duplicate-v3';

/**
 * Words per shingle. Five is the whole difference between v2 and v3.
 *
 * A shingle is a window of this many consecutive substantive words. Comparing sets of shingles
 * rather than sets of words is what makes the measure care about *how the posting is written* and
 * not merely *what it is about*. Two people writing independently about the same stack reach for the
 * same nouns and put them in different sentences; a copy puts them in the same sentence.
 *
 * Five is long enough that agreeing on one is not a coincidence -- five specific technical words in
 * one specific order -- and short enough to survive the small edits a real repost carries. Measured
 * across the fixture set the score is almost flat in this parameter (the genuine repost runs 0.887
 * at k=3 to 0.875 at k=8; the round-2 adversarial pairs are 0.000 from k=5 upward), so the choice is
 * not load-bearing and no fixture is sitting on a cliff edge. Five is the smallest k at which both
 * round-2 pairs reach exactly zero.
 *
 * It also fits the floor below: a posting clearing
 * `CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS` always has enough words to form shingles.
 */
export const CROSS_COMPANY_SHINGLE_LENGTH = 5;

/**
 * Minimum shingle-set Jaccard for two postings to be called the same listing.
 *
 * ## The measured case, third iteration
 *
 * Every number below is asserted in `test/reporting/cross-company-duplicates.test.ts`, so the table
 * cannot drift away from the code. "v2" is the shipped-and-broken bag-of-words Jaccard over
 * substantive tokens; "v3" is this file's shingle Jaccard at `CROSS_COMPANY_SHINGLE_LENGTH`.
 *
 * | fixture pair                                                  |    v2 |    v3 |
 * | ------------------------------------------------------------- | ----- | ----- |
 * | genuine repost, lightly rewritten            (must group)     | 0.917 | 0.882 |
 * | byte-identical repost                        (must group)     | 1.000 | 1.000 |
 * | Apex Systems / Apex Group, shared ATS template  (round 1)     | 0.200 | 0.071 |
 * | Atlas / Atlas Van Lines, shared tech stack     (round 2a)     | 0.944 | 0.000 |
 * | NovaTech Systems / NovaTech Group, shared stack (round 2b)    | 0.939 | 0.000 |
 * | shared role explainer, different jobs           (round 3)     | 0.479 | 0.449 |
 * | two different Acme roles                     (true negative)  | 0.052 | 0.000 |
 *
 * The two rows that decided the design are 2a and 2b. Those pairs were built to have the *same*
 * substantive vocabulary bar one noun, which is why they beat every bag-of-words threshold -- and
 * they score exactly zero here, because two texts assembled from the same words in different
 * sentences share no five-word run at all. Nothing was tuned to make that happen; it is what the
 * measure is.
 *
 * Round 3 is this iteration's own attempt to break the new measure rather than the old one: two
 * genuinely different data-engineering jobs, at two employers, both carrying the same verbatim
 * fifty-word "what a data engineer does" explainer. It is the strongest of the four adversarial
 * pairs and still lands at 0.449.
 *
 * So the true-positive floor is 0.882 and the adversarial ceiling is 0.449: a band of **0.433**,
 * against the 0.004 that v2 was reduced to. 0.75 sits inside it, above the ceiling by 0.30 and below
 * the floor by 0.13. It is placed above the midpoint for the reason the cost is asymmetric -- a miss
 * costs one visible duplicate row, a false group costs a misleading claim about two employers -- but
 * not so high that it is resting on the true-positive fixture.
 *
 * ## The limit this measure still has, stated plainly
 *
 * A fourth adversarial construction *does* beat it, and is recorded in the tests rather than hidden:
 * two unrelated employers who both paste the same long third-party job-description template verbatim
 * and append only a short employer-specific tail measure **0.880**, and a pair whose tails are one
 * sentence each measure **0.982**. Those group.
 *
 * This is the boundary of the feature as narrowed, not a defect inside it. When two adverts share a
 * hundred consecutive substantive words in the same order and differ in four, they *are*
 * near-verbatim copies of one text; no local, order-sensitive measure can say whether that one text
 * describes one opening or two, because the text does not contain the answer. The previous design's
 * verbatim-fingerprint tier had exactly the same blind spot and the same mitigation: the annotation
 * is hedged, both rows stay visible, and nothing is merged. The natural next step, if this shows up
 * in real reports, is corpus-relative rather than pairwise -- a block of text appearing verbatim
 * across postings from many unrelated companies is a template, and that is a judgement only the
 * whole report can make, not a pair.
 */
export const CROSS_COMPANY_SHINGLE_SIMILARITY_THRESHOLD = 0.75;

/**
 * A row whose description carries fewer distinct tokens than this is never grouped.
 *
 * The guard against a source that emits a stub row with an empty or one-line placeholder
 * description. Two such stubs with the same generic title ("Software Engineer", Amsterdam) at two
 * unrelated employers would look identical while sharing no actual evidence. Below this floor there
 * is nothing to compare, and "no claim" is the honest output.
 */
export const CROSS_COMPANY_MINIMUM_DESCRIPTION_TOKENS = 40;

/**
 * The same idea one level up: a row with fewer distinct *substantive* tokens than this is never
 * grouped either.
 *
 * The raw floor above catches a source that sent almost no text. This one catches a source that sent
 * plenty of text that says nothing -- a description that is entirely applicant-tracking-system
 * template, with the job itself left out. Two employers who both pasted the same untouched vendor
 * template for two different real openings produce byte-identical descriptions, which score a
 * perfect 1.0 on any similarity measure ever written. This floor is what refuses them, and it is
 * why the measure is never asked to do a job a ratio cannot do.
 *
 * Measured: the bare recruiting template used by this module's adversarial fixtures is 133 raw
 * tokens -- three times over the raw floor -- and 4 substantive ones, all of them echoes of the job
 * title and the city, which the exact-title and exact-location gates have already established. The
 * real postings in the same tests run from 17 to 101 substantive tokens.
 *
 * 12 is low on purpose and sits in that gap nearer the bottom. It is a floor on there being *some*
 * job-specific content to reason about, not a demand for a long advert: a terse but real posting
 * ("Go, PostgreSQL, freight routing, Schiphol Rijk depot, ferry timetables") clears it easily, while
 * the boilerplate-only stub does not come close. It counts distinct words, not occurrences, so a
 * stub cannot reach it by repeating itself.
 */
export const CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS = 12;

/** The fields this heuristic reads. Deliberately a structural subset, so a report row, a database
 * row or a test fixture can all be passed without adapting.
 *
 * `company` is carried for display only -- it is what the annotation shows the reader. Since v3 it
 * has no influence whatsoever on whether a group is formed. */
export type CrossCompanyDuplicateCandidate = {
  id: string;
  companyId: string;
  /** Display/brand name of the company record, as the report shows it. Never a detection signal. */
  company: string;
  title: string;
  description: string;
  location: string | null;
};

export type CrossCompanyDuplicateGroup = {
  /** Stable id derived from the member ids, so the same group is recognisable across a re-render.
   * Deliberately not "the first row's id": no member of a group is canonical, because nothing here
   * is merged. */
  groupId: string;
  /** The other rows in this group. Never empty, and never contains the annotated row itself. */
  otherVacancyIds: string[];
  /** Names of the other company records this listing also appears under, de-duplicated and sorted. */
  otherCompanies: string[];
};

/** The set of distinct `CROSS_COMPANY_SHINGLE_LENGTH`-word windows over a token sequence.
 *
 * A sequence shorter than one window yields nothing, which the callers below read as "no evidence".
 * The `CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS` floor means that cannot happen for a
 * row that reaches the comparison, but the function is total regardless. */
function shingleSet(tokens: readonly string[]): Set<string> {
  const shingles = new Set<string>();
  for (let index = 0; index + CROSS_COMPANY_SHINGLE_LENGTH <= tokens.length; index += 1) {
    shingles.add(tokens.slice(index, index + CROSS_COMPANY_SHINGLE_LENGTH).join(' '));
  }
  return shingles;
}

/**
 * Jaccard overlap of the two descriptions' *substantive word-shingle* sets, in `[0, 1]`.
 *
 * Substantive: the applicant-tracking-system template both postings were typed into is subtracted
 * from each side first (see `ats-boilerplate.ts`). That step survives from v2 and still earns its
 * place -- without it the round-1 Apex pair, which shares an entire unedited ATS skeleton verbatim,
 * would share that skeleton's shingles too and score near the top of the scale.
 *
 * Shingle, not token: this is the v3 correction. What is compared is which five-word runs the two
 * postings have in common, so agreement has to be agreement about phrasing and order, not merely
 * about which words appear somewhere. See `CROSS_COMPANY_SHINGLE_SIMILARITY_THRESHOLD` for the
 * measurements that forced the change.
 *
 * Jaccard, not containment: containment (shared / smaller side) was measured on the same fixtures
 * and rejected. It scores the round-3 adversarial pair at 0.623 against Jaccard's 0.449, because
 * dividing by the smaller side forgives a posting that shares a block and then goes on to describe a
 * completely different job. Dividing by the union does not, and refusing to forgive divergent
 * content is exactly the property this measure is bought for.
 *
 * Two empty descriptions score 0, not 1: no shared text is no evidence, never perfect evidence.
 * Note what this function does *not* do: it compares, it does not weigh. Two identical
 * pure-template descriptions score a perfect 1.0 here, just as two identical real postings do.
 * Telling those apart is `CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS`' job, not a ratio's.
 */
export function descriptionShingleSimilarity(left: string, right: string): number {
  return shingleJaccard(
    shingleSet(substantiveDescriptionTokenSequence(left)),
    shingleSet(substantiveDescriptionTokenSequence(right)),
  );
}

/** The measure itself, over shingle sets the caller has already built. Two empty sides score 0, not
 * 1: no shared text is no evidence, never perfect evidence. */
function shingleJaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const shingle of left) {
    if (right.has(shingle)) shared += 1;
  }
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

type PreparedCandidate = CrossCompanyDuplicateCandidate & {
  normalizedTitle: string;
  normalizedLocation: string | null;
  descriptionTokenCount: number;
  substantiveTokenCount: number;
  shingles: Set<string>;
};

function prepare(candidate: CrossCompanyDuplicateCandidate): PreparedCandidate {
  const substantiveSequence = substantiveDescriptionTokenSequence(candidate.description);
  return {
    ...candidate,
    normalizedTitle: normalizeVacancyText(candidate.title),
    normalizedLocation:
      candidate.location === null ? null : normalizeVacancyText(candidate.location),
    descriptionTokenCount: descriptionTokens(candidate.description).size,
    substantiveTokenCount: new Set(substantiveSequence).size,
    shingles: shingleSet(substantiveSequence),
  };
}

/**
 * Whether these two rows are the same posting text filed under two company records.
 *
 * Every pairing must first clear four hard gates: different company records (same-company duplicates
 * are already collapsed upstream and are none of this module's business), an exactly equal
 * normalized title, an exactly equal normalized location, and both text floors -- enough raw text to
 * be a real advert (`CROSS_COMPANY_MINIMUM_DESCRIPTION_TOKENS`) and enough left after the recruiting
 * template is subtracted to say which job it is
 * (`CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS`).
 *
 * Equal-not-similar on title and location is intentional. They are short, high-signal fields, and a
 * fuzzy match on them buys very little recall while opening the door to grouping "Backend Engineer"
 * with "Backend Engineer II", which are routinely two real, separately applicable vacancies.
 *
 * Past the gates there is exactly one kind of evidence, and it is the posting text: near-verbatim
 * agreement, measured by `descriptionShingleSimilarity`. v2's second tier -- an exact semantic
 * fingerprint match -- is gone as a *tier* but not as a case: two byte-identical descriptions score
 * 1.0 on this measure and group, so the staffing-agency verbatim repost the tier existed for is
 * still caught by the single rule.
 *
 * Company names are read nowhere in this function. That is the v3 decision, and keeping it visible
 * here is the point: there is no name gate to widen, no name relation to grade, and no way for a
 * shared brand word to contribute to a grouping.
 */
function likelySameListing(left: PreparedCandidate, right: PreparedCandidate): boolean {
  if (left.companyId === right.companyId) return false;
  if (
    left.descriptionTokenCount < CROSS_COMPANY_MINIMUM_DESCRIPTION_TOKENS ||
    right.descriptionTokenCount < CROSS_COMPANY_MINIMUM_DESCRIPTION_TOKENS
  ) {
    return false;
  }
  if (
    left.substantiveTokenCount < CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS ||
    right.substantiveTokenCount < CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS
  ) {
    return false;
  }
  if (left.normalizedTitle !== right.normalizedTitle) return false;
  if (left.normalizedLocation !== right.normalizedLocation) return false;

  return shingleJaccard(left.shingles, right.shingles) >= CROSS_COMPANY_SHINGLE_SIMILARITY_THRESHOLD;
}

function createGroupId(memberIds: string[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify({ version: CROSS_COMPANY_DUPLICATE_VERSION, members: [...memberIds].sort() }),
    )
    .digest('hex')
    .slice(0, 16);
}

/**
 * Groups rows that look like the same listing under different company records.
 *
 * Returns a lookup keyed by vacancy id, containing an entry **only** for rows that belong to a
 * group. A row absent from the map is a row with no cross-company duplicate suggestion, which is
 * the overwhelming majority. Nothing is removed, reordered or rewritten: the caller keeps its own
 * list of rows exactly as it built it and merely reads annotations off this map. That is the whole
 * contract, and it is what makes the "group, never merge" requirement structurally true rather than
 * a matter of the caller behaving.
 *
 * Grouping is by connected component, so a listing reposted by two separate agencies lands in one
 * group of three rather than two overlapping pairs. Because every edge requires an exactly equal
 * normalized title and location, and equality is transitive, every member of a component provably
 * shares those; only the description evidence differs between pairs, so a component cannot drift
 * onto a different role the way a purely fuzzy chain could.
 */
export function findCrossCompanyDuplicateGroups(
  candidates: readonly CrossCompanyDuplicateCandidate[],
): Map<string, CrossCompanyDuplicateGroup> {
  const groups = new Map<string, CrossCompanyDuplicateGroup>();
  if (candidates.length < 2) return groups;

  const prepared = candidates.map(prepare);

  // Union-find over the candidate indices.
  const parent = prepared.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };

  // Only rows sharing a normalized title can possibly pair, so bucket on that first: the whole
  // report is comfortably in the thousands of rows, and an unbucketed O(n^2) sweep over it would be
  // pure waste.
  const byTitle = new Map<string, number[]>();
  for (const [index, candidate] of prepared.entries()) {
    const bucket = byTitle.get(candidate.normalizedTitle);
    if (bucket) bucket.push(index);
    else byTitle.set(candidate.normalizedTitle, [index]);
  }

  for (const bucket of byTitle.values()) {
    for (let leftIndex = 0; leftIndex < bucket.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < bucket.length; rightIndex += 1) {
        const left = prepared[bucket[leftIndex]!]!;
        const right = prepared[bucket[rightIndex]!]!;
        if (!likelySameListing(left, right)) continue;
        const leftRoot = find(bucket[leftIndex]!);
        const rightRoot = find(bucket[rightIndex]!);
        if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
      }
    }
  }

  const componentsByRoot = new Map<number, number[]>();
  for (let index = 0; index < prepared.length; index += 1) {
    const root = find(index);
    const members = componentsByRoot.get(root);
    if (members) members.push(index);
    else componentsByRoot.set(root, [index]);
  }

  for (const members of componentsByRoot.values()) {
    if (members.length < 2) continue;
    const distinctCompanyIds = new Set(members.map((index) => prepared[index]!.companyId));
    // A component that never crossed a company boundary is not this feature's finding; the existing
    // same-company collapse already owns that case.
    if (distinctCompanyIds.size < 2) continue;

    const memberIds = members.map((index) => prepared[index]!.id);
    const groupId = createGroupId(memberIds);
    for (const index of members) {
      const self = prepared[index]!;
      const others = members.filter((other) => other !== index).map((other) => prepared[other]!);
      groups.set(self.id, {
        groupId,
        otherVacancyIds: others.map((other) => other.id),
        otherCompanies: [...new Set(others.map((other) => other.company))].sort((left, right) =>
          left.localeCompare(right),
        ),
      });
    }
  }

  return groups;
}
