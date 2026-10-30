// Structure tests for .github/workflows/release.yml. Run with `node --test scripts/`.
// release.yml runs them first, before installing anything, so they use Node built-ins only and a
// small indentation-based reader for the shapes this one workflow uses (not a general YAML parser).
//
// `checkReleaseWorkflow` lists every rule the workflow breaks. The committed file must break none,
// and each mutation test proves a rule actually fires: a weakened publish gate, a write token
// outside publish, a `gh release` call or upload in the read-only rehearsal, an unpinned action,
// a hand-off step that drifts from publish, or an artifact name without the run attempt.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOW_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows',
  'release.yml',
);
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');

const PUBLISH_IF = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";
const REHEARSAL_IF = "github.event_name != 'push'";
// The steps both downstream jobs run before the publish job's own `gh release` step.
const HANDOFF_STEPS = [
  'actions/checkout',
  'actions/setup-node',
  'Download the installer and checksum built above',
  'Re-verify the checksum',
  'Compose release notes with build provenance',
];

const indentOf = (line) => line.length - line.trimStart().length;
const isComment = (line) => line.trimStart().startsWith('#');
const meaningful = (lines) => lines.filter((line) => line.trim() !== '' && !isComment(line));

/** Lines of the block that starts after `lines[start]` and is indented deeper than it. */
function childBlock(lines, start) {
  const base = indentOf(lines[start]);
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== '' && !isComment(line) && indentOf(line) <= base) break;
    block.push(line);
  }
  return block;
}

/** `key: value` pairs at exactly `indent` spaces (values unquoted of one surrounding quote pair). */
function scalars(lines, indent) {
  const map = {};
  for (const line of lines) {
    if (indentOf(line) !== indent || isComment(line)) continue;
    const match = /^\s*([\w-]+):\s*(.*)$/.exec(line);
    if (match) map[match[1]] = match[2].replace(/^'(.*)'$/, '$1');
  }
  return map;
}

function stepsOf(jobLines) {
  const start = jobLines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
  if (start === -1) return [];
  const steps = [];
  for (const line of childBlock(jobLines, start)) {
    if (/^ {6}- /.test(line)) steps.push([line]);
    else if (steps.length > 0) steps[steps.length - 1].push(line);
  }
  return steps.map((raw) => {
    const lines = meaningful(raw);
    const first = /^ {6}- ([\w-]+):\s*(.*)$/.exec(lines[0]);
    const fields = { ...scalars(lines.slice(1), 8), [first[1]]: first[2] };
    const uses = fields.uses ?? '';
    return {
      name: fields.name ?? uses.replace(/@.*$/, ''),
      uses,
      if: fields.if,
      id: fields.id,
      text: lines.join('\n'),
    };
  });
}

export function parseReleaseWorkflow(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const top = (key) => lines.findIndex((line) => line === `${key}:`);
  const section = (key) => (top(key) === -1 ? [] : childBlock(lines, top(key)));
  const jobs = {};
  const jobLines = section('jobs');
  jobLines.forEach((line, index) => {
    const match = /^ {2}([\w-]+):\s*$/.exec(line);
    if (!match) return;
    const block = childBlock(jobLines, index);
    const permissionsAt = block.findIndex((l) => /^ {4}permissions:\s*$/.test(l));
    jobs[match[1]] = {
      header: scalars(block, 4),
      permissions: permissionsAt === -1 ? null : scalars(childBlock(block, permissionsAt), 6),
      text: meaningful(block).join('\n'),
      steps: stepsOf(block),
    };
  });
  return {
    on: meaningful(section('on')).join('\n'),
    permissions: scalars(section('permissions'), 2),
    jobs,
  };
}

