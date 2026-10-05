import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BETTER_SQLITE_BINDINGS,
  REQUIRED_ASAR_ENTRIES,
  REQUIRED_UNPACKED_FILES,
  checkBuilderConfig,
  checkHealthBody,
  findMissing,
  findMissingMigrations,
  nsisInstallArgs,
  nsisUninstallArgs,
  parseAsarEntries,
  tasklistHasImage,
  toPosix,
} from '../../../scripts/packaged-smoke.mjs';

const repoFile = (relative) => readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');

/** Builds a minimal asar buffer (header only is enough for parseAsarEntries). */
function asarFrom(tree) {
  const json = Buffer.from(JSON.stringify({ files: tree }), 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(json.length + 8, 4);
  head.writeUInt32LE(json.length + 4, 8);
  head.writeUInt32LE(json.length, 12);
  return Buffer.concat([head, json]);
}

describe('findMissing', () => {
  it('reports only the required entries that are absent', () => {
    expect(findMissing(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
    expect(findMissing(new Set(REQUIRED_UNPACKED_FILES), REQUIRED_UNPACKED_FILES)).toEqual([]);
  });

  it('requires the JobHost under the packaged daemon resources', () => {
    expect(REQUIRED_UNPACKED_FILES).toContain('resources/daemon/agent-dock-job-host.exe');
    expect(findMissing(REQUIRED_UNPACKED_FILES.filter((f) => !f.endsWith('job-host.exe')), REQUIRED_UNPACKED_FILES)).toEqual([
      'resources/daemon/agent-dock-job-host.exe',
    ]);
  });
});

describe('better-sqlite3 binding locations', () => {
  it('accepts either the electron-rebuild or the prebuilt binding, both unpacked from the asar', () => {
    expect(BETTER_SQLITE_BINDINGS).toHaveLength(2);
    expect(BETTER_SQLITE_BINDINGS.every((p) => p.startsWith('resources/app.asar.unpacked/'))).toBe(true);
  });
});

describe('toPosix', () => {
  it('converts Windows separators', () => {
    expect(toPosix('resources\\daemon\\index.js')).toBe('resources/daemon/index.js');
  });
});

describe('parseAsarEntries', () => {
  it('flattens nested directories into file paths', () => {
    const buffer = asarFrom({
      'package.json': { size: 1, offset: '0' },
      'dist-electron': { files: { 'main.js': { size: 1, offset: '1' }, drizzle: { files: { '0000_a.sql': { size: 1, offset: '2' } } } } },
    });
    expect(parseAsarEntries(buffer).sort()).toEqual(['dist-electron/drizzle/0000_a.sql', 'dist-electron/main.js', 'package.json']);
  });

  it('rejects a truncated archive', () => {
    expect(() => parseAsarEntries(Buffer.alloc(4))).toThrow();
  });

  it('lists the asar entries the smoke requires as plain strings', () => {
    expect(REQUIRED_ASAR_ENTRIES.every((entry) => !entry.startsWith('/'))).toBe(true);
  });
});

describe('findMissingMigrations', () => {
  it('flags a SQL file that exists in source but not in the package', () => {
    expect(findMissingMigrations(['0000_a.sql', '0001_b.sql', 'meta'], ['dist-electron/drizzle/0000_a.sql'], 'dist-electron/drizzle')).toEqual([
      'dist-electron/drizzle/0001_b.sql',
    ]);
  });
});

describe('checkBuilderConfig against the real config', () => {
  const yaml = repoFile('apps/desktop/electron-builder.yml');
  const nsh = repoFile('apps/desktop/assets/app-icons/installer.nsh');

  it('passes for the committed electron-builder.yml and installer.nsh', () => {
    expect(checkBuilderConfig(yaml, nsh)).toEqual([]);
  });

  it('flags a removed VC++ include', () => {
    const problems = checkBuilderConfig(yaml.replace(/^\s+include:\s*installer\.nsh\s*$/m, ''), nsh);
    expect(problems.join('\n')).toMatch(/installer\.nsh/);
  });

  it('flags a changed product name and a hook without the redistributable', () => {
    expect(checkBuilderConfig(yaml.replace('productName: Open Vacancy Radar', 'productName: Other'), nsh).join('\n')).toMatch(/productName/);
    expect(checkBuilderConfig(yaml, '; empty').join('\n')).toMatch(/customInstall/);
  });
});

describe('checkHealthBody', () => {
  const good = { status: 'ok', protocolVersion: 1, supportedProtocolVersions: [1, 2], daemonInstanceId: 'abc' };

  it('accepts a v1+v2 daemon', () => {
    expect(checkHealthBody(good)).toEqual([]);
  });

  it('rejects a v1-only (downgraded) daemon', () => {
    expect(checkHealthBody({ ...good, supportedProtocolVersions: [1] }).join('\n')).toMatch(/does not include 2/);
  });

  it('rejects a changed v1 protocol version and a bad body', () => {
    expect(checkHealthBody({ ...good, protocolVersion: 2 }).join('\n')).toMatch(/protocolVersion/);
    expect(checkHealthBody(null)).toHaveLength(1);
  });
});

describe('tasklistHasImage', () => {
  const csv = '"System","4","Services","0","148 K"\r\n"agent-dock-job-host.exe","1234","Console","1","3,000 K"\r\n';

  it('matches the exact image name case-insensitively', () => {
    expect(tasklistHasImage(csv, 'Agent-Dock-Job-Host.exe')).toBe(true);
    expect(tasklistHasImage(csv, 'node.exe')).toBe(false);
  });
});

describe('NSIS silent switches', () => {
  it('keeps /D last and unquoted, and runs the uninstaller in place', () => {
    expect(nsisInstallArgs('C:\Temp\a b')).toEqual(['/S', '/D=C:\Temp\a b']);
    expect(nsisUninstallArgs('C:\Temp\a b')).toEqual(['/S', '_?=C:\Temp\a b']);
  });
});
