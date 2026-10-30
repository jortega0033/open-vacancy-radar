import { vacancyIdentityFor } from '@open-vacancy-radar/vacancy-engine';
import { deriveApplicationIdentity } from '../../electron/workspace/application-identity.js';
import type { KeyStrength, KeyTier, RequisitionKey } from './contract.js';

/**
 * Canonical requisition key v1 (research). It is NOT a new identity algorithm: it is the existing #278
 * engine identity (`vacancyIdentityFor`, which #688 stores as `application_briefs.identity_key`),
 * namespaced so a key can never be mistaken for a source row key, a URL or an attempt-level #275 pair.
 *
 *   rk1:req:<engine requisition key>   strong  -- an ATS tenant + the ATS's own requisition id
 *   rk1:url:<canonical posting URL>    medium  -- a specific posting URL, no requisition id recognised
 *   rk1:sem:<company :: title :: loc>  weak    -- company/title/location only; cannot prove two rows are
 *                                                 one job, nor that two rows with the same text are two
 *   (none)                             none    -- nothing identifies the job; the row stands alone
 *
 * What the key never does: merge two requisitions because they share an employer (the engine's
 * requisition and URL tiers never do), or treat a source row key (`vacancyKey`), a URL string or a
 * company name as the identity.
 */

const PREFIX: Record<Exclude<KeyTier, 'none'>, string> = { requisition: 'rk1:req:', canonical_url: 'rk1:url:', semantic: 'rk1:sem:' };
const STRENGTH: Record<KeyTier, KeyStrength> = { requisition: 'strong', canonical_url: 'medium', semantic: 'weak', none: 'none' };

export const NO_KEY: RequisitionKey = { key: '', tier: 'none', strength: 'none', origin: 'none' };

/**
 * The key a brief already holds. `identityKey`/`identityKind` are exactly the stored columns; the stored key
 * already starts with its own tier marker (`req:` | `url:` | `sem:`), so only the namespace is added.
 */
export function keyFromBrief(identityKey: string, identityKind: Exclude<KeyTier, 'none'>): RequisitionKey {
  const marker = PREFIX[identityKind].slice('rk1:'.length);
  const stored = identityKey.startsWith(marker) ? identityKey : `${marker}${identityKey}`;
  return { key: `rk1:${stored}`, tier: identityKind, strength: STRENGTH[identityKind], origin: 'brief_identity' };
}

/** The key computed now from stored fields with the REAL engine function; used when no brief exists for a row. */
export function keyFromFields(input: { url?: string | null; company: string; title: string; location?: string | null; provider?: string; key?: string }): RequisitionKey {
  const identity = vacancyIdentityFor({
    url: input.url ?? '',
    company: input.company,
    title: input.title,
    location: input.location ?? '',
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.key === undefined ? {} : { key: input.key }),
  });
  return { key: `${PREFIX[identity.kind]}${identity.key}`, tier: identity.kind, strength: STRENGTH[identity.kind], origin: 'derived_at_read' };
}

/** The company+title+location tier for a row, computed by the real function, whatever tier its real key has. */
export function semanticKeyOf(input: { company: string; title: string; location?: string | null }): string {
  return vacancyIdentityFor({ url: '', company: input.company, title: input.title, location: input.location ?? '' }).key;
}

/**
 * The two identity surfaces the app has today, side by side for one apply URL: the engine's (#278, used by
 * briefs and discovery merges) and the desktop attempt's (#275, stored on `application_attempts`). They are
 * independent implementations with different provider coverage, so the same posting can be a `requisition`
 * on one and a `canonical_url` on the other. The research key follows the brief, and this reports the gap.
 */
export function compareIdentitySurfaces(input: { url: string; company: string; title: string; location?: string }): {
  engine: RequisitionKey;
  attemptPair: { employerKey: string; requisitionId: string | null };
  attemptHasRequisition: boolean;
  disagree: boolean;
} {
  const engine = keyFromFields({ url: input.url, company: input.company, title: input.title, location: input.location ?? '' });
  const attempt = deriveApplicationIdentity({ company: input.company, canonicalUrl: input.url });
  const attemptHasRequisition = attempt.requisitionId !== null;
  return {
    engine,
    attemptPair: { employerKey: attempt.employerKey, requisitionId: attempt.requisitionId },
    attemptHasRequisition,
    disagree: attemptHasRequisition !== (engine.tier === 'requisition'),
  };
}

export interface KeyedItem {
  requisition: RequisitionKey;
}

export interface CollapseResult<T extends KeyedItem> {
  /** One group per distinct key; every un-keyed item is its own group (never merged with another). */
  groups: T[][];
  /** Items beyond the first in each group: syndicated or repeated copies counted once. */
  copiesCollapsed: number;
  unkeyed: number;
}

/** Groups by key. An item without a key is NEVER merged with another un-keyed item. */
export function collapseByRequisition<T extends KeyedItem>(items: readonly T[]): CollapseResult<T> {
  const byKey = new Map<string, T[]>();
  const groups: T[][] = [];
  let unkeyed = 0;
  for (const item of items) {
    if (item.requisition.tier === 'none' || item.requisition.key === '') {
      unkeyed += 1;
      groups.push([item]);
      continue;
    }
    const existing = byKey.get(item.requisition.key);
    if (existing) existing.push(item);
    else {
      const group = [item];
      byKey.set(item.requisition.key, group);
      groups.push(group);
    }
  }
  return { groups, copiesCollapsed: items.length - groups.length, unkeyed };
}

export interface IdentityRisk {
  /** Distinct strong/medium keys that share a company+title+location text: maybe one job kept as two. Reported, never merged. */
  possibleUnderMerge: { semanticKey: string; keys: string[] }[];
  /** Groups whose key is the weak semantic tier and that hold >1 row: counted once, but two same-text roles would be hidden here. */
  weakGroupsWithCopies: number;
  weakKeyRequisitions: number;
  unkeyedRequisitions: number;
}

export function identityRisk(items: readonly { requisition: RequisitionKey; company: string; title: string; location: string; copies: number }[]): IdentityRisk {
  const bySemantic = new Map<string, Set<string>>();
  let weak = 0;
  let unkeyed = 0;
  let weakWithCopies = 0;
  for (const item of items) {
    if (item.requisition.tier === 'none') {
      unkeyed += 1;
      continue;
    }
    if (item.requisition.tier === 'semantic') {
      weak += 1;
      if (item.copies > 1) weakWithCopies += 1;
    }
    const sem = semanticKeyOf(item);
    const keys = bySemantic.get(sem) ?? new Set<string>();
    keys.add(item.requisition.key);
    bySemantic.set(sem, keys);
  }
  const possibleUnderMerge = [...bySemantic.entries()]
    .filter(([, keys]) => keys.size > 1)
    .map(([semanticKey, keys]) => ({ semanticKey, keys: [...keys].sort() }))
    .sort((a, b) => a.semanticKey.localeCompare(b.semanticKey));
  return { possibleUnderMerge, weakGroupsWithCopies: weakWithCopies, weakKeyRequisitions: weak, unkeyedRequisitions: unkeyed };
}