/** Every rule release.yml breaks; empty when the publish gating and hand-off are intact. */
export function checkReleaseWorkflow(text) {
  const problems = [];
  const fail = (message) => problems.push(message);
  const wf = parseReleaseWorkflow(text);
  const { build, publish } = wf.jobs;
  const rehearsal = wf.jobs['rehearse-publish'];

  // Triggers: tag pushes publish; pull requests and manual dispatch are dry runs.
  if (!/^ {2}push:\n {4}tags:\n {6}- 'v\*'$/m.test(wf.on))
    fail('push must trigger on v* tags only');
  if (/^ {4}branches:/m.test(wf.on)) fail('push must not trigger on branches');
  if (!/^ {2}pull_request:$/m.test(wf.on)) fail('pull_request dry run trigger missing');
  if (!/^ {2}workflow_dispatch:/m.test(wf.on)) fail('workflow_dispatch dry run trigger missing');
  if (/pull_request_target|workflow_run/.test(wf.on)) fail('privileged triggers are not allowed');
  for (const file of ['scripts/release-tools.test.mjs', 'scripts/release-workflow.test.mjs']) {
    if (!wf.on.includes(`- '${file}'`)) fail(`pull_request paths must include ${file}`);
  }

  // Permissions: read-only by default; only publish may write.
  if (JSON.stringify(wf.permissions) !== JSON.stringify({ contents: 'read' })) {
    fail('workflow permissions must be exactly contents: read');
  }
  const jobIds = Object.keys(wf.jobs).sort().join(',');
  if (jobIds !== 'build,publish,rehearse-publish') fail(`unexpected job set ${jobIds}`);
  if (!build || !publish || !rehearsal) return problems;

  if (build.permissions !== null) fail('build must inherit the read-only workflow permissions');
  if (JSON.stringify(rehearsal.permissions) !== JSON.stringify({ contents: 'read' })) {
    fail('rehearse-publish permissions must be exactly contents: read');
  }
  const publishPermissions = { ...publish.permissions };
  if (publishPermissions.contents)
    publishPermissions.contents = publishPermissions.contents.replace(/\s+#.*$/, '');
  if (JSON.stringify(publishPermissions) !== JSON.stringify({ contents: 'write' })) {
    fail('publish permissions must be exactly contents: write');
  }
  for (const [id, job] of Object.entries(wf.jobs)) {
    if (id !== 'publish' && /:\s*write\b/.test(job.text))
      fail(`${id} must not request a write permission`);
  }

  // Gating: publish only for a pushed v* tag; the rehearsal only when nothing is being published.
  if (publish.header.if !== PUBLISH_IF) fail('publish must run only for a pushed v* tag');
  if (publish.header.needs !== 'build') fail('publish must need build');
  if (rehearsal.header.if !== REHEARSAL_IF) fail('rehearse-publish must run only for dry runs');
  if (rehearsal.header.needs !== 'build') fail('rehearse-publish must need build');

  // Mutation is tag-only: gh release, a token for gh, and secrets live in publish alone.
  for (const [id, job] of Object.entries(wf.jobs)) {
    if (/\bsecrets\./.test(job.text)) fail(`${id} must not use repository secrets`);
    if (id === 'publish') continue;
    if (/\bgh\s+release\b/.test(job.text)) fail(`${id} must not call gh release`);
    if (/GH_TOKEN|GITHUB_TOKEN|github\.token/.test(job.text)) fail(`${id} must not get a token`);
  }
  const publishStep = publish.steps.find((step) => step.name === 'Publish GitHub Release');
  if (!publishStep) fail('publish must have its Publish GitHub Release step');
  else {
    if (!publishStep.text.includes('--verify-tag')) fail('gh release create must use --verify-tag');
    if (!publishStep.text.includes('"$RELEASE_TAG" != "$GITHUB_REF_NAME"')) {
      fail('publish must refuse a build identity that differs from the pushed tag');
    }
  }

  // Uploads: only the build job uploads, and only run artifacts.
  for (const [id, job] of Object.entries(wf.jobs)) {
    for (const step of job.steps) {
      if (step.uses.startsWith('actions/upload-artifact@') && id !== 'build') {
        fail(`${id} must not upload anything`);
      }
    }
  }

  // Every action pinned to a full commit SHA with its version as a comment.
  for (const [id, job] of Object.entries(wf.jobs)) {
    for (const step of job.steps) {
      if (step.uses && !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+(\.\d+){0,2}$/.test(step.uses)) {
        fail(`${id}: action "${step.uses}" is not pinned to a full SHA with a version comment`);
      }
      if (
        step.uses.startsWith('actions/checkout@') &&
        !/persist-credentials: false/.test(step.text)
      ) {
        fail(`${id}: checkout must set persist-credentials: false`);
      }
    }
  }

  // Build: the gates that make the artifact trustworthy stay in place.
  const buildStep = (name) => build.steps.find((step) => step.name === name);
  const toolTests = buildStep('Release tooling tests');
  const install = build.steps.findIndex((step) => step.name === 'Install dependencies');
  if (
    !toolTests ||
    !toolTests.text.includes('scripts/release-tools.test.mjs scripts/release-workflow.test.mjs') ||
    build.steps.indexOf(toolTests) > install
  ) {
    fail('build must run both release test files before installing dependencies');
  }
  const ancestry = buildStep('Verify the tagged commit is on master');
  if (
    !ancestry ||
    ancestry.if !== "github.event_name == 'push'" ||
    !ancestry.text.includes('merge-base --is-ancestor')
  ) {
    fail('build must check that a pushed tag is on origin/master');
  }
  for (const [name, needle] of [
    ['Verify release identity', 'release-tools.mjs'],
    ['Electron end-to-end tests', 'test:e2e'],
    ['Verify installer was produced', '$env:INSTALLER_NAME'],
    ['Packaged app smoke (unpacked output)', 'packaged-smoke.mjs dist-packages/win-unpacked'],
    ['Packaged installer lifecycle smoke (silent NSIS)', 'packaged-smoke.mjs --installer'],
    ['Compute SHA-256', 'checksum-verify'],
  ]) {
    const step = buildStep(name);
    if (!step || !step.text.includes(needle) || step.if)
      fail(`build step "${name}" missing or conditional`);
  }
  const naming = buildStep('Name the installer artifact');
  if (
    !naming ||
    naming.id !== 'artifact' ||
    !naming.text.includes('release-tools.mjs artifact-name') ||
    !naming.text.includes('--run-attempt "$env:GITHUB_RUN_ATTEMPT"') ||
    !naming.text.includes('--commit "$env:GITHUB_SHA"')
  ) {
    fail('the artifact name must come from release-tools artifact-name with the run attempt');
  }
  if (!/^ {6}artifact: \$\{\{ steps\.artifact\.outputs\.name \}\}$/m.test(build.text)) {
    fail('build must export the exact artifact name as outputs.artifact');
  }
  const upload = build.steps.find((step) => step.name === 'Upload installer and checksum');
  if (!upload || !upload.text.includes('name: ${{ steps.artifact.outputs.name }}')) {
    fail('build must upload under the exported artifact name');
  }

  // Hand-off: the rehearsal runs the publish job's own steps, in order and byte for byte.
  for (const [id, job] of [
    ['publish', publish],
    ['rehearse-publish', rehearsal],
  ]) {
    const names = job.steps.slice(0, HANDOFF_STEPS.length).map((step) => step.name);
    if (JSON.stringify(names) !== JSON.stringify(HANDOFF_STEPS)) {
      fail(`${id} must start with the hand-off steps ${HANDOFF_STEPS.join(' / ')}`);
    }
    const download = job.steps.find((step) => step.uses.startsWith('actions/download-artifact@'));
    if (!download || !download.text.includes('name: ${{ needs.build.outputs.artifact }}')) {
      fail(`${id} must download exactly needs.build.outputs.artifact`);
    } else if (/run-id:|github-token:|pattern:|merge-multiple:/.test(download.text)) {
      fail(`${id} must download only this run's artifact by its exact name`);
    }
  }
  HANDOFF_STEPS.forEach((name, index) => {
    if (publish.steps[index]?.text !== rehearsal.steps[index]?.text) {
      fail(`hand-off step "${name}" differs between publish and rehearse-publish`);
    }
  });
  if (rehearsal.steps.length !== HANDOFF_STEPS.length + 1) {
    fail('rehearse-publish must add only its notes check after the hand-off steps');
  }

  return problems;
}

describe('release.yml structure', () => {
  it('keeps publish gating, permissions, pins and the read-only hand-off rehearsal', () => {
    assert.deepEqual(checkReleaseWorkflow(WORKFLOW), []);
  });

  it('reads the three jobs and their hand-off steps', () => {
    const wf = parseReleaseWorkflow(WORKFLOW);
    assert.deepEqual(Object.keys(wf.jobs), ['build', 'rehearse-publish', 'publish']);
    assert.deepEqual(
      wf.jobs['rehearse-publish'].steps.map((step) => step.name),
      [...HANDOFF_STEPS, 'Check the rehearsed release notes'],
    );
    assert.equal(wf.jobs.publish.steps.at(-1).name, 'Publish GitHub Release');
  });
});

describe('release.yml structure checks fire on regressions', () => {
  // Each mutation must be applied exactly once, so a stale needle cannot pass silently.
  function mutate(from, to) {
    const parts = WORKFLOW.split(from);
    assert.equal(parts.length, 2, `mutation needle must occur exactly once: ${from}`);
    return parts.join(to);
  }
  function rehearsalBlock() {
    const start = WORKFLOW.indexOf('  rehearse-publish:\n');
    return WORKFLOW.slice(start, WORKFLOW.indexOf('  publish:\n'));
  }
  const expectProblem = (text, pattern) =>
    assert.ok(
      checkReleaseWorkflow(text).some((problem) => pattern.test(problem)),
      `expected a problem matching ${pattern}; got ${JSON.stringify(checkReleaseWorkflow(text))}`,
    );

  it('a publish gate that also runs on pull requests', () => {
    expectProblem(
      mutate(`if: ${PUBLISH_IF}`, "if: github.event_name != 'schedule'"),
      /publish must run only for a pushed v\* tag/,
    );
  });

  it('a rehearsal that also runs on tag pushes', () => {
    expectProblem(
      mutate(`if: ${REHEARSAL_IF}`, 'if: always()'),
      /rehearse-publish must run only for dry runs/,
    );
  });

  it('a write token outside publish', () => {
    const block = rehearsalBlock();
    const text = WORKFLOW.replace(
      block,
      block.replace('      contents: read\n', '      contents: write\n'),
    );
    expectProblem(text, /rehearse-publish permissions must be exactly contents: read/);
    expectProblem(
      mutate('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n'),
      /workflow permissions/,
    );
  });

  it('a gh release call, token or upload in the rehearsal', () => {
    const block = rehearsalBlock();
    const tail = '          echo "Hand-off rehearsal passed';
    const withGh = block.replace(tail, `          gh release view "$GITHUB_REF_NAME"\n${tail}`);
    expectProblem(WORKFLOW.replace(block, withGh), /rehearse-publish must not call gh release/);
    const withToken = block.replace(
      '          BUILD_SHA256: ${{ needs.build.outputs.sha256 }}\n        run: |\n          set -euo pipefail\n          notes=',
      '          BUILD_SHA256: ${{ needs.build.outputs.sha256 }}\n          GH_TOKEN: ${{ github.token }}\n        run: |\n          set -euo pipefail\n          notes=',
    );
    assert.notEqual(withToken, block);
    expectProblem(WORKFLOW.replace(block, withToken), /rehearse-publish must not get a token/);
    const withUpload = `${block}      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1\n        with:\n          name: leak\n          path: release-assets/\n\n`;
    expectProblem(WORKFLOW.replace(block, withUpload), /rehearse-publish must not upload anything/);
  });

  it('an action pinned to a tag instead of a commit SHA', () => {
    const text = WORKFLOW.replace(
      'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2',
      'actions/download-artifact@v8',
    );
    expectProblem(text, /"actions\/download-artifact@v8" is not pinned/);
  });

  it('a hand-off step that drifts from publish', () => {
    const block = rehearsalBlock();
    const drifted = block.replace(
      '          (cd release-assets && sha256sum -c -- *.sha256)\n',
      '',
    );
    assert.notEqual(drifted, block);
    expectProblem(WORKFLOW.replace(block, drifted), /"Re-verify the checksum" differs/);
  });

  it('a download that could pick up another run or a guessed name', () => {
    const block = rehearsalBlock();
    const otherRun = block.replace(
      '          path: release-assets\n',
      '          path: release-assets\n          run-id: 1\n',
    );
    expectProblem(
      WORKFLOW.replace(block, otherRun),
      /rehearse-publish must download only this run's artifact/,
    );
  });

  it('an artifact name without the run attempt', () => {
    expectProblem(
      mutate(' --run-attempt "$env:GITHUB_RUN_ATTEMPT"', ''),
      /artifact name must come from release-tools artifact-name with the run attempt/,
    );
  });

  it('a skipped smoke test or ancestry check', () => {
    expectProblem(
      mutate(
        '      - name: Packaged installer lifecycle smoke (silent NSIS)\n',
        '      - name: Packaged installer lifecycle smoke (silent NSIS)\n        if: false\n',
      ),
      /Packaged installer lifecycle smoke \(silent NSIS\)" missing or conditional/,
    );
    expectProblem(
      mutate('git merge-base --is-ancestor', 'git merge-base'),
      /pushed tag is on origin\/master/,
    );
  });

  it('a publish step without --verify-tag', () => {
    expectProblem(mutate('"${assets[@]}" --verify-tag', '"${assets[@]}"'), /--verify-tag/);
  });
});
