import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type { SafeHttpClient, SafeHttpStreamGetOptions } from '../../src/crawler/http-client.js';
import {
  emptyMpsvLookups,
  MPSV_CZ_CODE_LIST_BASE_URL,
  MPSV_CZ_CORE_KEYS,
  MPSV_CZ_DATASET_PAGE_URL,
  MPSV_CZ_PERSONAL_DATA_KEYS,
  MPSV_CZ_SNAPSHOT_URL,
  normalizeMpsvRecord,
  parseMpsvCodeList,
  redactMpsvFreeText,
  runMpsvCzDiscovery,
  type MpsvLookups,
} from '../../src/global-remote/mpsv-cz-discovery.js';
import { MpsvSnapshotError, MpsvSnapshotParser } from '../../src/global-remote/mpsv-cz-snapshot.js';
import { uniqueDiscovery } from '../../src/pipeline/global-remote.js';
import { globalRemoteSourceRegistry } from '../../src/global-remote/source-registry.js';
import { globalRemoteConfigSchema } from '../../src/global-remote/models.js';

const FIXTURE_ROOT = path.resolve(process.cwd(), 'test/fixtures/global-remote/mpsv-cz');
const NOW = new Date('2026-10-05T10:00:00Z');
const CONFIG = { minimumAnnualBaseUsd: null };

function fixtureText(...parts: string[]): string {
  return readFileSync(path.join(FIXTURE_ROOT, ...parts), 'utf8');
}

type Snapshot = { polozky: Record<string, unknown>[] };

function day1(): Snapshot {
  return JSON.parse(fixtureText('snapshot-day1.json')) as Snapshot;
}

const CODE_LIST_FILES: Record<string, string> = {
  obce: 'obce.json',
  okresy: 'okresy.json',
  kraje: 'kraje.json',
  'pracovnepravni-vztahy': 'pracovnepravni-vztahy.json',
  smennosti: 'smennosti.json',
  'vzdelani-detailni-kategorie': 'vzdelani-detailni-kategorie.json',
  dovednosti: 'dovednosti.json',
  jazyky: 'jazyky.json',
  'urovne-znalosti-jazyka': 'urovne-znalosti-jazyka.json',
};

function fixtureLookups(): MpsvLookups {
  const read = (file: string): Map<string, string> =>
    parseMpsvCodeList(fixtureText('code-lists', file));
  return {
    obec: read('obce.json'),
    okres: read('okresy.json'),
    kraj: read('kraje.json'),
    relationship: read('pracovnepravni-vztahy.json'),
    shift: read('smennosti.json'),
    education: read('vzdelani-detailni-kategorie.json'),
    skill: read('dovednosti.json'),
    language: read('jazyky.json'),
    languageLevel: read('urovne-znalosti-jazyka.json'),
  };
}

type Route = {
  body?: Uint8Array | string;
  status?: number;
  headers?: Record<string, string>;
  chunkSize?: number;
  fail?: Error;
};

/** A `streamGet` double that serves routes by URL, feeding the body to `onChunk` in small slices. */
function fakeClient(snapshot: Route, overrides: Record<string, Route> = {}) {
  const requested: string[] = [];
  const routes = new Map<string, Route>();
  for (const [name, file] of Object.entries(CODE_LIST_FILES)) {
    routes.set(`${MPSV_CZ_CODE_LIST_BASE_URL}/${name}.json`, { body: fixtureText('code-lists', file) });
  }
  routes.set(MPSV_CZ_SNAPSHOT_URL, snapshot);
  for (const [url, route] of Object.entries(overrides)) routes.set(url, route);
  const streamGet = async (url: string | URL, options: SafeHttpStreamGetOptions) => {
    const key = String(url);
    requested.push(key);
    const route = routes.get(key);
    if (route === undefined) throw new Error(`unexpected request ${key}`);
    if (route.fail !== undefined) throw route.fail;
    const body =
      typeof route.body === 'string' ? Buffer.from(route.body, 'utf8') : (route.body ?? Buffer.alloc(0));
    const chunkSize = route.chunkSize ?? 997;
    const controller = new AbortController();
    for (let offset = 0; offset < body.byteLength; offset += chunkSize) {
      options.onChunk(body.subarray(offset, offset + chunkSize), controller.signal);
    }
    return {
      requestedUrl: key,
      url: key,
      status: route.status ?? 200,
      headers: route.headers ?? { 'content-type': 'application/x-gzip' },
      bytesRead: body.byteLength,
    };
  };
  return { client: { streamGet } as unknown as Pick<SafeHttpClient, 'streamGet'>, requested };
}

function jsonRoute(snapshot: unknown, extra: Partial<Route> = {}): Route {
  return { body: JSON.stringify(snapshot, null, 1), ...extra };
}

