// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import {
  extractSnapshotFields,
  validateFieldMap,
  type CdpDomNode,
  type FormSnapshot,
} from '@agent-dock/application-executor';
import { mapBlindApplyAnswers } from '../electron/blind-apply-answers.js';
import { buildApplicationValueTable } from '../electron/application-value-table.js';
import { FIXTURE_FORM_URLS, FIXTURE_REVIEW_POLICY } from '../electron/application-target-policies.js';
import { blindAnswerKey, optionSetHashOf } from '../electron/workspace/blind-apply-store.js';
import type { ApplicationArtifactRecord } from '../electron/workspace/types.js';

/**
 * The contract between the Blind Apply fixture pages and the deterministic mapper (#722), checked with
 * the REAL DOM extractor and the REAL Domain B validator. The page is parsed from the actual fixture
 * HTML, converted to the CDP node shape the extractor reads, and snapshotted exactly as a live review
 * would -- so a fixture whose labels drifted from what the exact-label rules expect fails here, not in a
 * browser. (The Chromium-rendered half of this is `e2e/blind-apply.spec.ts`.)
 */

function fixtureHtml(url: string): string {
  return readFileSync(fileURLToPath(url), 'utf8');
}

let nextNodeId = 1;
type DomNode = Parameters<typeof cheerio.load>[0] extends never ? never : { type: string; name?: string; attribs?: Record<string, string>; children?: DomNode[]; data?: string };

function toCdp(node: DomNode): CdpDomNode | null {
  if (node.type === 'text') return { nodeName: '#text', nodeType: 3, backendNodeId: nextNodeId++, nodeValue: node.data ?? '' };
  if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') return null;
  const attributes = Object.entries(node.attribs ?? {}).flat();
  const children = (node.children ?? []).map(toCdp).filter((child): child is CdpDomNode => child !== null);
  return { nodeName: (node.name ?? '').toUpperCase(), nodeType: 1, backendNodeId: nextNodeId++, attributes, children };
}

function snapshotOfFixture(url: string): FormSnapshot {
  const $ = cheerio.load(fixtureHtml(url));
  const root = $.root().get(0) as unknown as DomNode;
  const tree: CdpDomNode = {
    nodeName: '#document',
    nodeType: 9,
    backendNodeId: nextNodeId++,
    children: (root.children ?? []).map(toCdp).filter((child): child is CdpDomNode => child !== null),
  };
  const extracted = extractSnapshotFields(tree);
  return {
    generation: 1,
    fields: extracted.fields,
    submitControls: extracted.submitControls,
    capturedAt: '2026-11-04T10:00:00.000Z',
    challengeDetected: extracted.challengeDetected,
    activeFrameId: extracted.dominantFrameId,
    pageStateFingerprint: 'fp',
  };
}

const ATTEMPT_ID = randomUUID();
const CV_ARTIFACT = { id: randomUUID(), kind: 'cv_pdf' } as ApplicationArtifactRecord;
const VALUE_TABLE = buildApplicationValueTable({
  cvContact: { name: 'Ada Synthetic', title: 'Frontend Engineer', location: 'Lisbon', email: 'ada@example.invalid', phone: '+351000000', links: [] },
  profile: null,
});

function run(snapshot: FormSnapshot, saved: Record<string, string> = {}) {
  const mapping = mapBlindApplyAnswers({
    attemptId: ATTEMPT_ID,
    snapshot,
    valueTable: VALUE_TABLE,
    artifacts: [CV_ARTIFACT],
    findSavedAnswer: (key) => (saved[key] ? { id: 'saved-1', answer: saved[key] } : null),
  });
  const validation = validateFieldMap({
    raw: mapping.fieldMap,
    attemptId: ATTEMPT_ID,
    snapshot,
    valueTable: mapping.valueTable.map((entry) => ({ valueRef: entry.valueRef, value: entry.value, provenance: entry.provenance })),
    ownedArtifactIds: [CV_ARTIFACT.id],
  });
  return { mapping, validation };
}

