import type { Logger } from 'pino';

import type { AppConfig } from '../config.js';
import {
  createSafeHttpClient,
  DatabaseHttpCache,
  safeErrorClassification,
} from '../crawler/index.js';
import type { Database } from '../db/client.js';
import { syncOfficialSponsors, type SponsorSyncResult } from '../ind/repository.js';
import { OFFICIAL_IND_WORK_REGISTER_URL, parseOfficialSponsorRegister } from '../ind/source.js';

export type SponsorSyncWorkflowResult = SponsorSyncResult & {
  sourceLastUpdated: Date;
  membershipHash: string;
  retrievedFromConditionalCache: boolean;
  requestCount: number;
};

export async function runSponsorSync(
  database: Database,
  config: AppConfig,
  logger: Logger,
): Promise<SponsorSyncWorkflowResult> {
  let requestCount = 0;
  const client = createSafeHttpClient(config, {
    onNetworkRequest: () => {
      requestCount += 1;
    },
    cache: new DatabaseHttpCache(database),
    onCacheError: (error, operation, safeUrl) =>
      logger.warn(
        { ...safeErrorClassification(error), operation, url: safeUrl },
        'HTTP cache operation failed; continuing without it',
      ),
  });
  const response = await client.get(OFFICIAL_IND_WORK_REGISTER_URL, {
    headers: { accept: 'text/html,application/xhtml+xml' },
  });
  const finalUrl = new URL(response.url);
  if (finalUrl.hostname !== 'ind.nl') {
    throw new Error(`Official IND source redirected to unexpected host ${finalUrl.hostname}`);
  }
  const contentType = response.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().includes('text/html')) {
    throw new Error(`Official IND source returned unexpected content type: ${contentType || 'missing'}`);
  }

  const snapshot = parseOfficialSponsorRegister(response.text());
  const result = await syncOfficialSponsors(database, snapshot);
  logger.info(
    {
      sourceRows: result.sourceRows,
      uniqueSponsors: result.uniqueSponsors,
      duplicatesIgnored: result.duplicatesIgnored,
      sourceLastUpdated: snapshot.sourceLastUpdated.toISOString().slice(0, 10),
      membershipHash: snapshot.membershipHash,
      revalidated: response.revalidated,
    },
    'Official IND work-sponsor register synchronized',
  );
  return {
    ...result,
    sourceLastUpdated: snapshot.sourceLastUpdated,
    membershipHash: snapshot.membershipHash,
    retrievedFromConditionalCache: response.revalidated,
    requestCount,
  };
}
