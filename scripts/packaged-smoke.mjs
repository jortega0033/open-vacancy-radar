// Release-gate smoke for the unpacked Windows build (issue #127).
//
// Run after `pnpm package:win`:  node scripts/packaged-smoke.mjs [path-to-win-unpacked]
//
// It checks the real `dist-packages/win-unpacked` output, not the source tree:
//   1. every file the packaged app resolves at runtime is present (daemon bundle, JobHost,
//      vacancy-engine migrations and config, icons, the better-sqlite3 native binding, workspace
//      migrations inside app.asar);
//   2. electron-builder.yml still carries the app identity, installer naming, icon and VC++ NSIS
//      include;
//   3. better-sqlite3 loads inside the packaged Electron runtime;
//   4. the packaged daemon answers /health with protocol v1 and v2 on a loopback port, accepts
//      cancel-all, can be stopped, and leaves no JobHost process behind;
//   5. with `--installer <Setup.exe>` (CI only): silent NSIS install, the same smoke against the
//      installed app, silent uninstall, user data kept.
//
// The pure checks are exported and unit tested (apps/daemon/test/packaged-smoke.test.mjs). The
// process-level steps (3, 4) only run when this file is executed directly, on Windows.
//
// No shebang, for the same reason scripts/preflight.mjs has none: Vite/esbuild chokes on one when a
// test imports this file as a module.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const EXE_NAME = 'Open Vacancy Radar.exe';
export const JOB_HOST_NAME = 'agent-dock-job-host.exe';

/** Files that must exist under win-unpacked, as forward-slash relative paths. */
export const REQUIRED_UNPACKED_FILES = Object.freeze([
  EXE_NAME,
  'resources/app.asar',
  'resources/daemon/index.js',
  `resources/daemon/${JOB_HOST_NAME}`,
  'resources/assets/app-icons/png/icon-256.png',
  'resources/assets/app-icons/png/icon-32.png',
  'resources/vacancy-engine/drizzle/meta/_journal.json',
  'resources/vacancy-engine/config/candidate-profile-v1.json',
  'resources/vacancy-engine/config/company-domain-candidates-v1.json',
  'resources/vacancy-engine/config/global-remote-profile-v1.json',
]);

/**
 * better-sqlite3 binding locations under app.asar.unpacked. electron-rebuild (the desktop
 * postinstall) produces build/Release; prebuilds/win32-x64.node is the node-gyp-build fallback.
 * At least one must be unpacked; the runtime load check below proves it actually works.
 */
export const BETTER_SQLITE_BINDINGS = Object.freeze([
  'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node',
]);

/** Entries that must exist inside resources/app.asar (forward-slash, no leading slash). */
export const REQUIRED_ASAR_ENTRIES = Object.freeze([
  'package.json',
  'dist/index.html',
  'dist-electron/main.js',
  'dist-electron/preload.js',
  'dist-electron/drizzle/meta/_journal.json',
  'node_modules/better-sqlite3/package.json',
]);

/** Returns the members of `required` that are not in `present` (a Set or any iterable). */
export function findMissing(present, required) {
  const have = present instanceof Set ? present : new Set(present);
  return required.filter((entry) => !have.has(entry));
}

/** Normalizes Windows separators so one list works on any host. */
export function toPosix(relativePath) {
  return relativePath.split('\\').join('/');
}

/**
 * Lists every file path inside an Electron asar archive from its header alone.
 * Layout: u32 pickle-size(4), u32 header-pickle-size, u32 payload-size, u32 json-length, then JSON.
 */
export function parseAsarEntries(buffer) {
  if (buffer.length < 16) throw new Error('asar archive is too small to contain a header');
  const jsonLength = buffer.readUInt32LE(12);
  const json = buffer.subarray(16, 16 + jsonLength).toString('utf8');
  const header = JSON.parse(json);
  const entries = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, path);
      else entries.push(path);
    }
  };
  walk(header, '');
  return entries;
}

/** Every workspace migration SQL file in source must also be inside the asar, or migrate() fails. */
export function findMissingMigrations(sourceFileNames, asarEntries, folder) {
  const have = new Set(asarEntries);
  return sourceFileNames
    .filter((name) => name.endsWith('.sql'))
    .map((name) => `${folder}/${name}`)
    .filter((entry) => !have.has(entry));
}

/**
 * Identity, icon, naming and VC++ checks against electron-builder.yml. A line-oriented match, not a
 * YAML parser: the file is flat enough, and the repo has no YAML dependency.
 */
