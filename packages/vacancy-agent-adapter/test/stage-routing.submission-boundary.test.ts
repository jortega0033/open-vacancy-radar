import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as stageRouting from '../src/stage-routing/index.js';
import { routeStage, recordStageRun, planNextAttempt } from '../src/index.js';
import { candidate } from './support/stage-candidates.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const stageRoutingDir = join(here, '..', 'src', 'stage-routing');

function stageRoutingSources(): { name: string; code: string }[] {
  return readdirSync(stageRoutingDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, code: readFileSync(join(stageRoutingDir, name), 'utf8') }));
}

/** Strips block and line comments so a prose mention of "submit" in a doc comment is not mistaken
 * for a submit-shaped API. The rule is about what this code can *do*, not about what it discusses. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function packageJson(relativePath: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(repoRoot, relativePath, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

/**
 * **Acceptance check 6 of issue #284**: submission authorization and the actual "send this
 * application" decision stay completely outside LLM routing.
 *
 * These are structural assertions rather than behavioral ones, deliberately. A test that called the
 * router and observed that nothing was submitted would prove only that today's code path happens
 * not to reach a submit. What has to hold is stronger: this package must have no way to reach one,
 * and must grow no API a caller could mistake for consent to send. So the checks are on the
 * dependency graph and on the exported surface, and they fail the build when either drifts --
 * including when the drift is a well-meant convenience added by someone who did not read #284.
 *
 * The submit decision's real home is `packages/application-executor`: `resolveSubmitControl`'s
 * refuse-unless-exactly-one-candidate rule and the executor's handoff path. Neither is reachable
 * from here, in either direction.
 */
describe('the stage router cannot authorize or trigger a submission (acceptance check 6)', () => {
  it('has no dependency on the application executor, and the executor has none on it', () => {
    const adapter = packageJson('packages/vacancy-agent-adapter');
    const executor = packageJson('packages/application-executor');
    const adapterDeps = { ...adapter.dependencies, ...adapter.devDependencies };
    const executorDeps = { ...executor.dependencies, ...executor.devDependencies };
    expect(Object.keys(adapterDeps)).not.toContain('@agent-dock/application-executor');
    expect(Object.keys(executorDeps)).not.toContain('@agent-dock/vacancy-agent-adapter');
  });

  it('imports nothing from the application executor or the agent runtime', () => {
    for (const { name, code } of stageRoutingSources()) {
      const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of imports) {
        expect(specifier, `${name} imports ${specifier}`).not.toContain('application-executor');
        // Also the layering rule from CONTRIBUTING.md: dependencies flow shared -> agent-runtime,
        // and this package sits beside agent-runtime rather than above it.
        expect(specifier, `${name} imports ${specifier}`).not.toContain('agent-runtime');
      }
    }
  });

  it('exports no symbol whose name could be read as approving or sending anything', () => {
    const submitShaped = /^(submit|send|approve|authorize|authorise|confirm|dispatch|apply)/i;
    const offenders = Object.keys(stageRouting).filter((name) => submitShaped.test(name));
    expect(offenders).toEqual([]);
  });

  it('declares no submit-shaped identifier anywhere in its own source', () => {
    // Prose in a doc comment is fine and expected -- this file's own header explains the boundary.
    // A declared function, const, class or interface is not.
    const declaration = /\b(function|const|let|var|class|interface|type|enum)\s+([A-Za-z0-9_$]*(?:submit|authoriz|authoris|approv|sendApplication)[A-Za-z0-9_$]*)/i;
    for (const { name, code } of stageRoutingSources()) {
      const match = declaration.exec(withoutComments(code));
      expect(match?.[2] ?? null, `${name} declares ${match?.[2] ?? ''}`).toBeNull();
    }
  });

  it('returns a decision carrying no field that could gate a side effect', () => {
    const decision = routeStage({
      stage: 'application_field_map',
      candidates: [candidate({ providerId: 'claude', model: 'sonnet' })],
    });
    if (decision.outcome !== 'routed') throw new Error('expected a routed decision');
    // The complete, closed shape: a pairing, a label, a price and a paper trail. Nothing a caller
    // could branch on to decide whether an application may be sent.
    expect(Object.keys(decision).sort()).toEqual(
      ['model', 'outcome', 'price', 'providerId', 'rejected', 'stage', 'tier', 'tierEvidence'].sort(),
    );
  });

  it('routes only stages that draft or extract: no stage in the table performs a submission', () => {
    for (const contract of Object.values(stageRouting.STAGE_CONTRACTS)) {
      expect(['bounded_extraction', 'grounded_document', 'closed_set_assignment']).toContain(contract.workload);
    }
  });

  it('produces records and escalation plans with no consent-shaped outcome', () => {
    const record = recordStageRun({
      stage: 'application_field_map',
      providerId: 'claude',
      model: 'sonnet',
      tier: 'capable',
      tierEvidence: 'operator_declared',
      attempt: 1,
      outcome: 'validated',
      startedAt: 0,
      finishedAt: 10,
      usage: { kind: 'unavailable', reason: 'provider_reported_none' },
      price: { kind: 'unknown', reason: 'not_published' },
    });
    // `validated` is a statement about the answer's shape, never about whether it may be acted on.
    expect(record.outcome).toBe('validated');
    expect(Object.keys(record)).not.toContain('authorized');

    const plan = planNextAttempt(
      {
        stage: 'application_field_map',
        attemptsMade: 1,
        currentTier: 'capable',
        capableTierAvailable: true,
        retrievalAttempted: false,
      },
      { kind: 'schema_invalid' },
    );
    // The only "escape" from routing is a handoff *to the user*: the router can stop, and it can ask
    // a person, and it has no third option that proceeds on its own authority.
    expect(['retry_same_model', 'escalate_tier', 'retrieve_missing_facts', 'hand_off_to_user']).toContain(plan.action);
  });
});
