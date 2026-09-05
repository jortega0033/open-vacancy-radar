import type { TailoredResume } from './resume-schema.js';

/**
 * The one default OVR resume template (#199 / #156): real sections a template can lay out
 * reliably, not a styled shell around one prose blob. No user-customizable templates in this
 * slice -- that is `draft-custom-resume-templates.md`'s later, separate scope.
 *
 * Pure string building, no Electron or Node API: this is exactly the "controlled, app-owned HTML"
 * `webContents.printToPDF` renders (see the main-process staging code that calls this) -- never
 * remote job-posting content, which stays confined to the text-only generation session per #196's
 * trust-domain design and never reaches this template at all.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function contactLine(resume: TailoredResume): string {
  const parts = [resume.contact.location, resume.contact.email, resume.contact.phone, ...resume.contact.links].filter(
    (part) => part.trim().length > 0,
  );
  return parts.map(escapeHtml).join(' &nbsp;&middot;&nbsp; ');
}

function experienceSection(resume: TailoredResume): string {
  if (resume.experience.length === 0) return '';
  const entries = resume.experience
    .map(
      (entry) => `
    <article class="entry">
      <div class="entry-head">
        <span class="entry-title">${escapeHtml(entry.title)}${entry.title && entry.company ? ', ' : ''}${escapeHtml(entry.company)}</span>
        <span class="entry-dates">${escapeHtml(entry.dates)}</span>
      </div>
      ${entry.bullets.length > 0 ? `<ul>${entry.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>` : ''}
    </article>`,
    )
    .join('');
  return `<section><h2>Experience</h2>${entries}</section>`;
}

function educationSection(resume: TailoredResume): string {
  if (resume.education.length === 0) return '';
  const entries = resume.education
    .map(
      (entry) => `
    <article class="entry">
      <div class="entry-head">
        <span class="entry-title">${escapeHtml(entry.credential)}${entry.credential && entry.institution ? ', ' : ''}${escapeHtml(entry.institution)}</span>
        <span class="entry-dates">${escapeHtml(entry.dates)}</span>
      </div>
    </article>`,
    )
    .join('');
  return `<section><h2>Education</h2>${entries}</section>`;
}

function skillsSection(resume: TailoredResume): string {
  if (resume.skills.length === 0) return '';
  return `<section><h2>Skills</h2><p class="skills">${resume.skills.map(escapeHtml).join(', ')}</p></section>`;
}

function summarySection(resume: TailoredResume): string {
  if (resume.summary.trim().length === 0) return '';
  return `<section><p class="summary">${escapeHtml(resume.summary)}</p></section>`;
}

/** Renders one `TailoredResume` into the app's default resume template, as a complete standalone
 * HTML document ready for `webContents.loadURL('data:text/html,...')` + `printToPDF`. */
export function renderResumeHtml(resume: TailoredResume): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(resume.contact.name || 'Resume')}</title>
<style>
@page { margin: 48px 56px; }
body { font: 11pt/1.45 Georgia, 'Times New Roman', serif; color: #1a1a1a; margin: 0; }
header { margin-bottom: 18px; }
h1 { font-size: 20pt; margin: 0 0 2px; }
.headline { font-size: 12pt; color: #444; margin: 0 0 6px; }
.contact-line { font-size: 9.5pt; color: #555; }
h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #ccc; padding-bottom: 2px; margin: 16px 0 8px; }
section:first-of-type h2 { margin-top: 0; }
.entry { margin-bottom: 10px; }
.entry-head { display: flex; justify-content: space-between; gap: 12px; font-weight: bold; }
.entry-dates { font-weight: normal; color: #555; white-space: nowrap; }
ul { margin: 4px 0 0; padding-left: 18px; }
li { margin-bottom: 2px; }
.summary { margin: 0; }
.skills { margin: 0; }
</style></head>
<body>
<header>
  <h1>${escapeHtml(resume.contact.name || 'Candidate')}</h1>
  ${resume.contact.title ? `<p class="headline">${escapeHtml(resume.contact.title)}</p>` : ''}
  <p class="contact-line">${contactLine(resume)}</p>
</header>
${summarySection(resume)}
${experienceSection(resume)}
${skillsSection(resume)}
${educationSection(resume)}
</body></html>`;
}
