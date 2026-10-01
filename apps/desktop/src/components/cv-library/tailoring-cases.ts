import type { CvEvidenceOverlayRecord } from '../../window.js';
import type { VacancyLead } from '../cv/index.js';

/** What the candidate sees for one tailoring case. The role and company are stored with the case
 * (#419); a case that predates them is labelled from its key, or from the start of its saved text. */
export function describeTailoringCase(overlay: CvEvidenceOverlayRecord): string {
  const title = overlay.caseTitle.trim();
  const company = overlay.caseCompany.trim();
  if (title || company) return [title, company].filter(Boolean).join(' at ');
  const key = overlay.vacancyKey;
  if (key.startsWith('fields:')) {
    const [keyTitle = '', keyCompany = ''] = key.slice('fields:'.length).split('|');
    if (keyTitle || keyCompany) return [keyTitle, keyCompany].filter(Boolean).join(' at ');
  }
  if (key.startsWith('url:')) return key.slice('url:'.length);
  const firstLine = overlay.jdSnapshot.trim().split('\n')[0]?.slice(0, 60) ?? '';
  return firstLine ? `Pasted job: ${firstLine}` : 'Pasted job with no text saved yet';
}

/**
 * The vacancy the workspace opens on for an existing case. Everything comes from what the case
 * stored: its own key (so the same record is found again, whatever the title says), its latest job
 * description revision, and the role and company it was opened for. Nothing is fetched or guessed.
 */
export function vacancyFromCase(overlay: CvEvidenceOverlayRecord): VacancyLead {
  const latest = overlay.jdRevisions.at(-1);
  const url = latest?.url || (overlay.vacancyKey.startsWith('url:') ? overlay.vacancyKey.slice('url:'.length) : '');
  return {
    title: overlay.caseTitle.trim() || describeTailoringCase(overlay),
    company: overlay.caseCompany.trim(),
    location: '',
    url,
    description: overlay.jdSnapshot,
    requirements: null,
    caseKey: overlay.vacancyKey,
    jdOrigin: latest?.origin ?? (overlay.origin === 'manual' ? 'manual' : 'found'),
    ...(latest?.requisition ? { jdRequisition: latest.requisition } : {}),
  };
}
