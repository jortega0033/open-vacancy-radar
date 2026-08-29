import {
  compareStructuredOfficialUrls,
  createStructuredDomainEvidence,
  normalizeStructuredKvk,
  type StructuredDomainEvidence,
  type StructuredDomainSource,
} from './structured-domain-evidence.js';
import { normalizeLegalName } from '../ind/normalize.js';

export type SponsorForStructuredDomainMerge = {
  id: string;
  legalName: string;
  kvkNumber: string | null;
};

export type StructuredDomainProvenance = {
  source: StructuredDomainSource;
  sourceVersion: string;
  sourceRecordId: string;
  sourceName: string;
  evidenceUrl: string;
  observedOfficialUrl: string;
};

export type MergedStructuredDomainCandidate = {
  sponsorId: string;
  legalName: string;
  kvkNumber: string;
  officialUrl: string;
  hostname: string;
  sources: StructuredDomainSource[];
  provenance: StructuredDomainProvenance[];
};

export type StructuredDomainMergeOutcome =
  | {
      sponsorId: string;
      status: 'candidate';
      reasonCode: 'exact_kvk_single_structured_host';
      candidate: MergedStructuredDomainCandidate;
    }
  | {
      sponsorId: string;
      status: 'manual_review';
      reasonCode:
        | 'conflicting_structured_hosts'
        | 'structured_legal_name_mismatch'
        | 'duplicate_wikidata_kvk_items';
      hostnames: string[];
      provenance: StructuredDomainProvenance[];
    }
  | {
      sponsorId: string;
      status: 'not_found';
      reasonCode: 'no_structured_domain_match';
    }
  | {
      sponsorId: string;
      status: 'missing_kvk';
      reasonCode: 'missing_or_invalid_kvk';
    };

export type StructuredDomainMergeResult = {
  outcomes: StructuredDomainMergeOutcome[];
  candidates: MergedStructuredDomainCandidate[];
  ignoredEvidenceCount: number;
};

function provenanceFor(value: StructuredDomainEvidence): StructuredDomainProvenance {
  return {
    source: value.source,
    sourceVersion: value.sourceVersion,
    sourceRecordId: value.sourceRecordId,
    sourceName: value.sourceName,
    evidenceUrl: value.evidenceUrl,
    observedOfficialUrl: value.officialUrl,
  };
}

function compareEvidence(left: StructuredDomainEvidence, right: StructuredDomainEvidence): number {
  return (
    left.source.localeCompare(right.source) ||
    left.sourceRecordId.localeCompare(right.sourceRecordId) ||
    left.officialUrl.localeCompare(right.officialUrl)
  );
}

function uniqueEvidence(values: readonly StructuredDomainEvidence[]): StructuredDomainEvidence[] {
  const unique = new Map<string, StructuredDomainEvidence>();
  for (const value of values) {
    const identity = [
      value.source,
      value.sourceVersion,
      value.sourceRecordId,
      value.kvkNumber,
      value.officialUrl,
      value.evidenceUrl,
    ].join('\u0000');
    if (!unique.has(identity)) unique.set(identity, value);
  }
  return [...unique.values()].sort(compareEvidence);
}

function preferredInspectionUrl(value: string): string {
  const url = new URL(value);
  // Public registries frequently retain an old HTTP homepage that immediately
  // upgrades to HTTPS. Start on the encrypted form of the same exact hostname;
  // the original submitted URL remains intact in candidate provenance.
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url.toString();
}

export function mergeStructuredDomainEvidence(
  sponsors: readonly SponsorForStructuredDomainMerge[],
  evidence: readonly StructuredDomainEvidence[],
): StructuredDomainMergeResult {
  const byKvk = new Map<string, StructuredDomainEvidence[]>();
  let ignoredEvidenceCount = 0;
  const normalizedEvidence: StructuredDomainEvidence[] = [];
  for (const item of evidence) {
    const normalized = createStructuredDomainEvidence(item);
    if (normalized?.kvkNumber !== item.kvkNumber) {
      ignoredEvidenceCount += 1;
      continue;
    }
    if (
      normalized.officialUrl !== item.officialUrl ||
      normalized.hostnameKey !== item.hostnameKey
    ) {
      ignoredEvidenceCount += 1;
      continue;
    }
    normalizedEvidence.push(normalized);
  }
  for (const item of uniqueEvidence(normalizedEvidence)) {
    const kvkNumber = item.kvkNumber;
    const group = byKvk.get(kvkNumber) ?? [];
    group.push(item);
    byKvk.set(kvkNumber, group);
  }

  const outcomes: StructuredDomainMergeOutcome[] = [];
  const candidates: MergedStructuredDomainCandidate[] = [];
  for (const sponsor of sponsors) {
    const kvkNumber = sponsor.kvkNumber === null ? null : normalizeStructuredKvk(sponsor.kvkNumber);
    if (kvkNumber === null) {
      outcomes.push({
        sponsorId: sponsor.id,
        status: 'missing_kvk',
        reasonCode: 'missing_or_invalid_kvk',
      });
      continue;
    }
    const matches = byKvk.get(kvkNumber);
    if (matches === undefined || matches.length === 0) {
      outcomes.push({
        sponsorId: sponsor.id,
        status: 'not_found',
        reasonCode: 'no_structured_domain_match',
      });
      continue;
    }

    const hostnames = [...new Set(matches.map((item) => item.hostnameKey))].sort();
    const provenance = matches.map(provenanceFor);
    if (hostnames.length !== 1) {
      outcomes.push({
        sponsorId: sponsor.id,
        status: 'manual_review',
        reasonCode: 'conflicting_structured_hosts',
        hostnames,
        provenance,
      });
      continue;
    }

    const normalizedSponsorName = normalizeLegalName(sponsor.legalName);
    const nameMismatches = matches.filter(
      (item) =>
        item.source !== 'wikidata' && normalizeLegalName(item.sourceName) !== normalizedSponsorName,
    );
    if (nameMismatches.length > 0) {
      outcomes.push({
        sponsorId: sponsor.id,
        status: 'manual_review',
        reasonCode: 'structured_legal_name_mismatch',
        hostnames,
        provenance,
      });
      continue;
    }
    const wikidataRecordIds = new Set(
      matches.filter((item) => item.source === 'wikidata').map((item) => item.sourceRecordId),
    );
    if (wikidataRecordIds.size > 1) {
      outcomes.push({
        sponsorId: sponsor.id,
        status: 'manual_review',
        reasonCode: 'duplicate_wikidata_kvk_items',
        hostnames,
        provenance,
      });
      continue;
    }

    const observedOfficialUrl = [...new Set(matches.map((item) => item.officialUrl))].sort(
      compareStructuredOfficialUrls,
    )[0];
    const hostname = hostnames[0];
    if (observedOfficialUrl === undefined || hostname === undefined) {
      outcomes.push({
        sponsorId: sponsor.id,
        status: 'not_found',
        reasonCode: 'no_structured_domain_match',
      });
      continue;
    }
    const candidate: MergedStructuredDomainCandidate = {
      sponsorId: sponsor.id,
      legalName: sponsor.legalName,
      kvkNumber,
      officialUrl: preferredInspectionUrl(observedOfficialUrl),
      hostname,
      sources: [...new Set(matches.map((item) => item.source))].sort(),
      provenance,
    };
    candidates.push(candidate);
    outcomes.push({
      sponsorId: sponsor.id,
      status: 'candidate',
      reasonCode: 'exact_kvk_single_structured_host',
      candidate,
    });
  }

  return { outcomes, candidates, ignoredEvidenceCount };
}