function gzipRoute(snapshot: unknown, extra: Partial<Route> = {}): Route {
  return { body: gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8')), ...extra };
}

function sourceOf(run: Awaited<ReturnType<typeof runMpsvCzDiscovery>>) {
  expect(run.sources).toHaveLength(1);
  const source = run.sources[0];
  if (source === undefined) throw new Error('no source row');
  return source;
}

describe('MpsvSnapshotParser streaming', () => {
  const text = JSON.stringify(day1());

  async function collect(chunks: Uint8Array[]): Promise<{ records: unknown[]; count: number }> {
    const records: unknown[] = [];
    const parser = new MpsvSnapshotParser({ onRecord: (record) => records.push(record) });
    for (const chunk of chunks) parser.write(chunk);
    const count = await parser.finish();
    return { records, count };
  }

  function slices(bytes: Uint8Array, size: number): Uint8Array[] {
    const result: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
      result.push(bytes.subarray(offset, offset + size));
    }
    return result;
  }

  it('yields every record from arbitrarily small chunks, including split multibyte characters', async () => {
    const bytes = Buffer.from(text, 'utf8');
    for (const size of [1, 3, 7, 64, 5000]) {
      const { records, count } = await collect(slices(bytes, size));
      expect(count).toBe(7);
      expect(records).toEqual(day1().polozky);
    }
  });

  it('hands records over one at a time without needing the whole document', async () => {
    const bytes = Buffer.from(text, 'utf8');
    let written = 0;
    const writtenAtEmit: number[] = [];
    const parser = new MpsvSnapshotParser({ onRecord: () => writtenAtEmit.push(written) });
    for (const chunk of slices(bytes, 512)) {
      written += chunk.byteLength;
      parser.write(chunk);
    }
    // Records were emitted before the last byte was written, not only at finish().
    expect(writtenAtEmit).toHaveLength(7);
    expect(written).toBe(bytes.byteLength);
    expect(writtenAtEmit[0]).toBeLessThan(bytes.byteLength);
    expect(writtenAtEmit[1]).toBeLessThan(bytes.byteLength);
    expect(writtenAtEmit[0]).toBeLessThan(writtenAtEmit[6] ?? 0);
    await parser.finish();
  });

  it('stream-decompresses a gzip archive in small chunks', async () => {
    const gz = gzipSync(Buffer.from(text, 'utf8'));
    const { records, count } = await collect(slices(gz, 11));
    expect(count).toBe(7);
    expect(records).toHaveLength(7);
  });

  it('accepts a one-byte first chunk before it can tell gzip from JSON', async () => {
    const gz = gzipSync(Buffer.from(text, 'utf8'));
    const { count } = await collect([gz.subarray(0, 1), gz.subarray(1)]);
    expect(count).toBe(7);
  });

  it('reports a corrupt gzip archive without echoing content', async () => {
    const gz = Buffer.from(gzipSync(Buffer.from(text, 'utf8')));
    gz[Math.floor(gz.length / 2)] = (gz[Math.floor(gz.length / 2)] ?? 0) ^ 0xff;
    await expect(collect(slices(gz, 64))).rejects.toMatchObject({ kind: 'corrupt' });
  });

  it('reports a truncated gzip archive (partial download)', async () => {
    const gz = gzipSync(Buffer.from(text, 'utf8'));
    await expect(collect(slices(gz.subarray(0, Math.floor(gz.length * 0.6)), 64))).rejects.toMatchObject({
      kind: 'corrupt',
    });
  });

  it('reports truncated JSON (partial download of an already decoded body)', async () => {
    const bytes = Buffer.from(text, 'utf8');
    await expect(collect(slices(bytes.subarray(0, bytes.length - 40), 200))).rejects.toMatchObject({
      kind: 'truncated',
    });
  });

  it('rejects bodies that are not the documented object shape', async () => {
    await expect(collect([Buffer.from('<html>error page</html>')])).rejects.toMatchObject({ kind: 'drift' });
    await expect(collect([Buffer.from('{"other":[]}')])).rejects.toMatchObject({ kind: 'drift' });
    await expect(collect([Buffer.from('{"polozky":[1]}')])).rejects.toMatchObject({ kind: 'drift' });
    await expect(collect([Buffer.from('{"polozky":[{"a":1}]} trailing')])).rejects.toMatchObject({
      kind: 'drift',
    });
    await expect(collect([Buffer.from('')])).rejects.toBeInstanceOf(MpsvSnapshotError);
  });

  it('keeps invalid JSON error messages free of payload text', async () => {
    const secret = 'Synthetic Person';
    const body = `{"polozky":[{"jmeno":"${secret}",,}]}`;
    const failure = await collect([Buffer.from(body)]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MpsvSnapshotError);
    expect(String((failure as Error).message)).not.toContain(secret);
  });

  it('enforces the per-record size bound', async () => {
    const parser = new MpsvSnapshotParser({ onRecord: () => undefined, maxRecordChars: 100 });
    expect(() => parser.write(Buffer.from(`{"polozky":[{"a":"${'x'.repeat(500)}"}]}`))).toThrow(
      MpsvSnapshotError,
    );
  });

  it('accepts an empty polozky array and reports zero records', async () => {
    const { count } = await collect([Buffer.from('{"polozky":[]}')]);
    expect(count).toBe(0);
  });
});