export function checkBuilderConfig(yaml, installerNsh) {
  const problems = [];
  const expectLine = (pattern, label) => {
    if (!pattern.test(yaml)) problems.push(`electron-builder.yml: ${label} is missing or changed`);
  };
  expectLine(/^appId:\s*dev\.agentdock\.desktop\s*$/m, 'appId dev.agentdock.desktop');
  expectLine(/^productName:\s*Open Vacancy Radar\s*$/m, 'productName "Open Vacancy Radar"');
  expectLine(/^\s+executableName:\s*Open Vacancy Radar\s*$/m, 'win.executableName');
  expectLine(/^\s+icon:\s*open-vacancy-radar\.ico\s*$/m, 'win.icon open-vacancy-radar.ico');
  expectLine(
    /^\s+artifactName:\s*"\$\{productName\}-Setup-\$\{version\}\.\$\{ext\}"\s*$/m,
    'nsis.artifactName "${productName}-Setup-${version}.${ext}"',
  );
  expectLine(/^\s+include:\s*installer\.nsh\s*$/m, 'nsis.include installer.nsh (VC++ redistributable)');
  expectLine(/^\s+to:\s*daemon\s*$/m, 'extraResources daemon entry');
  expectLine(/^\s+to:\s*vacancy-engine\/drizzle\s*$/m, 'extraResources vacancy-engine/drizzle entry');
  expectLine(/^\s+to:\s*vacancy-engine\/config\s*$/m, 'extraResources vacancy-engine/config entry');
  if (installerNsh !== undefined) {
    if (!/!macro customInstall/.test(installerNsh) || !/vc_redist\.x64\.exe/.test(installerNsh)) {
      problems.push('installer.nsh: no customInstall macro that runs vc_redist.x64.exe');
    }
  }
  return problems;
}

/** Validates a /health body from the packaged daemon: v1 stays frozen, v2 is advertised. */
export function checkHealthBody(body) {
  const problems = [];
  if (!body || typeof body !== 'object') return ['health response is not an object'];
  if (body.status !== 'ok') problems.push(`health status is ${JSON.stringify(body.status)}, expected "ok"`);
  if (body.protocolVersion !== 1) problems.push(`protocolVersion is ${JSON.stringify(body.protocolVersion)}, expected 1`);
  const supported = Array.isArray(body.supportedProtocolVersions) ? body.supportedProtocolVersions : [];
  if (!supported.includes(1)) problems.push('supportedProtocolVersions does not include 1');
  if (!supported.includes(2)) problems.push('supportedProtocolVersions does not include 2 (v2 routes not mounted)');
  if (typeof body.daemonInstanceId !== 'string' || body.daemonInstanceId.length === 0) {
    problems.push('daemonInstanceId is missing');
  }
  return problems;
}

/** True when a `tasklist /FO CSV /NH` listing contains the given image name. */
export function tasklistHasImage(csv, imageName) {
  const wanted = imageName.toLowerCase();
  return csv
    .split(/\r?\n/)
    .some((line) => line.replace(/^"/, '').split('","')[0]?.toLowerCase() === wanted);
}

function listFilesRecursive(root, base = root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base));
    else out.push(toPosix(full.slice(base.length + 1)));
  }
  return out;
}

function fail(problems) {
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  process.exitCode = 1;
}

function runStatic(unpacked) {
  const problems = [];
  const present = new Set(listFilesRecursive(unpacked));
  for (const missing of findMissing(present, REQUIRED_UNPACKED_FILES)) {
    problems.push(`missing from win-unpacked: ${missing}`);
  }

  if (BETTER_SQLITE_BINDINGS.every((binding) => !present.has(binding))) {
    problems.push(`no better-sqlite3 native binding unpacked (looked for: ${BETTER_SQLITE_BINDINGS.join(', ')})`);
  }

  const engineSource = readdirSync(join(repoRoot, 'packages/vacancy-engine/drizzle'));
  for (const missing of findMissingMigrations(engineSource, present, 'resources/vacancy-engine/drizzle')) {
    problems.push(`vacancy-engine migration not packaged: ${missing}`);
  }

  const asarPath = join(unpacked, 'resources', 'app.asar');
  if (existsSync(asarPath)) {
    const entries = parseAsarEntries(readFileSync(asarPath));
    for (const missing of findMissing(entries, REQUIRED_ASAR_ENTRIES)) {
      problems.push(`missing from app.asar: ${missing}`);
    }
    const workspaceSource = readdirSync(join(repoRoot, 'apps/desktop/electron/workspace/drizzle'));
    for (const missing of findMissingMigrations(workspaceSource, entries, 'dist-electron/drizzle')) {
      problems.push(`workspace migration not packaged in app.asar: ${missing}`);
    }
  }

  const yaml = readFileSync(join(repoRoot, 'apps/desktop/electron-builder.yml'), 'utf8');
  const nsh = readFileSync(join(repoRoot, 'apps/desktop/assets/app-icons/installer.nsh'), 'utf8');
  problems.push(...checkBuilderConfig(yaml, nsh));

  const jobHost = join(unpacked, 'resources', 'daemon', JOB_HOST_NAME);
  if (existsSync(jobHost) && statSync(jobHost).size < 1024) problems.push(`${JOB_HOST_NAME} is suspiciously small`);
  return problems;
}

