// Deterministic tests for scripts/release-tools.mjs. Run with `node --test scripts/`.
// release.yml runs them before every dry run and every tag build. Temp directories only: no
// network, no git remote, no real installer.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  artifactName,
  assetFileName,
  checksumLine,
  installerFileName,
  isPrerelease,
  isSemver,
  main,
  renderReleaseNotes,
  resolveReleaseIdentity,
  verifyChecksum,
  writeChecksum,
} from './release-tools.mjs';

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ovr-release-tools-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function fakeRepo({ rootVersion = '0.1.5', desktopVersion = rootVersion, notes = 'default' } = {}) {
  const repo = tempDir();
  mkdirSync(path.join(repo, 'apps/desktop'), { recursive: true });
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'agent-dock', version: rootVersion }),
  );
  writeFileSync(
    path.join(repo, 'apps/desktop/package.json'),
    JSON.stringify({ name: '@agent-dock/desktop', version: desktopVersion }),
  );
  if (notes !== null) {
    const text =
      notes === 'default' ? `# Release notes: v${rootVersion}\n\nWindows x64 release.\n` : notes;
    writeFileSync(path.join(repo, `docs/release-notes-v${rootVersion}.md`), text);
  }
  return repo;
}

describe('version helpers', () => {
  it('accepts SemVer and rejects tag-style or partial versions', () => {
    assert.equal(isSemver('0.1.5'), true);
    assert.equal(isSemver('1.0.0-rc.1+build.7'), true);
    assert.equal(isSemver('v0.1.5'), false);
    assert.equal(isSemver('0.1'), false);
    assert.equal(isSemver('01.1.5'), false);
    assert.equal(isSemver(undefined), false);
  });

  it('detects a pre-release part only', () => {
    assert.equal(isPrerelease('0.1.5'), false);
    assert.equal(isPrerelease('0.1.5+build.1'), false);
    assert.equal(isPrerelease('0.1.5-rc.1'), true);
  });

  it('names the installer like electron-builder and the asset like GitHub', () => {
    assert.equal(installerFileName('0.1.5'), 'Open Vacancy Radar-Setup-0.1.5.exe');
    // The published v0.1.4 asset is literally named Open.Vacancy.Radar-Setup-0.1.4.exe.
    assert.equal(assetFileName('0.1.4'), 'Open.Vacancy.Radar-Setup-0.1.4.exe');
    assert.equal(assetFileName('0.1.5'), 'Open.Vacancy.Radar-Setup-0.1.5.exe');
  });
});

describe('resolveReleaseIdentity', () => {
  it('resolves a dry run and a matching tag', () => {
    const repo = fakeRepo();
    const expected = {
      version: '0.1.5',
      tag: 'v0.1.5',
      notesPath: 'docs/release-notes-v0.1.5.md',
      installerName: 'Open Vacancy Radar-Setup-0.1.5.exe',
      assetName: 'Open.Vacancy.Radar-Setup-0.1.5.exe',
      prerelease: false,
    };
    assert.deepEqual(resolveReleaseIdentity({ repoRoot: repo, tag: '' }), expected);
    assert.deepEqual(resolveReleaseIdentity({ repoRoot: repo, tag: 'v0.1.5' }), expected);
  });

  it('refuses a tag that does not match the committed version', () => {
    const repo = fakeRepo();
    assert.throws(
      () => resolveReleaseIdentity({ repoRoot: repo, tag: 'v0.1.4' }),
      /expected "v0\.1\.5"/,
    );
    assert.throws(
      () => resolveReleaseIdentity({ repoRoot: repo, tag: 'v0.1.6' }),
      /expected "v0\.1\.5"/,
    );
    assert.throws(
      () => resolveReleaseIdentity({ repoRoot: repo, tag: '0.1.5' }),
      /expected "v0\.1\.5"/,
    );
  });

  it('refuses diverging root and desktop versions', () => {
    const repo = fakeRepo({ rootVersion: '0.1.5', desktopVersion: '0.1.4' });
    assert.throws(() => resolveReleaseIdentity({ repoRoot: repo }), /must have the same version/);
  });

  it('refuses a non-SemVer version', () => {
    const repo = fakeRepo({ rootVersion: '0.1', desktopVersion: '0.1' });
    assert.throws(() => resolveReleaseIdentity({ repoRoot: repo }), /is not SemVer/);
  });

  it('requires release notes with the matching heading', () => {
    assert.throws(
      () => resolveReleaseIdentity({ repoRoot: fakeRepo({ notes: null }) }),
      /Missing docs\/release-notes-v0\.1\.5\.md/,
    );
    assert.throws(
      () => resolveReleaseIdentity({ repoRoot: fakeRepo({ notes: '# Release notes: v0.1.4\n' }) }),
      /must start with "# Release notes: v0\.1\.5"/,
    );
  });

  it('flags a pre-release version', () => {
    const repo = fakeRepo({ rootVersion: '0.1.5-rc.1' });
    assert.equal(resolveReleaseIdentity({ repoRoot: repo, tag: 'v0.1.5-rc.1' }).prerelease, true);
  });
});