describe('normalizeMpsvRecord', () => {
  const lookups = fixtureLookups();
  const options = { today: '2026-10-05', minimumAnnualBaseUsd: null };
  const byId = (id: number) => {
    const entry = day1().polozky.find((item) => item.portalId === id);
    if (entry === undefined) throw new Error(`fixture ${id} missing`);
    return normalizeMpsvRecord(entry, lookups, options);
  };
  const vacancy = (id: number) => {
    const result = byId(id);
    if (result.kind !== 'vacancy') throw new Error(`fixture ${id} was ${result.kind}`);
    return result.vacancy;
  };

  it('maps a monthly-salary record with stable ID, employer link, and Czech geography', () => {
    const row = vacancy(90000001);
    expect(row.key).toBe('mpsv_cz:90000001');
    expect(row.provider).toBe('mpsv_cz');
    expect(row.company).toBe('Example Employer s.r.o.');
    expect(row.title).toBe('Účetní (m/ž)');
    expect(row.location).toBe('Praha, Czechia');
    expect(row.url).toBe('https://careers.example.cz/jobs/90000001');
    expect(row.currency).toBe('CZK');
    expect(row.salaryPeriod).toBe('monthly');
    expect(row.advertisedMinimum).toBe(35_000);
    expect(row.employmentType).toBe('Full-time');
    expect(row.postedAt).toBe('2026-09-25T00:00:00.000Z');
    expect(row.description).toContain('Salary: 35000 to 45000 CZK per month');
    expect(row.description).toContain('Employment relationship: Pracovní poměr - plný úvazek');
    expect(row.description).toContain('Skills: Ekonomika: podvojné účetnictví');
    expect(row.description).toContain('Languages: Angličtina (Aktivní)');
    expect(row.description).toContain('Open positions: 2');
    expect(row.description).toContain('Source: open vacancy data of the Czech Ministry');
  });

  it('keeps hourly salary period and resolves a municipality through the obec code list', () => {
    const row = vacancy(90000002);
    expect(row.salaryPeriod).toBe('hourly');
    expect(row.advertisedMinimum).toBe(250);
    expect(row.location).toBe('Brno, Czechia');
    // Part-time is mapped; the dpp agreement is not guessed, only shown verbatim.
    expect(row.employmentType).toBe('Part-time');
    expect(row.description).toContain('Dohoda o provedení práce');
    expect(row.description).toContain('Fixed term until: 2027-03-31');
  });

  it('names districts for an okres-typed workplace and leaves absent salary and type unmapped', () => {
    const row = vacancy(90000003);
    expect(row.location).toBe('Benešov District / Vyškov District, Czechia');
    expect(row.currency).toBeNull();
    expect(row.salaryPeriod).toBeNull();
    expect(row.advertisedMinimum).toBeNull();
    expect(row.employmentType).toBeNull();
  });

  it('falls back to the official dataset page when there is no employer URL, never a made-up job page', () => {
    const row = vacancy(90000003);
    expect(row.url).toBe(`${MPSV_CZ_DATASET_PAGE_URL}#VolneMisto-90000003`);
    expect(row.sourceUrl).toBe(row.url);
    expect(new URL(row.url).hostname).toBe('data.mpsv.cz');
    // The shared dataset page must not become a canonical-URL merge key for different postings.
    expect(row.identity?.kind).toBe('requisition');
    expect(row.applyUrl?.status).toBe('unresolved');
    expect(vacancy(90000006).identity?.key).not.toBe(row.identity?.key);
  });

  it('excludes expired and not-for-publication records, and keeps one that expires today', () => {
    expect(byId(90000004)).toEqual({ kind: 'skipped', reason: 'expired' });
    expect(byId(90000005)).toEqual({ kind: 'skipped', reason: 'not_published' });
    expect(byId(90000007).kind).toBe('vacancy');
    const tomorrow = normalizeMpsvRecord(
      day1().polozky.find((item) => item.portalId === 90000007),
      lookups,
      { ...options, today: '2026-10-06' },
    );
    expect(tomorrow).toEqual({ kind: 'skipped', reason: 'expired' });
  });

  it('uses Prague local date for expiry, not UTC', async () => {
    const records = day1();
    const run = await runMpsvCzDiscovery(fakeClient(jsonRoute(records)).client, CONFIG, {
      now: () => new Date('2026-10-05T22:30:00Z'), // already 2026-10-06 in Prague
    });
    expect(run.vacancies.map((row) => row.key)).not.toContain('mpsv_cz:90000007');
  });

  it('hides an undisclosed employer and treats whole-country work as plain Czechia', () => {
    const row = vacancy(90000006);
    expect(row.company).toBe('Employer not disclosed');
    expect(row.location).toBe('Czechia');
    expect(row.advertisedMinimum).toBe(28_000);
  });

  it('never marks anything remote and does not guess unknown codes', () => {
    const entry = { ...(day1().polozky[0] ?? {}), typMzdy: { id: 'TypMzdy/novy' }, pracovnePravniVztahy: [{ id: 'PracovnepravniVztah/neznamy' }] };
    const result = normalizeMpsvRecord(entry, lookups, options);
    if (result.kind !== 'vacancy') throw new Error('expected vacancy');
    expect(result.vacancy.salaryPeriod).toBeNull();
    expect(result.vacancy.employmentType).toBeNull();
    expect(result.vacancy.location).not.toMatch(/remote/iu);
  });

  it('excludes unknown publication codes and flags structurally broken records as invalid', () => {
    const base = day1().polozky[0] ?? {};
    expect(normalizeMpsvRecord({ ...base, zverejnovat: { id: 'ZverejnovatVpm/novy' } }, lookups, options)).toEqual({
      kind: 'skipped',
      reason: 'not_published',
    });
    expect(normalizeMpsvRecord({ ...base, portalId: 'x' }, lookups, options).kind).toBe('invalid');
    expect(normalizeMpsvRecord({ ...base, zverejnovat: null }, lookups, options).kind).toBe('invalid');
    expect(normalizeMpsvRecord({ ...base, expirace: '31.12.2026' }, lookups, options).kind).toBe('invalid');
    expect(normalizeMpsvRecord({ ...base, pozadovanaProfese: { cs: '  ' } }, lookups, options).kind).toBe('invalid');
    expect(normalizeMpsvRecord('nope', lookups, options).kind).toBe('invalid');
  });

  it('still produces a row, with plain Czechia, when code lists are unavailable', () => {
    const result = normalizeMpsvRecord(day1().polozky[0], emptyMpsvLookups(), options);
    if (result.kind !== 'vacancy') throw new Error('expected vacancy');
    expect(result.vacancy.location).toBe('Czechia');
  });

  it('rejects an employer URL with embedded credentials', () => {
    const entry = { ...(day1().polozky[0] ?? {}), urlAdresa: 'https://user:pass@careers.example.cz/job' };
    const result = normalizeMpsvRecord(entry, lookups, options);
    if (result.kind !== 'vacancy') throw new Error('expected vacancy');
    expect(result.vacancy.url).toContain('data.mpsv.cz');
  });
});

