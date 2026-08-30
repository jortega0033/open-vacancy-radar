import { createHash } from 'node:crypto';

import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';

import { detectAtsSource } from '../ats/detection.js';
import { withTransaction, type Database } from '../db/client.js';
import { mergeJsonObject } from '../db/json.js';
import {
  careerSources,
  companies,
  companyAliases,
  companySponsors,
  indSponsors,
  vacancies,
} from '../db/schema.js';
import { normalizeLegalName } from '../ind/normalize.js';
import type { CompanyMappingFile } from './mappings.js';

export type CompanyMappingSyncResult = {
  companiesMapped: number;
  sponsorLinks: number;
  careerSources: number;
  unmatchedSponsors: { legalName: string; kvkNumber: string }[];
  skippedCompanies: string[];
};

export function canonicalKeyForCatalogSource(source: {
  provider: string;
  baseUrl: string;
  boardIdentifier: string | null;
}): string | null {
  const identifier = source.boardIdentifier?.trim();
  if (!identifier?.length) return null;
  if (source.provider === 'successfactors') {
    try {
      const url = new URL(source.baseUrl);
      const hostname = url.hostname.toLowerCase();
      if (
        url.protocol !== 'https:' ||
        url.username !== '' ||
        url.password !== '' ||
        url.port !== '' ||
        url.pathname !== '/' ||
        url.search !== '' ||
        url.hash !== '' ||
        identifier !== identifier.toLowerCase() ||
        identifier !== hostname
      ) {
        return null;
      }
      return `successfactors:${hostname}`;
    } catch {
      return null;
    }
  }
  const detectedFromIdentifier = source.provider === 'recruitee'
    ? detectAtsSource(identifier)
    : null;
  const detected = detectAtsSource(source.baseUrl) ?? detectedFromIdentifier;
  if (detected?.provider !== source.provider) return null;
  const normalizedConfigured = (() => {
    if (source.provider === 'recruitee' && detectedFromIdentifier?.provider === 'recruitee') {
      return detectedFromIdentifier.boardIdentifier.trim().toLowerCase();
    }
    if (source.provider !== 'teamtailor') return identifier.toLowerCase();
    try {
      const url = new URL(identifier);
      url.hash = '';
      url.search = '';
      return url.toString().toLowerCase();
    } catch {
      return '';
    }
  })();
  const normalizedDetected = (() => {
    if (source.provider !== 'teamtailor') return detected.boardIdentifier.trim().toLowerCase();
    try {
      const url = new URL(detected.boardIdentifier);
      url.hash = '';
      url.search = '';
      return url.toString().toLowerCase();
    } catch {
      return '';
    }
  })();
  if (normalizedConfigured.length === 0 || normalizedConfigured !== normalizedDetected) return null;
  switch (source.provider) {
    case 'ashby':
      return `ashby:${normalizedConfigured}`;
    case 'greenhouse':
      return `greenhouse:${normalizedConfigured}`;
    case 'lever': {
      let region = 'global';
      try {
        if (new URL(source.baseUrl).hostname.toLowerCase().includes('.eu.')) region = 'eu';
      } catch {
        return null;
      }
      return `lever:${region}:${normalizedConfigured}`;
    }
    case 'personio': {
      try {
        const hostname = new URL(source.baseUrl).hostname.toLowerCase();
        return `personio:${hostname}:${normalizedConfigured}`;
      } catch {
        return null;
      }
    }
    case 'recruitee':
      return `recruitee:${normalizedConfigured}`;
    case 'teamtailor': {
      try {
        return `teamtailor:${normalizedConfigured}`;
      } catch {
        return null;
      }
    }
    case 'smartrecruiters':
      return `smartrecruiters:${normalizedConfigured}`;
    case 'workable':
      return `workable:${normalizedConfigured}`;
    case 'workday': {
      try {
        const hostname = new URL(source.baseUrl).hostname.toLowerCase();
        return `workday:${hostname}:${normalizedConfigured}`;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

export async function syncVerifiedCompanyMappings(
  database: Database,
  mappingFile: CompanyMappingFile,
): Promise<CompanyMappingSyncResult> {
  const result: CompanyMappingSyncResult = {
    companiesMapped: 0,
    sponsorLinks: 0,
    careerSources: 0,
    unmatchedSponsors: [],
    skippedCompanies: [],
  };
  const verifiedAt = new Date(mappingFile.verifiedAt);
  const catalogHash = createHash('sha256')
    .update(JSON.stringify(mappingFile))
    .digest('hex');
  const catalogDomains = new Set(mappingFile.mappings.map((mapping) => mapping.domain));

  await withTransaction(database, async (transaction) => {
    const [latestVerification] = await transaction
      .select({
        lastVerifiedAt: companies.lastVerifiedAt,
        catalogHash: companies.catalogHash,
      })
      .from(companies)
      .where(and(isNotNull(companies.lastVerifiedAt), isNotNull(companies.catalogHash)))
      .orderBy(desc(companies.lastVerifiedAt))
      .limit(1);
    if (
      latestVerification?.lastVerifiedAt !== null &&
      latestVerification?.lastVerifiedAt !== undefined &&
      verifiedAt < latestVerification.lastVerifiedAt
    ) {
      throw new Error(
        `Refusing company mapping regression: catalog verified at ${verifiedAt.toISOString()} is older than persisted ${latestVerification.lastVerifiedAt.toISOString()}`,
      );
    }
    if (
      latestVerification?.lastVerifiedAt?.getTime() === verifiedAt.getTime() &&
      latestVerification.catalogHash !== null &&
      latestVerification.catalogHash !== catalogHash
    ) {
      throw new Error(
        `Refusing company mapping conflict: catalog content changed without advancing verifiedAt ${verifiedAt.toISOString()}`,
      );
    }
    for (const mapping of mappingFile.mappings) {
      const matchedSponsors: { id: string; configured: (typeof mapping.sponsors)[number] }[] = [];
      const unmatchedSponsors: { legalName: string; kvkNumber: string }[] = [];
      for (const configured of mapping.sponsors) {
        const candidates = await transaction
          .select({
            id: indSponsors.id,
            legalName: indSponsors.legalName,
            normalizedName: indSponsors.normalizedName,
          })
          .from(indSponsors)
          .where(and(eq(indSponsors.kvkNumber, configured.kvkNumber), eq(indSponsors.active, true)));
        const sponsor = candidates.find(
          (candidate) =>
            candidate.legalName === configured.legalName ||
            candidate.normalizedName === normalizeLegalName(configured.legalName),
        );
        if (sponsor) matchedSponsors.push({ id: sponsor.id, configured });
        else {
          const unmatched = { legalName: configured.legalName, kvkNumber: configured.kvkNumber };
          unmatchedSponsors.push(unmatched);
          result.unmatchedSponsors.push(unmatched);
        }
      }

      if (matchedSponsors.length === 0) {
        const [persistedCompany] = await transaction
          .select({ id: companies.id })
          .from(companies)
          .where(eq(companies.domain, mapping.domain))
          .limit(1);
        if (persistedCompany) {
          await transaction
            .update(companies)
            .set({
              scanEnabled: false,
              mappingConfidence: 'unknown',
              lastVerifiedAt: verifiedAt,
              catalogHash,
              updatedAt: verifiedAt,
            })
            .where(eq(companies.id, persistedCompany.id));
          await transaction
            .update(careerSources)
            .set({ status: 'manual_review', updatedAt: verifiedAt })
            .where(
              and(
                eq(careerSources.companyId, persistedCompany.id),
                eq(careerSources.catalogManaged, true),
                isNull(careerSources.retiredAt),
              ),
            );
        }
        result.skippedCompanies.push(mapping.brandName);
        continue;
      }

      const normalizedBrandAlias = normalizeLegalName(mapping.brandName);
      const [domainOwner] = await transaction
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.domain, mapping.domain))
        .limit(1);
      const aliasOwnerRows = await transaction
        .select({ id: companyAliases.companyId })
        .from(companyAliases)
        .where(eq(companyAliases.normalizedAlias, normalizedBrandAlias));
      const aliasOwnerIds = [...new Set(aliasOwnerRows.map((owner) => owner.id))];
      if (aliasOwnerIds.length > 1) {
        throw new Error(`Ambiguous company alias in verified mapping: ${mapping.brandName}`);
      }
      const aliasOwnerId = aliasOwnerIds[0];
      if (domainOwner !== undefined && aliasOwnerId !== undefined && domainOwner.id !== aliasOwnerId) {
        throw new Error(`Company alias conflicts with verified domain: ${mapping.brandName}`);
      }

      const companyValues = {
        brandName: mapping.brandName,
        domain: mapping.domain,
        mappingConfidence: mapping.mappingConfidence,
        mappingSource: mapping.mappingSource,
        mappingEvidence: { urls: mapping.evidenceUrls, mappingVersion: mappingFile.version },
        lastVerifiedAt: verifiedAt,
        catalogHash,
        scanEnabled: mapping.scanEnabled,
        updatedAt: verifiedAt,
      } as const;
      const existingCompanyId = domainOwner?.id ?? aliasOwnerId;
      const [company] = existingCompanyId === undefined
        ? await transaction
            .insert(companies)
            .values(companyValues)
            .returning({ id: companies.id })
        : await transaction
            .update(companies)
            .set(companyValues)
            .where(eq(companies.id, existingCompanyId))
            .returning({ id: companies.id });
      if (!company) throw new Error(`Company upsert did not return an id for ${mapping.brandName}`);
      result.companiesMapped += 1;

      await transaction
        .insert(companyAliases)
        .values({
          companyId: company.id,
          alias: mapping.brandName,
          normalizedAlias: normalizeLegalName(mapping.brandName),
          source: mapping.mappingSource,
          confidence: mapping.mappingConfidence,
        })
        .onConflictDoNothing();

      for (const sponsor of matchedSponsors) {
        await transaction
          .insert(companyAliases)
          .values({
            companyId: company.id,
            alias: sponsor.configured.legalName,
            normalizedAlias: normalizeLegalName(sponsor.configured.legalName),
            source: sponsor.configured.source,
            confidence: sponsor.configured.confidence,
          })
          .onConflictDoNothing();
      }

      for (const sponsor of matchedSponsors) {
        const relationshipEvidence = {
          urls: sponsor.configured.evidenceUrls,
          mappingVersion: mappingFile.version,
        };
        await transaction
          .insert(companySponsors)
          .values({
            companyId: company.id,
            sponsorId: sponsor.id,
            relationship: 'recognised_legal_entity',
            confidence: sponsor.configured.confidence,
            source: sponsor.configured.source,
            evidence: relationshipEvidence,
            catalogManaged: true,
            discoveryManaged: false,
          })
          .onConflictDoUpdate({
            target: [companySponsors.companyId, companySponsors.sponsorId],
            set: {
              confidence: sponsor.configured.confidence,
              source: sponsor.configured.source,
              evidence: mergeJsonObject(companySponsors.evidence, relationshipEvidence),
              catalogManaged: true,
            },
          });
        result.sponsorLinks += 1;
      }
      if (unmatchedSponsors.length === 0) {
        await transaction
          .update(companySponsors)
          .set({ catalogManaged: false })
          .where(
            and(
              eq(companySponsors.companyId, company.id),
              eq(companySponsors.catalogManaged, true),
              notInArray(
                companySponsors.sponsorId,
                matchedSponsors.map((sponsor) => sponsor.id),
              ),
            ),
          );
        await transaction
          .delete(companySponsors)
          .where(
            and(
              eq(companySponsors.companyId, company.id),
              eq(companySponsors.catalogManaged, false),
              eq(companySponsors.discoveryManaged, false),
            ),
          );
      }

      for (const source of mapping.careerSources) {
        const canonicalKey = canonicalKeyForCatalogSource(source);
        const sourceEvidence = {
          urls: source.evidenceUrls,
          mappingVersion: mappingFile.version,
          ...(source.lifecycleAuthoritative === undefined
            ? {}
            : { lifecycleAuthoritative: source.lifecycleAuthoritative }),
          ...(source.statusDiagnostic === undefined
            ? {}
            : { statusDiagnostic: source.statusDiagnostic }),
        };
        const sourceValues = {
            companyId: company.id,
            sourceType: source.sourceType,
            provider: source.provider,
            baseUrl: source.baseUrl,
            boardIdentifier: source.boardIdentifier,
            canonicalKey,
            discoveryMethod: source.discoveryMethod,
            discoveryEvidence: sourceEvidence,
            status: source.status,
            retiredAt: null,
            catalogManaged: true,
            discoveryManaged: false,
            updatedAt: verifiedAt,
          } as const;
        const sourceUpdate = {
              sourceType: source.sourceType,
              provider: source.provider,
              baseUrl: source.baseUrl,
              boardIdentifier: source.boardIdentifier,
              canonicalKey,
              discoveryMethod: source.discoveryMethod,
              discoveryEvidence: mergeJsonObject(careerSources.discoveryEvidence, sourceEvidence),
              status: source.status,
              retiredAt: null,
              catalogManaged: true,
              updatedAt: verifiedAt,
            } as const;
        const [canonicalExisting] = canonicalKey === null
          ? []
          : await transaction
              .select({ id: careerSources.id, companyId: careerSources.companyId })
              .from(careerSources)
              .where(eq(careerSources.canonicalKey, canonicalKey))
              .limit(1);
        if (canonicalExisting !== undefined) {
          if (canonicalExisting.companyId !== company.id) {
            throw new Error(
              `Career source ${canonicalKey} conflicts with another verified company`,
            );
          }
          await transaction
            .update(careerSources)
            .set(sourceUpdate)
            .where(eq(careerSources.id, canonicalExisting.id));
        } else {
          await transaction
            .insert(careerSources)
            .values(sourceValues)
            .onConflictDoUpdate({
              target: [careerSources.companyId, careerSources.baseUrl],
              set: sourceUpdate,
            });
        }
        result.careerSources += 1;
      }
      const configuredSourceUrls = mapping.careerSources.map((source) => source.baseUrl);
      const staleSources = await transaction
        .select({ id: careerSources.id, discoveryManaged: careerSources.discoveryManaged })
        .from(careerSources)
        .where(
          configuredSourceUrls.length === 0
            ? and(
                eq(careerSources.companyId, company.id),
                eq(careerSources.catalogManaged, true),
              )
            : and(
                eq(careerSources.companyId, company.id),
                eq(careerSources.catalogManaged, true),
                notInArray(careerSources.baseUrl, configuredSourceUrls),
              ),
        );
      const staleSourceIds = staleSources.map((source) => source.id);
      if (staleSourceIds.length > 0) {
        await transaction
          .update(careerSources)
          .set({ catalogManaged: false, updatedAt: verifiedAt })
          .where(inArray(careerSources.id, staleSourceIds));
      }
      const retiredSourceIds = staleSources
        .filter((source) => !source.discoveryManaged)
        .map((source) => source.id);
      if (retiredSourceIds.length > 0) {
        await transaction
          .update(careerSources)
          .set({ status: 'unsupported', retiredAt: verifiedAt, updatedAt: verifiedAt })
          .where(inArray(careerSources.id, retiredSourceIds));
      }
      if (retiredSourceIds.length > 0) {
        await transaction
          .update(vacancies)
          .set({ active: false })
          .where(inArray(vacancies.careerSourceId, retiredSourceIds));
      }
    }

    const persistedCompanies = await transaction
      .select({ id: companies.id, domain: companies.domain })
      .from(companies);
    const absentCompanyIds = persistedCompanies
      .filter((company) => company.domain === null || !catalogDomains.has(company.domain))
      .map((company) => company.id);
    if (absentCompanyIds.length > 0) {
      const absentCatalogSources = await transaction
        .select({ id: careerSources.id })
        .from(careerSources)
        .where(
          and(
            inArray(careerSources.companyId, absentCompanyIds),
            eq(careerSources.catalogManaged, true),
          ),
        );
      const absentCatalogSourceIds = absentCatalogSources.map((source) => source.id);
      if (absentCatalogSourceIds.length > 0) {
        await transaction
          .update(careerSources)
          .set({ catalogManaged: false, updatedAt: verifiedAt })
          .where(inArray(careerSources.id, absentCatalogSourceIds));
      }
      const orphanedSources = await transaction
        .select({ id: careerSources.id })
        .from(careerSources)
        .where(
          and(
            inArray(careerSources.companyId, absentCompanyIds),
            eq(careerSources.catalogManaged, false),
            eq(careerSources.discoveryManaged, false),
          ),
        );
      const retiredSourceIds = orphanedSources.map((source) => source.id);
      if (retiredSourceIds.length > 0) {
        await transaction
          .update(careerSources)
          .set({ status: 'unsupported', retiredAt: verifiedAt, updatedAt: verifiedAt })
          .where(inArray(careerSources.id, retiredSourceIds));
        await transaction
          .update(vacancies)
          .set({ active: false })
          .where(inArray(vacancies.careerSourceId, retiredSourceIds));
      }
      await transaction
        .update(companySponsors)
        .set({ catalogManaged: false })
        .where(
          and(
            inArray(companySponsors.companyId, absentCompanyIds),
            eq(companySponsors.catalogManaged, true),
          ),
        );
      await transaction
        .delete(companySponsors)
        .where(
          and(
            inArray(companySponsors.companyId, absentCompanyIds),
            eq(companySponsors.catalogManaged, false),
            eq(companySponsors.discoveryManaged, false),
          ),
        );
    }

    transaction.run(sql`
      update companies as company
      set scan_enabled = (
        exists (
          select 1
          from company_sponsors as relationship
          inner join ind_sponsors as sponsor on sponsor.id = relationship.sponsor_id
          where relationship.company_id = company.id and sponsor.active = true
        )
        and exists (
          select 1
          from career_sources as source
          where source.company_id = company.id
            and source.retired_at is null
            and source.status in ('active', 'error')
        )
      ),
      updated_at = ${verifiedAt.getTime()}
    `);
  });

  return result;
}