describe('checksums', () => {
  function fakeInstaller(version = '0.1.5', bytes = 'not really an installer') {
    const dir = tempDir();
    const file = path.join(dir, installerFileName(version));
    writeFileSync(file, bytes);
    return { file, hash: createHash('sha256').update(bytes).digest('hex') };
  }

  it('writes a sha256sum-compatible line naming the GitHub asset', () => {
    const { file, hash } = fakeInstaller();
    const outDir = path.join(tempDir(), 'release-assets');
    const result = writeChecksum({ installerPath: file, version: '0.1.5', outDir });

    assert.equal(result.hash, hash);
    assert.deepEqual(readdirSync(outDir).sort(), [
      'Open.Vacancy.Radar-Setup-0.1.5.exe',
      'Open.Vacancy.Radar-Setup-0.1.5.exe.sha256',
    ]);
    const line = readFileSync(result.checksumPath, 'ascii');
    assert.equal(line, `${hash}  Open.Vacancy.Radar-Setup-0.1.5.exe\n`);
    assert.doesNotMatch(line, /\r/);
    assert.equal(checksumLine(hash.toUpperCase(), 'x.exe'), `${hash}  x.exe\n`);
  });

  it('refuses an installer whose name is not the expected version', () => {
    const { file } = fakeInstaller('0.1.4');
    assert.throws(
      () => writeChecksum({ installerPath: file, version: '0.1.5', outDir: tempDir() }),
      /is not "Open Vacancy Radar-Setup-0\.1\.5\.exe"/,
    );
  });

  it('verifies a round trip and rejects tampering, wrong names and extra files', () => {
    const { file, hash } = fakeInstaller();
    const outDir = path.join(tempDir(), 'release-assets');
    const { assetPath, checksumPath } = writeChecksum({
      installerPath: file,
      version: '0.1.5',
      outDir,
    });
    assert.equal(verifyChecksum({ dir: outDir, version: '0.1.5' }).hash, hash);

    assert.throws(() => verifyChecksum({ dir: outDir, version: '0.1.6' }), /Expected exactly/);

    writeFileSync(checksumPath, `${hash}  Open Vacancy Radar-Setup-0.1.5.exe\r\n`);
    assert.throws(
      () => verifyChecksum({ dir: outDir, version: '0.1.5' }),
      /single "<sha256> {2}<file>" line/,
    );

    writeFileSync(checksumPath, `${hash}  Open Vacancy Radar-Setup-0.1.5.exe\n`);
    assert.throws(
      () => verifyChecksum({ dir: outDir, version: '0.1.5' }),
      /names "Open Vacancy Radar-Setup-0\.1\.5\.exe"/,
    );

    writeFileSync(checksumPath, checksumLine(hash, 'Open.Vacancy.Radar-Setup-0.1.5.exe'));
    writeFileSync(assetPath, 'tampered');
    assert.throws(() => verifyChecksum({ dir: outDir, version: '0.1.5' }), /records/);

    writeFileSync(path.join(outDir, 'extra.txt'), 'x');
    assert.throws(() => verifyChecksum({ dir: outDir, version: '0.1.5' }), /found .*extra\.txt/);
  });
});

describe('renderReleaseNotes', () => {
  const commit = '1255010260d5252ce6c2ef81b6a4cac2450d9670';
  const hash = 'a'.repeat(64);

  it('appends provenance that binds the asset to the tag, commit and run', () => {
    const rendered = renderReleaseNotes({
      notes: '# Release notes: v0.1.5\n\nBody.\n\n\n',
      tag: 'v0.1.5',
      commit,
      runUrl: 'https://github.com/jortega0033/open-vacancy-radar/actions/runs/1',
      assetName: 'Open.Vacancy.Radar-Setup-0.1.5.exe',
      hash,
    });
    assert.ok(rendered.startsWith('# Release notes: v0.1.5\n\nBody.\n\n## Build provenance\n'));
    assert.match(rendered, new RegExp(`Built from commit: \`${commit}\``));
    assert.match(rendered, /Workflow run: https:\/\/github\.com\/.+\/actions\/runs\/1/);
    assert.match(
      rendered,
      new RegExp(`\`Open\\.Vacancy\\.Radar-Setup-0\\.1\\.5\\.exe\` SHA-256: \`${hash}\``),
    );
    assert.match(rendered, /sha256sum -c Open\.Vacancy\.Radar-Setup-0\.1\.5\.exe\.sha256/);
  });

  it('refuses an abbreviated commit or a malformed hash', () => {
    const base = { notes: 'x', tag: 'v0.1.5', runUrl: 'u', assetName: 'a.exe' };
    assert.throws(() => renderReleaseNotes({ ...base, commit: '1255010', hash }), /full SHA-1/);
    assert.throws(() => renderReleaseNotes({ ...base, commit, hash: 'abc' }), /not a SHA-256/);
  });
});