describe('personal data omission', () => {
  // Deliberately synthetic values that only exist in this test; none of it is committed as a fixture.
  const SYNTHETIC = {
    first: 'Testovaci',
    last: 'Kontaktnizz',
    title: 'Ing. Zkusebni',
    position: 'Vedouci zkusebni',
    email: 'kontakt.zkusebni@example.invalid',
    phone: '+420 700 000 111',
    workplaceEmail: 'pobocka.zkusebni@example.invalid',
    workplacePhone: '700 000 222',
  };

  function leakySnapshot(): Snapshot {
    const snapshot = day1();
    const first = snapshot.polozky[0];
    if (first === undefined) throw new Error('fixture missing');
    first.prvniKontaktSeZamestnavatelem = {
      komuSeHlasit: {
        email: SYNTHETIC.email,
        telefon: SYNTHETIC.phone,
        jmeno: SYNTHETIC.first,
        prijmeni: SYNTHETIC.last,
        titulPredJmenem: SYNTHETIC.title,
        titulZaJmenem: null,
        poziceVeSpolecnosti: SYNTHETIC.position,
      },
      kdeSeHlasit: { email: SYNTHETIC.email, telefon: SYNTHETIC.phone, mistoKontaktu: 'Recepce', adresa: null },
    };
    const place = (first.mistoVykonuPrace as { pracoviste: Record<string, unknown>[] }).pracoviste[0];
    if (place === undefined) throw new Error('fixture workplace missing');
    place.email = SYNTHETIC.workplaceEmail;
    place.telefon = SYNTHETIC.workplacePhone;
    first.upresnujiciInformace = {
      cs: `Volejte ${SYNTHETIC.phone} nebo pište na ${SYNTHETIC.email}. Mzda 35000-45000 Kč. Nebo 700 000 333.`,
    };
    return snapshot;
  }

  it('never lets contact-person, e-mail or phone data reach a row, hash input, or source row', async () => {
    const { client } = fakeClient(jsonRoute(leakySnapshot()));
    const run = await runMpsvCzDiscovery(client, CONFIG, { now: () => NOW });
    expect(sourceOf(run).status).toBe('success');
    const serialized = JSON.stringify(run);
    for (const value of Object.values(SYNTHETIC)) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('700 000 333');
    for (const key of MPSV_CZ_PERSONAL_DATA_KEYS) expect(serialized).not.toContain(`"${key}"`);
    // The legitimate figures in the same note survive redaction.
    const row = run.vacancies.find((item) => item.key === 'mpsv_cz:90000001');
    expect(row?.description).toContain('35000-45000');
  });

  it('keeps the content hash independent of personal fields', async () => {
    const clean = await runMpsvCzDiscovery(fakeClient(jsonRoute(day1())).client, CONFIG, { now: () => NOW });
    const noisy = day1();
    const first = noisy.polozky[0];
    if (first === undefined) throw new Error('fixture missing');
    first.prvniKontaktSeZamestnavatelem = { komuSeHlasit: { jmeno: SYNTHETIC.first, email: SYNTHETIC.email } };
    const withContact = await runMpsvCzDiscovery(fakeClient(jsonRoute(noisy)).client, CONFIG, { now: () => NOW });
    expect(withContact.vacancies.map((row) => row.contentHash)).toEqual(
      clean.vacancies.map((row) => row.contentHash),
    );
  });

  it('keeps error messages free of record content', async () => {
    const snapshot = leakySnapshot();
    const body = JSON.stringify(snapshot).replace('"polozky"', '"polozky"').slice(0, -30);
    const run = await runMpsvCzDiscovery(fakeClient({ body }).client, CONFIG, { now: () => NOW });
    const source = sourceOf(run);
    expect(source.status).toBe('error');
    for (const value of Object.values(SYNTHETIC)) expect(JSON.stringify(source)).not.toContain(value);
  });

  it('redacts obfuscated e-mails and spaced, dotted or dashed long digit runs', () => {
    expect(redactMpsvFreeText('piste na jan(at)firma.cz nebo jana [at] firma . cz ok')).toBe('piste na nebo ok');
    expect(redactMpsvFreeText('tel 777 12 34 56 7, 777.123.456, 777-123-456-0 konec')).toBe('tel , , konec');
    expect(redactMpsvFreeText('mzda 35 000 - 45 000 Kč')).toContain('35 000');
  });

  it('redacts title and company as well as the description', () => {
    const base = day1().polozky[0];
    if (base === undefined) throw new Error('fixture missing');
    const entry = {
      ...base,
      pozadovanaProfese: { cs: 'Řidič volejte 777 123 456' },
      zamestnavatel: { ...(base.zamestnavatel as object), nazev: 'Firma s.r.o. jan(at)firma.cz' },
    };
    const result = normalizeMpsvRecord(entry, fixtureLookups(), { today: '2026-10-05', minimumAnnualBaseUsd: null });
    if (result.kind !== 'vacancy') throw new Error('expected vacancy');
    expect(result.vacancy.title).toBe('Řidič volejte');
    expect(result.vacancy.company).toBe('Firma s.r.o.');
  });

  it('redacts e-mail addresses and phone-like numbers but not salary figures', () => {
    expect(redactMpsvFreeText('Mail: a.b@firma.cz, tel +420 777 123 456 nebo 777123456.')).toBe('Mail: , tel nebo .');
    expect(redactMpsvFreeText('Plat 35000-45000 Kč, 250 Kč/hod')).toBe('Plat 35000-45000 Kč, 250 Kč/hod');
  });
});

