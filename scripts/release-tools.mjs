#!/usr/bin/env node
// Release tooling used by .github/workflows/release.yml (see docs/release-checklist.md).
//
// Every function here is pure or touches only the paths it is given, so
// scripts/release-tools.test.mjs can exercise each one deterministically without a network, a
// git remote or a real installer. Node built-ins only: the release job must not depend on the
// workspace install to verify what it is about to publish.
//
//   identity          Check the release identity of the checked-out commit: the root and desktop
//                     versions agree, are SemVer, have release notes, and (for a tag) match the
//                     tag. Writes version/tag/notes/installer/asset names to GITHUB_OUTPUT.
//   checksum-write    Stage the installer under its GitHub asset name and write a
//                     `sha256sum -c` compatible <asset>.sha256 next to it.
//   checksum-verify   Re-hash a staged installer and check its .sha256 file, name and version.
//   notes             Write the release notes with a provenance footer (tag, commit, run, hash).

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCT_NAME = 'Open Vacancy Radar';

// SemVer 2.0.0 core plus optional pre-release and build metadata, without a leading "v".
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isSemver(version) {
  return typeof version === 'string' && SEMVER.test(version);
}

/** True when the version carries a SemVer pre-release part (e.g. 0.1.5-rc.1). */
export function isPrerelease(version) {
  const match = SEMVER.exec(version);
  return Boolean(match && match[4]);
}

/** The file name electron-builder produces (apps/desktop/electron-builder.yml `artifactName`). */
export function installerFileName(version) {
  return `${PRODUCT_NAME}-Setup-${version}.exe`;
}

/**
 * The name GitHub gives the uploaded installer. GitHub replaces spaces in asset names with dots,
 * so v0.1.4 was served as `Open.Vacancy.Radar-Setup-0.1.4.exe` while its .sha256 named the
 * spaced file and could not be checked after download. Staging under this name up front keeps the
 * public asset name unchanged and makes the checksum line match the downloaded file.
 */
export function assetFileName(version) {
  return installerFileName(version).replace(/ /g, '.');
}

export function notesRelativePath(version) {
  return `docs/release-notes-v${version}.md`;
}