describe('artifactName', () => {
  const commit = '5f368cea30d29e1d36165b8aa1150007ef27d3f8';

  it('binds the artifact to the tag, run kind, full commit and run attempt', () => {
    assert.equal(
      artifactName({ tag: 'v0.1.5', kind: 'dry-run', commit, runAttempt: '1' }),
      `windows-installer-v0.1.5-dry-run-${commit}-attempt1`,
    );
    assert.equal(
      artifactName({ tag: 'v0.1.5', kind: 'release', commit, runAttempt: 2 }),
      `windows-installer-v0.1.5-release-${commit}-attempt2`,
    );
  });

  it('gives each run attempt its own name, so "Re-run all jobs" never re-uploads a name', () => {
    const names = ['1', '2', '3'].map((runAttempt) =>
      artifactName({ tag: 'v0.1.5', kind: 'release', commit, runAttempt }),
    );
    assert.equal(new Set(names).size, names.length);
  });

  it('refuses a bad tag, kind, commit or run attempt', () => {
    const base = { tag: 'v0.1.5', kind: 'release', commit, runAttempt: '1' };
    assert.throws(() => artifactName({ ...base, tag: '0.1.5' }), /not v<SemVer>/);
    assert.throws(() => artifactName({ ...base, tag: 'vnext' }), /not v<SemVer>/);
    assert.throws(() => artifactName({ ...base, kind: 'publish' }), /not one of release, dry-run/);
    assert.throws(() => artifactName({ ...base, commit: '5f368ce' }), /full SHA-1/);
    assert.throws(() => artifactName({ ...base, commit: undefined }), /full SHA-1/);
    assert.throws(() => artifactName({ ...base, runAttempt: '0' }), /positive integer/);
    assert.throws(() => artifactName({ ...base, runAttempt: '' }), /positive integer/);
    assert.throws(() => artifactName({ ...base, runAttempt: '1; rm' }), /positive integer/);
  });
});

describe('CLI', () => {
  it('writes identity outputs to GITHUB_OUTPUT', (t) => {
    const repo = fakeRepo();
    const output = path.join(tempDir(), 'github-output');
    writeFileSync(output, '');
    const previous = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = output;
    t.mock.method(console, 'log', () => {});
    try {
      main(['identity', '--repo-root', repo, '--tag', 'v0.1.5']);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = previous;
    }
    assert.equal(
      readFileSync(output, 'utf8'),
      [
        'version=0.1.5',
        'tag=v0.1.5',
        'notes_path=docs/release-notes-v0.1.5.md',
        'installer_name=Open Vacancy Radar-Setup-0.1.5.exe',
        'asset_name=Open.Vacancy.Radar-Setup-0.1.5.exe',
        'prerelease=false',
        '',
      ].join('\n'),
    );
  });

  it('writes the artifact name to GITHUB_OUTPUT', (t) => {
    const output = path.join(tempDir(), 'github-output');
    writeFileSync(output, '');
    const previous = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = output;
    t.mock.method(console, 'log', () => {});
    const commit = '5f368cea30d29e1d36165b8aa1150007ef27d3f8';
    try {
      main([
        'artifact-name',
        '--tag',
        'v0.1.5',
        '--kind',
        'dry-run',
        '--commit',
        commit,
        '--run-attempt',
        '3',
      ]);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = previous;
    }
    assert.equal(
      readFileSync(output, 'utf8'),
      `name=windows-installer-v0.1.5-dry-run-${commit}-attempt3
`,
    );
  });

  it('rejects unknown commands and missing flag values', () => {
    assert.throws(() => main(['publish']), /Unknown command "publish"/);
    assert.throws(() => main(['identity', '--tag']), /Missing value for --tag/);
    assert.throws(() => main(['checksum-verify', '--dir', tempDir()]), /--version is required/);
    assert.throws(
      () =>
        main(['artifact-name', '--tag', 'v0.1.5', '--kind', 'release', '--commit', 'a'.repeat(40)]),
      /--run-attempt is required/,
    );
  });
});
