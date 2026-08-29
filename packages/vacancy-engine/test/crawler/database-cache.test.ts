import { describe, expect, it, vi } from 'vitest';

import { pruneHttpCache } from '../../src/crawler/database-cache.js';
import type { Database } from '../../src/db/client.js';

describe('database HTTP cache retention', () => {
  it('deletes only entries older than the supplied cutoff and reports the count', async () => {
    const returning = vi.fn().mockResolvedValue([{ cacheKey: 'old-a' }, { cacheKey: 'old-b' }]);
    const where = vi.fn(() => ({ returning }));
    const deleteRows = vi.fn(() => ({ where }));
    const database = { delete: deleteRows } as unknown as Database;
    const cutoff = new Date('2026-05-30T00:00:00.000Z');

    await expect(pruneHttpCache(database, cutoff)).resolves.toBe(2);
    expect(deleteRows).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalledOnce();
    expect(returning).toHaveBeenCalledOnce();
  });

  it('rejects an invalid cutoff before touching the database', async () => {
    const deleteRows = vi.fn();
    const database = { delete: deleteRows } as unknown as Database;

    await expect(pruneHttpCache(database, new Date(Number.NaN))).rejects.toThrow('cutoff');
    expect(deleteRows).not.toHaveBeenCalled();
  });
});