function runElectronAsNode(exe, args, env) {
  return spawnSync(exe, args, {
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
}

function checkBetterSqlite(unpacked) {
  const exe = join(unpacked, EXE_NAME);
  const moduleDir = join(unpacked, 'resources', 'app.asar', 'node_modules', 'better-sqlite3');
  const code =
    "const D=require(process.env.OVR_SMOKE_MODULE);const db=new D(':memory:');" +
    "console.log('sqlite '+db.prepare('select sqlite_version() as v').get().v);db.close();";
  const result = runElectronAsNode(exe, ['-e', code], { OVR_SMOKE_MODULE: moduleDir });
  if (result.status !== 0 || !/^sqlite \d/m.test(result.stdout ?? '')) {
    return [`better-sqlite3 did not load in the packaged runtime: ${(result.stderr || result.stdout || String(result.error)).trim().slice(0, 600)}`];
  }
  console.log(`ok    better-sqlite3 loaded in packaged runtime (${result.stdout.trim()})`);
  return [];
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function checkPackagedDaemon(unpacked) {
  const problems = [];
  const exe = join(unpacked, EXE_NAME);
  const entry = join(unpacked, 'resources', 'daemon', 'index.js');
  const appId = `ovr-packaged-smoke-${process.pid}`;
  const stateDir = mkdtempSync(join(tmpdir(), 'ovr-smoke-state-'));
  const discovery = join(tmpdir(), 'agent-dock', `${appId}.json`);
  let output = '';
  const child = spawn(exe, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_DOCK_APP_ID: appId,
      AGENT_DOCK_STATE_DIR: stateDir,
      AGENT_DOCK_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));

  try {
    const info = await waitFor(() => (existsSync(discovery) ? JSON.parse(readFileSync(discovery, 'utf8')) : undefined), 30_000, 'daemon discovery file');
    if (info.pid !== child.pid) problems.push(`discovery file pid ${info.pid} is not the spawned daemon pid ${child.pid}`);
    const base = `http://127.0.0.1:${info.port}`;
    const health = await (await fetch(`${base}/health`)).json();
    problems.push(...checkHealthBody(health));
    if (problems.length === 0) console.log(`ok    packaged daemon health: protocol ${health.protocolVersion}, supported ${JSON.stringify(health.supportedProtocolVersions)}`);

    const cancel = await fetch(`${base}/sessions/cancel-all`, { method: 'POST', headers: { authorization: `Bearer ${info.token}` } });
    if (cancel.status !== 202) problems.push(`POST /sessions/cancel-all returned ${cancel.status}, expected 202`);
    else console.log('ok    packaged daemon accepted cancel-all (202)');

    if (!existsSync(join(stateDir, 'sessions-v1'))) problems.push('durable state directory sessions-v1 was not created');
  } catch (error) {
    problems.push(`packaged daemon smoke failed: ${error instanceof Error ? error.message : error}\n--- daemon output ---\n${output.slice(-1500)}`);
  } finally {
    // Windows has no graceful signal: kill() is TerminateProcess, so the daemon's own SIGTERM
    // handler never runs here (same reason Electron's killDaemon cancels over HTTP first).
    child.kill();
    const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 30_000))]);
    if (result === 'timeout') problems.push('daemon process did not exit within 30s of being stopped');
    try { rmSync(discovery, { force: true }); } catch { /* best effort */ }
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const listing = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  if (listing.status === 0 && tasklistHasImage(listing.stdout, JOB_HOST_NAME)) {
    problems.push(`${JOB_HOST_NAME} is still running after the daemon stopped`);
  }
  return problems;
}

/** NSIS silent switches. /D must be the last argument and must not be quoted, even with spaces. */
export function nsisInstallArgs(installDir) {
  return ['/S', `/D=${installDir}`];
}

