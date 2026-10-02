// @vitest-environment node
import { jsPDF } from 'jspdf';
import { describe, expect, it } from 'vitest';
import { renderApprovedSnapshot } from '../electron/cv-case-export.js';
import type { TailoredResume } from '../electron/resume-schema.js';

/**
 * Rendering and checking the approved snapshot (#419 step 9). The PDF printer is Electron's, so a
 * stand-in that prints the given lines with jsPDF (real, extractable PDF bytes) takes its place; the
 * Word path runs the real renderer and validator.
 */
const RESUME: TailoredResume = {
  contact: { name: 'Jamie Rivera', title: '', location: '', email: '', phone: '', links: [] },
  summary: 'Frontend engineer.',
  experience: [{ company: 'Redwood Software', title: 'Senior Frontend Engineer', dates: '', engagement: 'employment', client: '', bullets: ['Built the booking screens'] }],
  projects: [],
  skills: [],
  education: [],
};

const FAITHFUL_LINES = ['Jamie Rivera', 'Frontend engineer.', 'Senior Frontend Engineer, Redwood Software', 'Built the booking screens'];

function printerFor(lines: string[]): (html: string) => Promise<Buffer> {
  return async () => {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    let y = 50;
    for (const line of lines) {
      doc.text(line, 50, y);
      y += 20;
    }
    return Buffer.from(doc.output('arraybuffer'));
  };
}

describe('renderApprovedSnapshot', () => {
  it('renders a PDF from the snapshot, with the hash of its bytes, its page count and the checks', async () => {
    const rendered = await renderApprovedSnapshot(RESUME, 'pdf', printerFor(FAITHFUL_LINES));
    expect(rendered.validation).toEqual({ ok: true, reasons: [], pageCount: 1 });
    expect(rendered.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a failed PDF instead of throwing, so the failed file can be recorded', async () => {
    const rendered = await renderApprovedSnapshot(RESUME, 'pdf', printerFor(['Someone Else']));
    expect(rendered.validation.ok).toBe(false);
    expect(rendered.validation.reasons.length).toBeGreaterThan(0);
  });

  it('records a PDF that dropped an approved bullet as failed, naming the bullet', async () => {
    const rendered = await renderApprovedSnapshot(RESUME, 'pdf', printerFor(FAITHFUL_LINES.filter((line) => line !== 'Built the booking screens')));
    expect(rendered.validation.ok).toBe(false);
    expect(rendered.validation.reasons.join(' ')).toMatch(/bullet "Built the booking screens" is missing/);
  });

  it('renders and checks a Word file from the same snapshot, with no page count', async () => {
    const rendered = await renderApprovedSnapshot(RESUME, 'docx', async () => {
      throw new Error('the printer is not used for Word');
    });
    expect(rendered.validation).toEqual({ ok: true, reasons: [] });
    expect(rendered.buffer.byteLength).toBeGreaterThan(0);
  });

  it('gives different hashes for different formats of the same snapshot', async () => {
    const pdf = await renderApprovedSnapshot(RESUME, 'pdf', printerFor(FAITHFUL_LINES));
    const docx = await renderApprovedSnapshot(RESUME, 'docx', async () => Buffer.alloc(0));
    expect(pdf.contentHash).not.toBe(docx.contentHash);
  });
});
