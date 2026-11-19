import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in for the `claude` CLI, for e2e runs that need the AI steps to answer (#756/#757).
 *
 * It is a small `node` script in the same spirit as `packages/agent-runtime/test/fixtures/
 * fake-claude-success.mjs`: it speaks the CLI's I/O shape (`--version`, `auth status --json`, and
 * `-p ... --output-format stream-json` with the prompt on stdin) and answers each kind of prompt this
 * app sends with fixed synthetic JSON. It never contacts anything, never reads the real CLI's state,
 * and recognises prompts by the opening sentence each prompt builder writes. Everything it returns
 * describes one fictional candidate; the CV text in `FAKE_CV_TEXT` is the matching source.
 */
export const FAKE_CV_FILE = 'jamie-rivera-cv.txt';
export const FAKE_CV_TEXT = [
  'Jamie Rivera',
  'Frontend Developer, Utrecht, Netherlands',
  'jamie@example.invalid',
  '',
  'SUMMARY',
  'Frontend developer who builds accessible React applications.',
  '',
  'EXPERIENCE',
  'Frontend Developer, Redwood Software, Jan 2019 - Dec 2023',
  '- Built the booking UI in React and TypeScript.',
  '',
  'EDUCATION',
  'BSc Software Engineering, Hogeschool Utrecht, 2015 - 2019',
  '',
  'SKILLS',
  'React, TypeScript, Playwright',
  '',
  'LANGUAGES',
  'Dutch (native), English (C1)',
].join('\n');
export const FAKE_SKILLS = ['React', 'TypeScript', 'Playwright'];
export const FAKE_LANGUAGES = 'Dutch (native), English (C1)';

const SOURCE = {
  contact: { name: 'Jamie Rivera', title: 'Frontend Developer', location: 'Utrecht, Netherlands', email: 'jamie@example.invalid', phone: '', links: [] },
  summary: 'Frontend developer who builds accessible React applications.',
  experience: [
    { company: 'Redwood Software', title: 'Frontend Developer', dates: 'Jan 2019 - Dec 2023', engagement: 'employment', client: '', bullets: ['Built the booking UI in React and TypeScript.'] },
  ],
  education: [{ institution: 'Hogeschool Utrecht', credential: 'BSc Software Engineering', dates: '2015 - 2019' }],
  projects: [],
};

const PROFILE = {
  title: 'Frontend Developer',
  years: '5 years',
  location: 'Utrecht, Netherlands',
  languages: FAKE_LANGUAGES,
  skills: FAKE_SKILLS,
  summary: SOURCE.summary,
  auth: '',
};

const SEARCH_PROFILE = {
  currentRole: 'Frontend Developer',
  experienceYears: 5,
  location: 'Utrecht, Netherlands',
  professionalLanguage: 'Dutch, English',
  strongestSkills: FAKE_SKILLS,
  additionalSkills: [],
  targetRoles: ['Frontend Developer'],
  consideredRoles: [],
  primaryCountry: 'Netherlands',
};

const TAILORED = {
  contact: SOURCE.contact,
  summary: SOURCE.summary,
  experience: SOURCE.experience,
  projects: [],
  skills: ['TypeScript', 'React', 'Playwright'],
  education: SOURCE.education,
};

function script(logPath: string | null): string {
  return `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const answers = ${JSON.stringify({ SOURCE, PROFILE, SEARCH_PROFILE, TAILORED })};
const args = process.argv.slice(2);
const log = (line) => { ${logPath ? `appendFileSync(${JSON.stringify(logPath)}, line + '\\n');` : ''} };
log('args ' + JSON.stringify(args));
if (args[0] === '--version') { process.stdout.write('2.1.228 (Claude Code)\\n'); process.exit(0); }
if (args[0] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: true }) + '\\n'); process.exit(0); }
const sessionId = args[args.indexOf('--session-id') + 1] || 'fake-session';
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  log('prompt ' + prompt.slice(0, 160).replace(/\\n/gu, ' '));
  let answer;
  if (prompt.includes("extract one candidate's complete CV into structured records")) answer = answers.SOURCE;
  else if (prompt.includes('"targetRoles"')) answer = answers.SEARCH_PROFILE;
  else if (prompt.includes("extract structured fields from one candidate's CV text")) answer = answers.PROFILE;
  else if (prompt.includes('Tailor one candidate CV for one vacancy')) answer = answers.TAILORED;
  else if (prompt.includes('Select the reviewed CV facts')) {
    const start = prompt.indexOf('=== SOURCE FACTS ===');
    const line = prompt.slice(start).split('\\n')[1] || '[]';
    const facts = JSON.parse(line);
    answer = { factIds: facts.map((fact) => fact.id).filter((id) => !id.startsWith('company')).slice(0, 3) };
  } else answer = {};
  const text = JSON.stringify(answer);
  const lines = [
    { type: 'system', subtype: 'init', session_id: sessionId },
    { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 }, session_id: sessionId },
  ];
  process.stdout.write(lines.map((line) => JSON.stringify(line)).join('\\n') + '\\n');
});
`;
}

/** Writes the stand-in into a fresh directory and returns that directory, to be put first on PATH. */
export async function installFakeClaude(options: { logPath?: string } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ovr-fake-claude-'));
  const scriptPath = join(dir, 'fake-claude.mjs');
  await writeFile(scriptPath, script(options.logPath ?? null), 'utf8');
  // A shell wrapper so the daemon's PATH lookup finds a plain \`claude\` and the script runs under the
  // same node this test runner uses, whatever PATH the child process ends up with.
  // The two detection probes are answered by the shell itself: detection runs them with short
  // timeouts, and a node start-up on a loaded CI machine must never make the stand-in look absent.
  const wrapper = join(dir, 'claude');
  await writeFile(
    wrapper,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  --version) echo "2.1.228 (Claude Code)"; exit 0 ;;',
      '  auth) echo \'{"loggedIn":true}\'; exit 0 ;;',
      'esac',
      `exec "${process.execPath}" "${scriptPath}" "$@"`,
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(wrapper, 0o755);
  await chmod(scriptPath, 0o755);
  if (options.logPath) {
    // Debug aid: record every PATH lookup the daemon performs while this directory is first on PATH.
    const which = join(dir, 'which');
    await writeFile(
      which,
      [
        '#!/bin/sh',
        `log=${JSON.stringify(options.logPath)}`,
        'start=$(date +%s.%N)',
        'out=$(/usr/bin/which "$@" 2>&1); code=$?',
        'end=$(date +%s.%N)',
        'printf \'which %s -> code=%s out=%s start=%s end=%s\\n\' "$*" "$code" "$out" "$start" "$end" >> "$log"',
        'printf \'%s\\n\' "$out"',
        'exit $code',
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(which, 0o755);
  }
  return dir;
}