describe('fixture personal-data scan', () => {
  const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u;
  const PHONE =
    /(?:\+|\b00)\d{1,3}\p{Zs}?(?:\d\p{Zs}?){8,12}|(?<!\d)\d{3}[\p{Zs}.-]?\d{3}[\p{Zs}.-]?\d{3}(?!\d)/u;

  function scanText(text: string): string[] {
    const problems: string[] = [];
    for (const key of MPSV_CZ_PERSONAL_DATA_KEYS) {
      if (text.includes(`"${key}"`)) problems.push(`personal field "${key}"`);
    }
    if (EMAIL.test(text)) problems.push('e-mail address');
    if (PHONE.test(text)) problems.push('phone number');
    return problems;
  }

  function dataFixtureFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const full = path.join(directory, name);
      // `official/` holds the publisher's own schema/metadata, which name the personal fields by design.
      if (statSync(full).isDirectory()) return name === 'official' ? [] : dataFixtureFiles(full);
      return [full];
    });
  }

  it('finds no contact-person, e-mail or phone data in any committed data fixture', () => {
    const files = dataFixtureFiles(FIXTURE_ROOT);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const raw = readFileSync(file);
      const text = file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      expect({ file: path.relative(FIXTURE_ROOT, file), problems: scanText(text) }).toEqual({
        file: path.relative(FIXTURE_ROOT, file),
        problems: [],
      });
    }
  });

  it('fails when a fixture would leak personal data (scanner self-check)', () => {
    expect(scanText('{"jmeno":"Nobody"}')).not.toEqual([]);
    expect(scanText('{"x":"someone@example.cz"}')).not.toEqual([]);
    expect(scanText('{"x":"+420 777 123 456"}')).not.toEqual([]);
    expect(scanText('{"x":"777123456"}')).not.toEqual([]);
    expect(scanText(fixtureText('snapshot-day1.json'))).toEqual([]);
  });

  it('only uses fields the official JSON Schema defines', () => {
    const schema = JSON.parse(fixtureText('official', 'volna-mista.schema.json')) as {
      properties: { polozky: { items: { properties: Record<string, unknown> } } };
    };
    const allowed = new Set(Object.keys(schema.properties.polozky.items.properties));
    for (const key of MPSV_CZ_CORE_KEYS) expect(allowed.has(key)).toBe(true);
    for (const entry of day1().polozky) {
      for (const key of Object.keys(entry)) expect(allowed.has(key)).toBe(true);
    }
  });

  it('records the official licence and publisher facts the registry relies on', () => {
    const metadata = JSON.parse(fixtureText('official', 'volna-mista-metadata.excerpt.json')) as Record<string, unknown>;
    expect(JSON.stringify(metadata)).toContain('neobsahuje-autorská-díla');
    expect(JSON.stringify(metadata)).toContain('není-chráněna-zvláštním-právem-pořizovatele-databáze');
    expect(JSON.stringify(metadata)).toContain('DAILY');
  });
});