function readVersion(repoRoot, relativePath) {
  const file = path.join(repoRoot, relativePath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${relativePath}: ${error.message}`, { cause: error });
  }
  return parsed.version;
}

/**
 * Resolve and check the release identity of a checkout.
 *
 * @param {{ repoRoot: string, tag?: string }} options `tag` is the pushed tag name for a tag
 *   build, or empty/undefined for a dry run (pull request or manual dispatch).
 * @returns {{ version: string, tag: string, notesPath: string, installerName: string,
 *   assetName: string, prerelease: boolean }}
 */
export function resolveReleaseIdentity({ repoRoot, tag }) {
  const errors = [];
  const rootVersion = readVersion(repoRoot, 'package.json');
  const desktopVersion = readVersion(repoRoot, 'apps/desktop/package.json');

  if (!isSemver(rootVersion)) errors.push(`package.json version "${rootVersion}" is not SemVer.`);
  if (!isSemver(desktopVersion)) {
    errors.push(`apps/desktop/package.json version "${desktopVersion}" is not SemVer.`);
  }
  if (rootVersion !== desktopVersion) {
    errors.push(
      `package.json (${rootVersion}) and apps/desktop/package.json (${desktopVersion}) must have the same version; the installer name comes from apps/desktop.`,
    );
  }

  const version = rootVersion;
  const expectedTag = `v${version}`;
  if (tag && tag !== expectedTag) {
    errors.push(`Tag "${tag}" does not match the committed version; expected "${expectedTag}".`);
  }

  const notesPath = notesRelativePath(version);
  const notesFile = path.join(repoRoot, notesPath);
  if (!existsSync(notesFile)) {
    errors.push(`Missing ${notesPath}; docs/release-checklist.md step 1 requires release notes.`);
  } else {
    const firstLine = readFileSync(notesFile, 'utf8').split(/\r?\n/, 1)[0];
    if (firstLine !== `# Release notes: ${expectedTag}`) {
      errors.push(`${notesPath} must start with "# Release notes: ${expectedTag}".`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return {
    version,
    tag: expectedTag,
    notesPath,
    installerName: installerFileName(version),
    assetName: assetFileName(version),
    prerelease: isPrerelease(version),
  };
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** `sha256sum` text-mode line: lowercase hex, two spaces, file name, LF. */
export function checksumLine(hash, fileName) {
  return `${hash.toLowerCase()}  ${fileName}\n`;
}

/**
 * Copy the built installer into `outDir` under the GitHub asset name and write its checksum file.
 * @returns {{ assetPath: string, checksumPath: string, hash: string }}
 */
export function writeChecksum({ installerPath, version, outDir }) {
  const expectedName = installerFileName(version);
  if (path.basename(installerPath) !== expectedName) {
    throw new Error(`Installer "${path.basename(installerPath)}" is not "${expectedName}".`);
  }
  mkdirSync(outDir, { recursive: true });
  const assetName = assetFileName(version);
  const assetPath = path.join(outDir, assetName);
  copyFileSync(installerPath, assetPath);
  const hash = sha256File(assetPath);
  const checksumPath = `${assetPath}.sha256`;
  writeFileSync(checksumPath, checksumLine(hash, assetName), { encoding: 'ascii' });
  return { assetPath, checksumPath, hash };
}

/**
 * Check that `dir` holds exactly the installer for `version` and a matching checksum file.
 * @returns {{ assetPath: string, checksumPath: string, hash: string }}
 */
export function verifyChecksum({ dir, version }) {
  const assetName = assetFileName(version);
  const checksumName = `${assetName}.sha256`;
  const entries = readdirSync(dir).sort();
  const expected = [assetName, checksumName].sort();
  if (entries.length !== 2 || entries[0] !== expected[0] || entries[1] !== expected[1]) {
    throw new Error(
      `Expected exactly ${expected.join(' and ')} in ${dir}; found ${entries.join(', ') || 'nothing'}.`,
    );
  }
  const assetPath = path.join(dir, assetName);
  const checksumPath = path.join(dir, checksumName);
  const content = readFileSync(checksumPath, 'ascii');
  const match = /^([0-9a-f]{64}) {2}([^\r\n]+)\n$/.exec(content);
  if (!match) {
    throw new Error(`${checksumName} is not a single "<sha256>  <file>" line ending in LF.`);
  }
  if (match[2] !== assetName) {
    throw new Error(`${checksumName} names "${match[2]}", not "${assetName}".`);
  }
  const hash = sha256File(assetPath);
  if (hash !== match[1]) {
    throw new Error(`${assetName} hashes to ${hash}, but ${checksumName} records ${match[1]}.`);
  }
  return { assetPath, checksumPath, hash };
}

/** Release notes as committed, followed by a provenance footer binding the assets to the commit. */
export function renderReleaseNotes({ notes, tag, commit, runUrl, assetName, hash }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Commit "${commit}" is not a full SHA-1.`);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Hash "${hash}" is not a SHA-256.`);
  const body = notes.replace(/\s+$/, '');
  return [
    body,
    '',
    '## Build provenance',
    '',
    `- Tag: \`${tag}\``,
    `- Built from commit: \`${commit}\``,
    `- Workflow run: ${runUrl}`,
    `- \`${assetName}\` SHA-256: \`${hash}\``,
    '',
    `Verify after download: \`sha256sum -c ${assetName}.sha256\`, or in PowerShell`,
    `\`(Get-FileHash .\\${assetName} -Algorithm SHA256).Hash\` and compare it with the value above.`,
    '',
  ].join('\n');
}

function writeOutputs(outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}".`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
    flags[arg.slice(2)] = value;
    i += 1;
  }
  return flags;
}

function required(flags, name) {
  if (!flags[name]) throw new Error(`--${name} is required.`);
  return flags[name];
}

export function main(argv) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  const repoRoot = flags['repo-root'] ?? process.cwd();

  switch (command) {
    case 'identity': {
      const identity = resolveReleaseIdentity({ repoRoot, tag: flags.tag ?? '' });
      writeOutputs({
        version: identity.version,
        tag: identity.tag,
        notes_path: identity.notesPath,
        installer_name: identity.installerName,
        asset_name: identity.assetName,
        prerelease: String(identity.prerelease),
      });
      return;
    }
    case 'checksum-write': {
      const result = writeChecksum({
        installerPath: required(flags, 'installer'),
        version: required(flags, 'version'),
        outDir: required(flags, 'out-dir'),
      });
      writeOutputs({
        asset_path: result.assetPath,
        checksum_path: result.checksumPath,
        sha256: result.hash,
      });
      return;
    }
    case 'checksum-verify': {
      const result = verifyChecksum({
        dir: required(flags, 'dir'),
        version: required(flags, 'version'),
      });
      writeOutputs({
        asset_path: result.assetPath,
        checksum_path: result.checksumPath,
        sha256: result.hash,
      });
      return;
    }
    case 'notes': {
      const rendered = renderReleaseNotes({
        notes: readFileSync(path.join(repoRoot, required(flags, 'notes')), 'utf8'),
        tag: required(flags, 'tag'),
        commit: required(flags, 'commit'),
        runUrl: required(flags, 'run-url'),
        assetName: required(flags, 'asset-name'),
        hash: required(flags, 'sha256'),
      });
      writeFileSync(required(flags, 'out'), rendered, 'utf8');
      return;
    }
    default:
      throw new Error(
        `Unknown command "${command ?? ''}". Use identity, checksum-write, checksum-verify or notes.`,
      );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
