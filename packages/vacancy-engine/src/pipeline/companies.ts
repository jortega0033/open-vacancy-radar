import type { Logger } from 'pino';

import { loadCompanyMappings } from '../companies/mappings.js';
import { syncVerifiedCompanyMappings, type CompanyMappingSyncResult } from '../companies/repository.js';
import type { Database } from '../db/client.js';

export async function runCompanyMappingSync(
  database: Database,
  logger: Logger,
): Promise<CompanyMappingSyncResult> {
  const mappings = await loadCompanyMappings();
  const result = await syncVerifiedCompanyMappings(database, mappings);
  logger.info(
    {
      mappingVersion: mappings.version,
      companiesMapped: result.companiesMapped,
      sponsorLinks: result.sponsorLinks,
      careerSources: result.careerSources,
      unmatchedSponsors: result.unmatchedSponsors.length,
      skippedCompanies: result.skippedCompanies.length,
    },
    'Verified company and careers mappings synchronized',
  );
  if (result.unmatchedSponsors.length > 0) {
    logger.warn({ sponsors: result.unmatchedSponsors }, 'Some configured IND sponsor identities did not match');
  }
  if (result.skippedCompanies.length > 0) {
    logger.warn({ companies: result.skippedCompanies }, 'Companies without a current sponsor match were skipped');
  }
  return result;
}
