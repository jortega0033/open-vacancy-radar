#!/usr/bin/env node
// Fetches the Visual C++ 2015-2022 x64 redistributable into the NSIS build-resources folder so
// electron-builder can bundle it into the installer (see assets/app-icons/installer.nsh, which
// runs it silently during install if the runtime isn't already present). Native N-API addons in
// this app (better-sqlite3, the daemon's OS-credential-store binding) fail to load without it on
// a machine that never had another VC++-dependent app installed -- see issue #62.
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEST_DIR = path.join(__dirname, '..', 'assets', 'app-icons');
const DEST_PATH = path.join(DEST_DIR, 'vc_redist.x64.exe');
const TEMP_PATH = `${DEST_PATH}.download`;

// Microsoft's own permanent redirect for the latest VC++ 2015-2022 x64 redistributable -- the
// same link Microsoft's own install docs point to, and what most third-party installers that
// bundle it (game launchers included) use. Always the current release, never a version-pinned
// build, since Microsoft does not publish stable URLs for older point releases.
const SOURCE_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

// The real installer is ~25 MB. Anything drastically smaller is almost certainly an HTML error
// page saved with a .exe name (a broken redirect, a captive portal, a 404), not a binary worth
// silently shipping inside the NSIS installer.
const MINIMUM_PLAUSIBLE_BYTES = 5_000_000;

async function main() {
  if (existsSync(DEST_PATH)) {
    console.log(`vc_redist.x64.exe already present at ${DEST_PATH}, skipping download.`);
    return;
  }

  mkdirSync(DEST_DIR, { recursive: true });
  console.log(`Downloading Visual C++ Redistributable from ${SOURCE_URL} ...`);

  const response = await fetch(SOURCE_URL, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download vc_redist.x64.exe: HTTP ${response.status} ${response.statusText}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(TEMP_PATH));

  const { size } = statSync(TEMP_PATH);
  if (size < MINIMUM_PLAUSIBLE_BYTES) {
    unlinkSync(TEMP_PATH);
    throw new Error(`Downloaded vc_redist.x64.exe is suspiciously small (${size} bytes); aborting.`);
  }

  renameSync(TEMP_PATH, DEST_PATH);
  console.log(`Saved vc_redist.x64.exe (${(size / 1_000_000).toFixed(1)} MB) to ${DEST_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