describe('runMpsvCzDiscovery', () => {
  it('imports a plain-JSON snapshot and reports one successful source', async () => {
    const { client, requested } = fakeClient(jsonRoute(day1()));
    const run = await runMpsvCzDiscovery(client, CONFIG, { now: () => NOW });
    const source = sourceOf(run);
    expect(source).toMatchObject({
      id: 'mpsv_cz:snapshot',
      provider: 'mpsv_cz',
      status: 'success',
      listings: 5,
      error: null,
      complete: true,
    });
    expect(run.vacancies.map((row) => row.key).sort()).toEqual([
      'mpsv_cz:90000001',
      'mpsv_cz:90000002',
      'mpsv_cz:90000003',
      'mpsv_cz:90000006',
      'mpsv_cz:90000007',
    ]);
    expect(requested.filter((url) => url === MPSV_CZ_SNAPSHOT_URL)).toHaveLength(1);
    // Increment files are never requested.
    expect(requested.some((url) => url.includes('prirustek'))).toBe(false);
  });

  it('imports a gzip archive delivered as raw gzip bytes', async () => {
    const run = await runMpsvCzDiscovery(fakeClient(gzipRoute(day1(), { chunkSize: 64 })).client, CONFIG, {
      now: () => NOW,
    });
    expect(sourceOf(run).status).toBe('success');
    expect(run.vacancies).toHaveLength(5);
  });

  it('keeps stable IDs and content hashes across identical runs', async () => {
    const first = await runMpsvCzDiscovery(fakeClient(jsonRoute(day1())).client, CONFIG, { now: () => NOW });
    const second = await runMpsvCzDiscovery(fakeClient(gzipRoute(day1())).client, CONFIG, { now: () => NOW });
    expect(second.vacancies.map((row) => [row.key, row.contentHash])).toEqual(
      first.vacancies.map((row) => [row.key, row.contentHash]),
    );
  });

  it('reconciles snapshot to snapshot: removed and newly expired records disappear, changes apply', async () => {
    const first = await runMpsvCzDiscovery(fakeClient(jsonRoute(day1())).client, CONFIG, { now: () => NOW });
    expect(first.vacancies.map((row) => row.key)).toContain('mpsv_cz:90000002');
    expect(first.vacancies.map((row) => row.key)).toContain('mpsv_cz:90000007');

    const nextDay = day1();
    // 90000002 was withdrawn upstream (absent), 90000001 got a raise, 90000008 is new.
    nextDay.polozky = nextDay.polozky.filter((entry) => entry.portalId !== 90000002);
    const changed = nextDay.polozky.find((entry) => entry.portalId === 90000001);
    if (changed === undefined) throw new Error('fixture missing');
    changed.mesicniMzdaOd = 40_000;
    changed.datumZmeny = '2026-10-05T07:00:00.000Z';
    nextDay.polozky.push({ ...changed, portalId: 90000008, id: 'VolneMisto/90000008', urlAdresa: null });

    const second = await runMpsvCzDiscovery(fakeClient(jsonRoute(nextDay)).client, CONFIG, {
      now: () => new Date('2026-10-06T10:00:00Z'),
    });
    const keys = second.vacancies.map((row) => row.key);
    expect(keys).not.toContain('mpsv_cz:90000002'); // removed upstream
    expect(keys).not.toContain('mpsv_cz:90000007'); // expired on 2026-10-05
    expect(keys).toContain('mpsv_cz:90000008');
    const raised = second.vacancies.find((row) => row.key === 'mpsv_cz:90000001');
    const before = first.vacancies.find((row) => row.key === 'mpsv_cz:90000001');
    expect(raised?.advertisedMinimum).toBe(40_000);
    expect(raised?.contentHash).not.toBe(before?.contentHash);
  });

  it('reports a corrupt gzip as a source failure with no vacancies', async () => {
    const gz = Buffer.from(gzipSync(Buffer.from(JSON.stringify(day1()))));
    gz[Math.floor(gz.length / 2)] = (gz[Math.floor(gz.length / 2)] ?? 0) ^ 0xff;
    const run = await runMpsvCzDiscovery(fakeClient({ body: gz }).client, CONFIG, { now: () => NOW });
    expect(run.vacancies).toEqual([]);
    expect(sourceOf(run)).toMatchObject({ status: 'error', complete: false });
    expect(sourceOf(run).error).toMatch(/corrupt/u);
  });

  it('reports a partial download (truncated archive or JSON) as a source failure', async () => {
    const gz = gzipSync(Buffer.from(JSON.stringify(day1())));
    const truncatedGzip = await runMpsvCzDiscovery(
      fakeClient({ body: gz.subarray(0, Math.floor(gz.length / 2)) }).client,
      CONFIG,
      { now: () => NOW },
    );
    expect(sourceOf(truncatedGzip).status).toBe('error');
    const json = Buffer.from(JSON.stringify(day1()));
    const truncatedJson = await runMpsvCzDiscovery(
      fakeClient({ body: json.subarray(0, json.length - 25) }).client,
      CONFIG,
      { now: () => NOW },
    );
    expect(sourceOf(truncatedJson).error).toMatch(/complete/u);
    expect(truncatedJson.vacancies).toEqual([]);
  });

  it('reports empty data as a failure, not as a healthy empty source', async () => {
    const empty = await runMpsvCzDiscovery(fakeClient(jsonRoute({ polozky: [] })).client, CONFIG, { now: () => NOW });
    expect(sourceOf(empty)).toMatchObject({ status: 'error', listings: 0 });
    expect(sourceOf(empty).error).toMatch(/empty/u);

    const allHidden = day1();
    allHidden.polozky = allHidden.polozky.filter((entry) => entry.portalId === 90000004 || entry.portalId === 90000005);
    const hidden = await runMpsvCzDiscovery(fakeClient(jsonRoute(allHidden)).client, CONFIG, { now: () => NOW });
    expect(sourceOf(hidden).status).toBe('error');
    expect(sourceOf(hidden).error).toMatch(/no active, published/u);
  });

  it('reports schema drift when a documented field disappears from every record', async () => {
    const drifted = day1();
    for (const entry of drifted.polozky) {
      entry.mesicniMzdaNova = entry.mesicniMzdaOd;
      delete entry.mesicniMzdaOd;
    }
    const run = await runMpsvCzDiscovery(fakeClient(jsonRoute(drifted)).client, CONFIG, { now: () => NOW });
    expect(sourceOf(run).status).toBe('error');
    expect(sourceOf(run).error).toMatch(/schema drift.*mesicniMzdaOd/u);
    expect(run.vacancies).toEqual([]);
  });

  it('reports schema drift when many records break the contract, and tolerates a few', async () => {
    const mostlyBroken = day1();
    for (const entry of mostlyBroken.polozky) entry.portalId = 'not-a-number';
    const broken = await runMpsvCzDiscovery(fakeClient(jsonRoute(mostlyBroken)).client, CONFIG, { now: () => NOW });
    expect(sourceOf(broken).status).toBe('error');

    const manyRecords = day1();
    const template = manyRecords.polozky[0];
    if (template === undefined) throw new Error('fixture missing');
    for (let index = 0; index < 60; index += 1) {
      manyRecords.polozky.push({ ...template, portalId: 91000000 + index, id: `VolneMisto/${91000000 + index}`, urlAdresa: null });
    }
    manyRecords.polozky.push({ ...template, portalId: 'broken' });
    const tolerant = await runMpsvCzDiscovery(fakeClient(jsonRoute(manyRecords)).client, CONFIG, { now: () => NOW });
    expect(sourceOf(tolerant).status).toBe('partial');
    expect(sourceOf(tolerant).error).toMatch(/1 records were skipped/u);
    expect(tolerant.vacancies.length).toBeGreaterThan(60);
  });

  it('turns HTTP failures and wrong content types into a source failure without throwing', async () => {
    const http500 = await runMpsvCzDiscovery(
      fakeClient({ fail: Object.assign(new Error('mpsv: HTTP 503'), { status: 503 }) }).client,
      CONFIG,
      { now: () => NOW },
    );
    expect(sourceOf(http500).status).toBe('error');
    const html = await runMpsvCzDiscovery(
      fakeClient({ body: JSON.stringify(day1()), headers: { 'content-type': 'text/html' } }).client,
      CONFIG,
      { now: () => NOW },
    );
    expect(sourceOf(html).error).toMatch(/content type/u);
    expect(html.vacancies).toEqual([]);
  });

  it('degrades to a partial source when a code list is unavailable', async () => {
    const { client } = fakeClient(jsonRoute(day1()), {
      [`${MPSV_CZ_CODE_LIST_BASE_URL}/obce.json`]: { fail: new Error('down') },
    });
    const run = await runMpsvCzDiscovery(client, CONFIG, { now: () => NOW });
    expect(sourceOf(run).status).toBe('partial');
    expect(sourceOf(run).error).toContain('obce');
    expect(run.vacancies.find((row) => row.key === 'mpsv_cz:90000002')?.location).toBe('Czechia');
  });

  it('bounds retention and says so', async () => {
    const run = await runMpsvCzDiscovery(fakeClient(jsonRoute(day1())).client, CONFIG, {
      now: () => NOW,
      maxRetainedRecords: 2,
    });
    expect(run.vacancies).toHaveLength(2);
    expect(sourceOf(run)).toMatchObject({ status: 'partial', complete: false });
    expect(sourceOf(run).error).toMatch(/3 older ones were not retained/u);
  });

  it('supports a capped scan and reports it as partial', async () => {
    const run = await runMpsvCzDiscovery(fakeClient(jsonRoute(day1())).client, CONFIG, {
      now: () => NOW,
      maxScannedRecords: 2,
    });
    expect(run.vacancies.map((row) => row.key)).toEqual(['mpsv_cz:90000001', 'mpsv_cz:90000002']);
    expect(sourceOf(run).status).toBe('partial');
    expect(sourceOf(run).error).toMatch(/stopped after 2 records/u);
  });

  it('flags a stale snapshot from Last-Modified', async () => {
    const run = await runMpsvCzDiscovery(
      fakeClient(jsonRoute(day1(), { headers: { 'content-type': 'application/x-gzip', 'last-modified': 'Mon, 01 Sep 2026 00:00:00 GMT' } })).client,
      CONFIG,
      { now: () => NOW },
    );
    expect(sourceOf(run).status).toBe('error');
    expect(sourceOf(run).error).toMatch(/stale/u);
    expect(run.vacancies).toEqual([]);
  });

  it('passes bounded, origin-restricted stream options to the HTTP client', async () => {
    const calls: SafeHttpStreamGetOptions[] = [];
    const inner = fakeClient(jsonRoute(day1())).client;
    const client = {
      streamGet: (url: string | URL, options: SafeHttpStreamGetOptions) => {
        calls.push(options);
        return inner.streamGet(url, options);
      },
    } as unknown as Pick<SafeHttpClient, 'streamGet'>;
    await runMpsvCzDiscovery(client, CONFIG, { now: () => NOW });
    expect(calls.length).toBe(10);
    for (const options of calls) {
      expect(options.allowedOrigins).toEqual(['https://data.mpsv.cz']);
      expect(options.maxResponseBytes).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeGreaterThan(0);
    }
  });
});

