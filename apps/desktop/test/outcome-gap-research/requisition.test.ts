// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { app, job, key } from './builders.js';
import { collapseByRequisition, compareIdentitySurfaces, identityRisk, keyFromFields, keyFromBrief, NO_KEY, semanticKeyOf } from './requisition.js';

describe('canonical requisition key v1 (built on the REAL engine identity)', () => {
  it('counts syndicated copies of one ATS requisition once, whatever the tracking parameters or host spelling', () => {
    const a = keyFromFields({ url: 'https://job-boards.greenhouse.io/northwind/jobs/1001', company: 'Northwind Freight', title: 'Platform Engineer' });
    const b = keyFromFields({ url: 'https://boards.greenhouse.io/northwind/jobs/1001?gh_src=abc&utm_source=feed', company: 'Northwind Freight GmbH', title: 'Platform Engineer (Remote)' });
    expect(a.tier).toBe('requisition');
    expect(a.strength).toBe('strong');
    expect(b.key).toBe(a.key);
    expect(a.key).toBe('rk1:req:greenhouse:northwind:1001');
    expect(collapseByRequisition([{ requisition: a }, { requisition: b }])).toMatchObject({ copiesCollapsed: 1, unkeyed: 0 });
  });

  it('keeps two requisitions at the same employer apart: the employer is never an identity', () => {
    const one = keyFromFields({ url: 'https://job-boards.greenhouse.io/northwind/jobs/1001', company: 'Northwind Freight', title: 'Platform Engineer' });
    const two = keyFromFields({ url: 'https://job-boards.greenhouse.io/northwind/jobs/1002', company: 'Northwind Freight', title: 'Platform Engineer' });
    expect(one.key).not.toBe(two.key);
    expect(collapseByRequisition([{ requisition: one }, { requisition: two }]).groups).toHaveLength(2);
  });

  it('puts a generic listing URL on the weak semantic tier, and says that tier cannot tell two same-text roles apart', () => {
    const generic = keyFromFields({ url: 'https://acme.example/careers', company: 'Acme', title: 'Data Engineer', location: 'Remote' });
    expect(generic.tier).toBe('semantic');
    expect(generic.strength).toBe('weak');
    const twin = keyFromFields({ url: 'https://acme.example/careers', company: 'ACME', title: 'data engineer', location: 'remote' });
    // Same text = same weak key: two genuinely different openings with identical text would be merged here.
    // That is the documented limit of the tier; the funnel therefore reports weak-key share instead of hiding it.
    expect(twin.key).toBe(generic.key);
  });

  it('never merges items that have no key at all', () => {
    const result = collapseByRequisition([{ requisition: NO_KEY }, { requisition: NO_KEY }, { requisition: key('requisition', 'x') }]);
    expect(result.groups).toHaveLength(3);
    expect(result.unkeyed).toBe(2);
    expect(result.copiesCollapsed).toBe(0);
  });

  it('wraps a stored brief identity without double-prefixing or re-deriving it', () => {
    expect(keyFromBrief('req:greenhouse:northwind:1001', 'requisition').key).toBe('rk1:req:greenhouse:northwind:1001');
    expect(keyFromBrief('url:https://jobs.example/x', 'canonical_url')).toMatchObject({ key: 'rk1:url:https://jobs.example/x', strength: 'medium', origin: 'brief_identity' });
  });

  it('reports where the two identity implementations disagree instead of choosing silently', () => {
    const workable = compareIdentitySurfaces({ url: 'https://apply.workable.com/harbor/j/ABC123DEF4/', company: 'Harbor Systems', title: 'Backend Engineer' });
    // #275 (attempt rows) recognises Workable's /<org>/j/<code> as a requisition. The engine (#278, which briefs and
    // discovery merges use) does not, and OBSERVED behaviour is worse than "not recognised": its generic-listing
    // check tests `/^\/j\//` against the whole path, so the org-prefixed real shape is treated as a listing page and
    // falls to the weak semantic tier. Reported as a finding in the design doc; not fixed here (out of scope).
    expect(workable.attemptHasRequisition).toBe(true);
    expect(workable.engine.tier).toBe('semantic');
    expect(workable.disagree).toBe(true);
    const greenhouse = compareIdentitySurfaces({ url: 'https://job-boards.greenhouse.io/northwind/jobs/1001', company: 'Northwind', title: 'Platform Engineer' });
    expect(greenhouse.disagree).toBe(false);
  });

  it('flags a possible under-merge (same text, different keys) and counts weak keys, without merging anything', () => {
    const rows = [
      { requisition: keyFromFields({ url: 'https://job-boards.greenhouse.io/northwind/jobs/1001', company: 'Northwind', title: 'Platform Engineer', location: 'Remote' }), company: 'Northwind', title: 'Platform Engineer', location: 'Remote', copies: 1 },
      { requisition: keyFromFields({ url: 'https://aggregator.example/jobs', company: 'Northwind', title: 'Platform Engineer', location: 'Remote' }), company: 'Northwind', title: 'Platform Engineer', location: 'Remote', copies: 2 },
      { requisition: NO_KEY, company: 'Nobody', title: 'x', location: '', copies: 1 },
    ];
    const risk = identityRisk(rows);
    expect(risk.possibleUnderMerge).toHaveLength(1);
    expect(risk.possibleUnderMerge[0]!.keys).toHaveLength(2);
    expect(risk.weakKeyRequisitions).toBe(1);
    expect(risk.weakGroupsWithCopies).toBe(1);
    expect(risk.unkeyedRequisitions).toBe(1);
    expect(semanticKeyOf({ company: 'Northwind', title: 'Platform Engineer', location: 'Remote' })).toContain('northwind');
  });

  it('is a builder sanity check: hand-built keys have the documented shape', () => {
    expect(job('j').requisition.key.startsWith('rk1:req:')).toBe(true);
    expect(app('a', 'prepared').evidence).toBe('app_recorded');
  });
});
