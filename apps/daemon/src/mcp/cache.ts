import type { McpProviderId, McpVacancyResult } from './types.js';

export class McpResultCache {
  readonly #rows = new Map<McpProviderId, McpVacancyResult[]>();

  replace(providerId: McpProviderId, rows: McpVacancyResult[]): void {
    this.#rows.set(providerId, rows);
  }

  list(providerId: McpProviderId, now: Date): McpVacancyResult[] {
    this.purgeExpired(now);
    return [...(this.#rows.get(providerId) ?? [])];
  }

  deleteProvider(providerId: McpProviderId): void {
    this.#rows.delete(providerId);
  }

  purgeExpired(now: Date): number {
    let purged = 0;
    for (const [providerId, rows] of this.#rows) {
      const current = rows.filter((row) => Date.parse(row.expiresAt) > now.getTime());
      purged += rows.length - current.length;
      if (current.length === 0) this.#rows.delete(providerId);
      else this.#rows.set(providerId, current);
    }
    return purged;
  }
}