describe('MPSV retention and identity', () => {
  function rows(count: number, build: (index: number) => Record<string, unknown>): Snapshot {
    const base = day1().polozky[0];
    if (base === undefined) throw new Error('fixture missing');
    return { polozky: Array.from({ length: count }, (_, index) => ({ ...base, ...build(index) })) };
  }

  it('keeps the newest rows regardless of file order', async () => {
    const make = (order: number[]) =>
      rows(order.length, (index) => ({
        portalId: 100 + (order[index] ?? 0),
        datumZmeny: `2026-09-${String(10 + (order[index] ?? 0)).padStart(2, '0')}T08:00:00`,
        pozadovanaProfese: { cs: `Role ${order[index]}` },
        expirace: null,
      }));
    const run = async (order: number[]) =>
      (
        await runMpsvCzDiscovery(fakeClient(jsonRoute(make(order))).client, CONFIG, {
          now: () => NOW,
          maxRetainedRecords: 3,
        })
      ).vacancies.map((row) => row.key);
    const expected = ['mpsv_cz:107', 'mpsv_cz:108', 'mpsv_cz:109'];
    expect(await run([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual(expected);
    expect(await run([9, 3, 5, 0, 8, 1, 7, 2, 6, 4])).toEqual(expected);
  });

  it('keeps the version with the later datumZmeny for a duplicate portalId', async () => {
    const snapshot = rows(2, (index) => ({
      portalId: 555,
      datumZmeny: index === 0 ? '2026-09-30T08:00:00' : '2026-09-01T08:00:00',
      pozadovanaProfese: { cs: index === 0 ? 'Newer title' : 'Older title' },
      expirace: null,
    }));
    const run = await runMpsvCzDiscovery(fakeClient(jsonRoute(snapshot)).client, CONFIG, { now: () => NOW });
    expect(run.vacancies.map((row) => row.title)).toEqual(['Newer title']);
    snapshot.polozky.reverse();
    const reversed = await runMpsvCzDiscovery(fakeClient(jsonRoute(snapshot)).client, CONFIG, { now: () => NOW });
    expect(reversed.vacancies.map((row) => row.title)).toEqual(['Newer title']);
  });

  it('keeps same-title, same-obec rows and undisclosed-employer rows separate through uniqueDiscovery', async () => {
    const snapshot = rows(4, (index) => ({
      portalId: 800 + index,
      pozadovanaProfese: { cs: 'Skladník' },
      zverejnovat: { id: index < 2 ? 'ZverejnovatVpm/ano' : 'ZverejnovatVpm/anosp' },
      urlAdresa: null,
      expirace: null,
    }));
    const run = await runMpsvCzDiscovery(fakeClient(jsonRoute(snapshot)).client, CONFIG, { now: () => NOW });
    expect(run.vacancies).toHaveLength(4);
    expect(uniqueDiscovery(run.vacancies).map((row) => row.key).sort()).toEqual([
      'mpsv_cz:800',
      'mpsv_cz:801',
      'mpsv_cz:802',
      'mpsv_cz:803',
    ]);
  });

  it('does not let a shared employer URL merge different vacancies', async () => {
    const snapshot = rows(2, (index) => ({
      portalId: 900 + index,
      pozadovanaProfese: { cs: `Role ${index}` },
      urlAdresa: 'https://firma.cz/volna-mista',
      expirace: null,
    }));
    const run = await runMpsvCzDiscovery(fakeClient(jsonRoute(snapshot)).client, CONFIG, { now: () => NOW });
    expect(run.vacancies.every((row) => row.url === 'https://firma.cz/volna-mista')).toBe(true);
    const merged = uniqueDiscovery(run.vacancies);
    expect(merged.map((row) => row.key).sort()).toEqual(['mpsv_cz:900', 'mpsv_cz:901']);
    expect(merged.every((row) => row.applyUrl?.status === 'unresolved')).toBe(true);
  });
});

describe('MPSV registry entry', () => {
  it('is an active full_ingestion source with provider mpsv_cz', () => {
    const profile = globalRemoteConfigSchema.parse(
      JSON.parse(readFileSync(path.resolve(process.cwd(), 'config/global-remote-profile-v1.json'), 'utf8')),
    );
    const entry = globalRemoteSourceRegistry(profile).find((item) => item.id === 'mpsv_cz');
    expect(entry).toMatchObject({
      provider: 'mpsv_cz',
      state: 'active',
      ingestionMode: 'full_ingestion',
    });
    expect(entry?.url).toBe(MPSV_CZ_DATASET_PAGE_URL);
  });
});