describe('the fixtures are local, registered and test-only', () => {
  it('each Blind Apply fixture exists and is pinned by exact path, never by origin', () => {
    for (const url of [FIXTURE_FORM_URLS.blindSupported, FIXTURE_FORM_URLS.blindMissingAnswer, FIXTURE_FORM_URLS.blindCaptcha]) {
      expect(url.startsWith('file://')).toBe(true);
      expect(existsSync(fileURLToPath(url))).toBe(true);
      expect(FIXTURE_REVIEW_POLICY.exactFileUrls).toContain(url);
    }
    expect(FIXTURE_REVIEW_POLICY.origins).toEqual([]);
  });

  it('no fixture loads a script from, or posts to, the network', () => {
    for (const url of [FIXTURE_FORM_URLS.blindSupported, FIXTURE_FORM_URLS.blindMissingAnswer, FIXTURE_FORM_URLS.blindCaptcha]) {
      const html = fixtureHtml(url);
      expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
      expect(html).not.toMatch(/\baction=/i);
      expect(html).not.toMatch(/https?:\/\//i);
    }
  });
});

describe('the supported fixture', () => {
  const snapshot = snapshotOfFixture(FIXTURE_FORM_URLS.blindSupported);
  const arrangement = snapshot.fields.find((field) => field.label.startsWith('Preferred work arrangement'));

  it('is read by the real extractor into the labels the exact-label rules expect', () => {
    expect(snapshot.challengeDetected).toBe(false);
    expect(snapshot.submitControls).toHaveLength(1);
    expect(snapshot.fields.map((field) => field.label.replace(/\s*\*\s*$/u, '').trim())).toEqual(
      expect.arrayContaining(['Full name', 'Email address', 'Phone number', 'Current location', 'Resume']),
    );
    expect(arrangement?.controlType).toBe('select');
  });

  it('with a remembered work-arrangement answer, every field is answered and the map validates for real', () => {
    const key = blindAnswerKey('Preferred work arrangement', 'select', optionSetHashOf(arrangement!.options!.map((option) => option.label)));
    const { mapping, validation } = run(snapshot, { [key]: 'Remote' });
    expect(mapping.missing).toEqual([]);
    expect(mapping.interventions).toEqual([]);
    expect(validation.ok).toBe(true);
    const kinds = mapping.fieldMap.assignments.map((assignment) => assignment.source.kind).sort();
    expect(kinds).toEqual(['artifact', 'option', 'value', 'value', 'value', 'value']);
  });

  it('with nothing remembered, only the work-arrangement question is missing and nothing is invented', () => {
    const { mapping, validation } = run(snapshot);
    expect(mapping.missing.map((entry) => entry.label.replace(/\s*\*\s*$/u, '').trim())).toEqual(['Preferred work arrangement']);
    expect(mapping.missing[0]?.options).toEqual(['Remote', 'Hybrid', 'On-site']);
    expect(mapping.fieldMap.assignments.some((assignment) => assignment.source.kind === 'option')).toBe(false);
    expect(validation.ok).toBe(true);
  });
});

describe('the missing-answer fixture', () => {
  it('asks for exactly the two questions nothing stored can answer, and fills neither', () => {
    const snapshot = snapshotOfFixture(FIXTURE_FORM_URLS.blindMissingAnswer);
    const { mapping } = run(snapshot);
    expect(mapping.missing.map((entry) => entry.label.replace(/\s*\*\s*$/u, '').trim())).toEqual([
      'Highest level of education',
      'Years of experience with React',
    ]);
    expect(mapping.fieldMap.assignments).toHaveLength(2); // name and email only
  });
});

describe('the bot-check fixture', () => {
  it('is recognised as a challenge by the real extractor, so a run stops before typing anything', () => {
    expect(snapshotOfFixture(FIXTURE_FORM_URLS.blindCaptcha).challengeDetected).toBe(true);
  });
});

describe('the existing consent fixture', () => {
  it('can never be completed unattended: the required consent box is the person\'s, and is never assigned', () => {
    const snapshot = snapshotOfFixture(FIXTURE_FORM_URLS.withoutUpload);
    const consent = snapshot.fields.find((field) => field.classification === 'consent_field');
    expect(consent).toBeDefined();
    const { mapping } = run(snapshot);
    expect(mapping.interventions.map((entry) => entry.kind)).toContain('consent');
    expect(mapping.fieldMap.assignments.map((assignment) => assignment.fieldRef)).not.toContain(consent!.fieldRef);
  });
});
