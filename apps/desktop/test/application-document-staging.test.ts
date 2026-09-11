import { jsPDF } from 'jspdf';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TailoredResume } from '../electron/resume-schema.js';

/**
 * #276's third acceptance check in the production staging path: "a missing requested cover-letter
 * file cannot be reported ready". `document-readiness.test.ts` proves the rule; this proves the
 * path that actually applies it, including that a letter whose generation returned nothing is
 * reported as a missing requested document rather than staged as a blank one.
 *
 * `printToPDF` needs a real `webContents`, so `BrowserWindow` is replaced with a stand-in that
 * hands back prepared PDF bytes in print order (the CV first, then each letter). The bytes are real
 * PDFs and go through the real acceptance contract -- only the renderer is stood in for.
 */

const { printQueue, loadedUrls } = vi.hoisted(() => ({ printQueue: [] as Uint8Array[], loadedUrls: [] as string[] }));

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      printToPDF: async (): Promise<Buffer> => Buffer.from(printQueue.shift() ?? new Uint8Array()),
    };
    async loadURL(url: string): Promise<void> {
      loadedUrls.push(url);
    }
    destroy(): void {}
  },
}));

const { createApplicationArtifact } = vi.hoisted(() => ({
  createApplicationArtifact: vi.fn((_db: unknown, input: Record<string, unknown>) => ({
    id: `artifact-${String(input.kind)}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...input,
  })),
}));
vi.mock('../electron/workspace/repository.js', () => ({ createApplicationArtifact }));

const { mkdir, writeFile } = vi.hoisted(() => ({ mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) }));
vi.mock('node:fs/promises', () => ({ mkdir, writeFile, readFile: vi.fn(), default: { mkdir, writeFile, readFile: vi.fn() } }));

function pdfContaining(lines: string[], title: string): Uint8Array {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setProperties({ title });
  doc.setFontSize(11);
  lines.forEach((line, index) => doc.text(line, 56, 60 + index * 18));
  return new Uint8Array(doc.output('arraybuffer'));
}

const RESUME: TailoredResume = {
  contact: { name: 'Jamie Rivera', title: 'Senior Engineer', location: 'Amsterdam', email: 'jamie@example.invalid', phone: '+31 6 1234 5678', links: [] },
  summary: 'Synthetic summary.',
  experience: [{ company: 'Redwood Software', title: 'Senior Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: [] }],
  projects: [],
  skills: [],
  education: [],
};

const TARGET = { company: 'Northwind Freight', role: 'Logistics Platform Engineer' };
const LETTER_BODY = 'Dear Northwind Freight hiring team,\n\nI am applying for the Logistics Platform Engineer role.';

const GOOD_CV_PDF = (): Uint8Array => pdfContaining(['Jamie Rivera', 'Senior Engineer', 'Redwood Software'], 'Jamie Rivera');
const GOOD_LETTER_PDF = (): Uint8Array =>
  pdfContaining(
    ['Cover Letter', 'Dear Northwind Freight hiring team,', 'I am applying for the Logistics Platform Engineer role.', 'Jamie Rivera'],
    'Cover Letter',
  );

async function importStaging() {
  return import('../electron/application-artifact-staging.js');
}

const FAKE_DB = {} as never;

function options(letters: Array<{ kind: 'cover_letter' | 'motivation_letter'; title: string; body: string }>) {
  return { db: FAKE_DB, attemptId: 'attempt-1', storageRoot: '/data/artifacts', target: TARGET, resume: RESUME, letters };
}

describe('stageApplicationDocuments (#276 acceptance check 3)', () => {
  beforeEach(() => {
    printQueue.length = 0;
    loadedUrls.length = 0;
    createApplicationArtifact.mockClear();
  });

  it('stages a CV and the requested cover letter, and reports the set ready', async () => {
    const { stageApplicationDocuments } = await importStaging();
    printQueue.push(GOOD_CV_PDF(), GOOD_LETTER_PDF());

    const result = await stageApplicationDocuments(options([{ kind: 'cover_letter', title: 'Cover Letter', body: LETTER_BODY }]));

    expect(result.records.map((record) => record.kind)).toEqual(['cv_pdf', 'cover_letter_pdf']);
    expect(result.readiness.ok).toBe(true);
    expect(result.readiness.verifiedContentHashes.map((entry) => entry.kind)).toEqual(['cv', 'cover_letter']);
  });

  it('refuses to report ready when a requested cover letter was never produced', async () => {
    const { stageApplicationDocuments } = await importStaging();
    printQueue.push(GOOD_CV_PDF());

    const result = await stageApplicationDocuments(options([{ kind: 'cover_letter', title: 'Cover Letter', body: '   ' }]));

    expect(result.records.map((record) => record.kind)).toEqual(['cv_pdf']);
    expect(result.readiness.ok).toBe(false);
    expect(result.readiness.refusals).toEqual([{ reason: 'requested_document_missing', kind: 'cover_letter', detail: expect.stringContaining('cover letter') }]);
    expect(result.readiness.verifiedContentHashes).toEqual([]);
  });

  it('registers each artifact under the hash the acceptance check itself computed', async () => {
    const { stageApplicationDocuments } = await importStaging();
    const { hashDocumentBytes } = await import('../electron/document-acceptance.js');
    const cvBytes = GOOD_CV_PDF();
    printQueue.push(cvBytes);

    const result = await stageApplicationDocuments(options([]));

    expect(result.records[0]?.contentHash).toBe(hashDocumentBytes(cvBytes));
    expect(result.readiness.verifiedContentHashes).toEqual([{ kind: 'cv', contentHash: hashDocumentBytes(cvBytes) }]);
  });

  it('refuses to register a letter whose rendered output fails the contract, instead of staging broken output', async () => {
    const { stageApplicationDocuments, DocumentAcceptanceError } = await importStaging();
    // A letter that rendered blank: the exact case the pre-#276 generic staging path registered
    // without a single check.
    printQueue.push(GOOD_CV_PDF(), new Uint8Array(new jsPDF({ unit: 'pt', format: 'a4' }).output('arraybuffer')));

    await expect(stageApplicationDocuments(options([{ kind: 'cover_letter', title: 'Cover Letter', body: LETTER_BODY }]))).rejects.toBeInstanceOf(
      DocumentAcceptanceError,
    );
  });

  it('refuses a CV whose rendered output dropped an employer, before anything is written to disk', async () => {
    const { stageApplicationDocuments, DocumentAcceptanceError } = await importStaging();
    printQueue.push(pdfContaining(['Jamie Rivera', 'Senior Engineer'], 'Jamie Rivera'));

    await expect(stageApplicationDocuments(options([]))).rejects.toBeInstanceOf(DocumentAcceptanceError);
    expect(writeFile).not.toHaveBeenCalled();
    expect(createApplicationArtifact).not.toHaveBeenCalled();
  });

  it('stores a motivation letter under the artifact table\'s cover-letter kind, which has no row of its own', async () => {
    const { stageApplicationDocuments } = await importStaging();
    printQueue.push(
      GOOD_CV_PDF(),
      pdfContaining(
        ['Motivation Letter', 'Dear Northwind Freight hiring team,', 'I am applying for the Logistics Platform Engineer role.', 'Jamie Rivera'],
        'Motivation Letter',
      ),
    );

    const result = await stageApplicationDocuments(options([{ kind: 'motivation_letter', title: 'Motivation Letter', body: LETTER_BODY }]));

    expect(result.records.map((record) => record.kind)).toEqual(['cv_pdf', 'cover_letter_pdf']);
    expect(result.readiness.ok).toBe(true);
  });

  it('only ever renders app-owned HTML, never a remote URL', async () => {
    const { stageApplicationDocuments } = await importStaging();
    printQueue.push(GOOD_CV_PDF());

    await stageApplicationDocuments(options([]));

    expect(loadedUrls).toHaveLength(1);
    expect(loadedUrls[0]).toMatch(/^data:text\/html;charset=utf-8,/);
  });
});
