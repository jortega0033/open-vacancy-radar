import { expect, it } from 'vitest';

import { createVacancyAdapter } from '../../src/ats/factory.js';
import {
  ATS_ROSTER_PROVIDERS,
  atsRosterCsvUrl,
  parseAtsRosterCsv,
} from '../../src/companies/ats-roster-source.js';
import { SafeHttpClient } from '../../src/crawler/http-client.js';
import { createAtsHttpClient } from '../../src/pipeline/ats-http-client.js';

/**
 * Opt-in live contract check, mirroring `ai-dev-jobs-live.test.ts` and `remoote-live.test.ts`:
 * skipped by default so `pnpm test` never depends on storage.stapply.ai or any live ATS endpoint
 * being reachable. Set `OVR_LIVE_ATS_ROSTER=1` to actually run it.
 *
 * This is this repo's own automatable form of issue #251's acceptance criterion ("a spot-check
 * sample ... is independently confirmed live against the provider's own endpoint before the first
 * bulk import runs"): it fetches each provider's real CSV, confirms `parseAtsRosterCsv` still
 * recognizes its shape, and spot-checks a handful of parsed companies against the real ATS API each
 * adapter calls in production.
 */
const liveIt = process.env.OVR_LIVE_ATS_ROSTER === '1' ? it : it.skip;

function liveClient(): ReturnType<typeof createAtsHttpClient> {
  const safeHttp = new SafeHttpClient({
    globalConcurrency: 2,
    perDomainConcurrency: 2,
    timeoutMs: 15_000,
    queueTimeoutMs: 20_000,
    maxRetries: 0,
    maxResponseBytes: 8 * 1024 * 1024,
    userAgent:
      'OpenVacancyRadar/live-contract-test (+https://github.com/jortega0033/open-vacancy-radar)',
  });
  return createAtsHttpClient(safeHttp);
}

liveIt('parses every in-scope provider CSV from the live source with a plausible row count', async () => {
  const safeHttp = new SafeHttpClient({
    globalConcurrency: 2,
    perDomainConcurrency: 2,
    timeoutMs: 20_000,
    queueTimeoutMs: 25_000,
    maxRetries: 1,
    maxResponseBytes: 8 * 1024 * 1024,
    userAgent:
      'OpenVacancyRadar/live-contract-test (+https://github.com/jortega0033/open-vacancy-radar)',
  });

  for (const provider of ATS_ROSTER_PROVIDERS) {
    const url = atsRosterCsvUrl(provider);
    const response = await safeHttp.get(url, { allowedOrigins: [new URL(url).origin] });
    expect(response.status).toBe(200);
    const result = parseAtsRosterCsv(response.text(), provider);
    // Issue #251 cites four-figure-or-larger counts for every in-scope provider (Recruitee is the
    // smallest, at 1,164 in the ticket's own citation); a much smaller number would mean the source
    // shape has drifted and `parseAtsRosterCsv` is silently dropping almost everything.
    expect(result.entries.length).toBeGreaterThan(500);
    expect(result.invalidRowCount).toBeLessThan(result.rawRowCount * 0.05);
  }
});

liveIt(
  'confirms a handful of parsed companies per provider are still live against the real ATS endpoint',
  async () => {
    const atsHttp = liveClient();
    const safeHttp = new SafeHttpClient({
      globalConcurrency: 2,
      perDomainConcurrency: 2,
      timeoutMs: 20_000,
      queueTimeoutMs: 25_000,
      maxRetries: 1,
      maxResponseBytes: 8 * 1024 * 1024,
      userAgent:
        'OpenVacancyRadar/live-contract-test (+https://github.com/jortega0033/open-vacancy-radar)',
    });

    for (const provider of ATS_ROSTER_PROVIDERS) {
      const url = atsRosterCsvUrl(provider);
      const response = await safeHttp.get(url, { allowedOrigins: [new URL(url).origin] });
      const parsed = parseAtsRosterCsv(response.text(), provider);
      const sample = parsed.entries.slice(0, 5);
      expect(sample.length).toBeGreaterThan(0);

      const adapter = createVacancyAdapter(provider, atsHttp);
      expect(adapter).not.toBeNull();
      if (adapter === null) continue;

      let liveConfirmations = 0;
      for (const entry of sample) {
        try {
          await adapter.listVacancies({
            id: `${entry.provider}:${entry.slug}`,
            companyId: `${entry.provider}:${entry.slug}`,
            companyName: entry.company,
            provider: entry.provider,
            baseUrl: entry.baseUrl,
            boardIdentifier: entry.slug,
          });
          liveConfirmations += 1;
        } catch {
          // A stale/renamed board in a five-row sample is expected (see issue #251's own moonie0201
          // citation: a real-world ~10-20% stale rate per provider); this loop is a spot check, not
          // a strict assertion that every sampled row is still live.
        }
      }
      // At least a minority of a five-row sample should still be live; zero of five would indicate
      // the source (or this repo's detection/adapter wiring) has broken, not ordinary staleness.
      expect(liveConfirmations).toBeGreaterThan(0);
    }
  },
  // 5 providers x up to 5 companies each, sequentially, against real (sometimes slow) ATS
  // endpoints -- comfortably over vitest's 10s default single-test timeout.
  120_000,
);