/** `_?=dir` makes the NSIS uninstaller run in place and wait, instead of copying itself to %TEMP% and returning. */
export function nsisUninstallArgs(installDir) {
  return ['/S', `_?=${installDir}`];
}

function runNsis(exe, args, label) {
  // windowsVerbatimArguments keeps `/D=C:\path with spaces` unquoted, as NSIS requires.
  const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 300_000, windowsHide: true, windowsVerbatimArguments: true });
  if (result.error || result.status !== 0) {
    return `${label} failed (exit ${result.status}): ${String(result.error ?? result.stderr ?? '').slice(0, 400)}`;
  }
  return undefined;
}

/**
 * Silent NSIS lifecycle: install into a temp directory, smoke the INSTALLED app with the same
 * checks as the unpacked output, uninstall silently, and confirm the app goes away while the user
 * data directory (a sentinel file) stays. It registers and removes the per-user uninstall entry of
 * the real app id, so it only runs on CI or with OVR_SMOKE_ALLOW_INSTALL=1.
 */
async function runInstallerLifecycle(installerPath) {
  if (process.platform !== 'win32') return ['installer lifecycle smoke is Windows only'];
  if (process.env.CI !== 'true' && process.env.OVR_SMOKE_ALLOW_INSTALL !== '1') {
    return ['refusing to install: it touches the per-user uninstall entry of the real app id. Set OVR_SMOKE_ALLOW_INSTALL=1 on a disposable machine.'];
  }
  const installRoot = mkdtempSync(join(tmpdir(), 'ovr-smoke-install-'));
  const installDir = join(installRoot, 'Open Vacancy Radar');
  const userData = join(process.env.APPDATA ?? '', 'Open Vacancy Radar');
  const sentinel = join(userData, 'ovr-installer-smoke-sentinel.txt');
  const problems = [];
  mkdirSync(userData, { recursive: true });
  writeFileSync(sentinel, 'must survive uninstall');
  try {
    const installError = runNsis(installerPath, nsisInstallArgs(installDir), 'silent install');
    if (installError) return [installError];
    if (!existsSync(join(installDir, EXE_NAME))) return [`installed executable missing at ${installDir}`];
    console.log('ok    silent NSIS install produced the executable');
    const installed = [...runStatic(installDir), ...checkBetterSqlite(installDir), ...(await checkPackagedDaemon(installDir))];
    problems.push(...installed.map((p) => `installed app: ${p}`));
    if (installed.length === 0) console.log('ok    installed app passes the same smoke as the unpacked output');
    const uninstaller = join(installDir, 'Uninstall Open Vacancy Radar.exe');
    if (!existsSync(uninstaller)) return [...problems, `uninstaller missing at ${uninstaller}`];
    const uninstallError = runNsis(uninstaller, nsisUninstallArgs(installDir), 'silent uninstall');
    if (uninstallError) problems.push(uninstallError);
    if (existsSync(join(installDir, EXE_NAME))) problems.push('uninstall left the executable behind');
    if (!existsSync(sentinel)) problems.push('uninstall removed the user data directory');
    else console.log('ok    silent uninstall removed the app and kept user data');
  } finally {
    try { rmSync(sentinel, { force: true }); } catch { /* best effort */ }
    try { rmSync(installRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return problems;
}

export async function main(argv = process.argv.slice(2)) {
  const installerFlag = argv.indexOf('--installer');
  if (installerFlag !== -1) {
    const installer = argv[installerFlag + 1];
    if (!installer || !existsSync(installer)) return fail([`--installer needs an existing Setup .exe, got ${installer}`]);
    const lifecycleProblems = await runInstallerLifecycle(resolve(installer));
    if (lifecycleProblems.length > 0) return fail(lifecycleProblems);
    console.log('Installer lifecycle smoke passed.');
    return;
  }
  const unpacked = resolve(argv[0] ?? join(repoRoot, 'dist-packages', 'win-unpacked'));
  if (!existsSync(unpacked)) {
    fail([`win-unpacked directory not found: ${unpacked}. Run pnpm package:win first.`]);
    return;
  }
  const staticProblems = runStatic(unpacked);
  if (staticProblems.length > 0) return fail(staticProblems);
  console.log('ok    unpacked layout, migrations, builder config and VC++ include');

  if (process.platform !== 'win32') {
    console.log('skip  process checks (better-sqlite3, daemon health): Windows only');
    return;
  }
  const processProblems = [...checkBetterSqlite(unpacked), ...(await checkPackagedDaemon(unpacked))];
  if (processProblems.length > 0) return fail(processProblems);
  console.log('Packaged smoke passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
