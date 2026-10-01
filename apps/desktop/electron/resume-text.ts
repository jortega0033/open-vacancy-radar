import type { TailoredResume } from './resume-schema.js';

/**
 * The copyable plain-text form of a `TailoredResume` (#419 step 9). Built from the approved
 * snapshot only, never from the free-form draft, and carrying the same claims, in the same order,
 * as the PDF and DOCX renderings (`resumeClaims` in `resume-claims.ts` is the shared list the tests
 * hold it to). No Electron or Node imports: the renderer builds it from the stored snapshot.
 */
export function renderResumePlainText(resume: TailoredResume): string {
  const blocks: string[] = [];
  const join = (parts: string[], separator: string): string =>
    parts.map((part) => part.trim()).filter((part) => part.length > 0).join(separator);

  blocks.push(
    [
      resume.contact.name.trim(),
      resume.contact.title.trim(),
      join([resume.contact.location, resume.contact.email, resume.contact.phone, ...resume.contact.links], ' | '),
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
  );
  if (resume.summary.trim().length > 0) blocks.push(resume.summary.trim());

  if (resume.experience.length > 0) {
    const lines = ['Experience'];
    for (const entry of resume.experience) {
      const head = join([entry.title, entry.company], ', ');
      lines.push('', entry.dates.trim() ? `${head} (${entry.dates.trim()})` : head);
      if (entry.engagement === 'client_engagement') {
        lines.push(entry.client.trim() ? `Client engagement: ${entry.client.trim()}` : 'Client engagement');
      }
      for (const bullet of entry.bullets) lines.push(`- ${bullet.trim()}`);
    }
    blocks.push(lines.join('\n'));
  }

  if (resume.projects.length > 0) {
    const lines = ['Projects'];
    for (const project of resume.projects) {
      lines.push('', project.dates.trim() ? `${project.name.trim()} (${project.dates.trim()})` : project.name.trim());
      const context = join([project.role, project.organization], ', ');
      if (context) lines.push(context);
      if (project.description.trim()) lines.push(project.description.trim());
      if (project.technologies.length > 0) lines.push(`Technologies: ${join(project.technologies, ', ')}`);
      if (project.links.length > 0) lines.push(`Links: ${join(project.links, ' | ')}`);
    }
    blocks.push(lines.join('\n'));
  }

  if (resume.skills.length > 0) blocks.push(`Skills\n${join(resume.skills, ', ')}`);

  if (resume.education.length > 0) {
    const lines = ['Education'];
    for (const entry of resume.education) {
      const head = join([entry.credential, entry.institution], ', ');
      lines.push(entry.dates.trim() ? `${head} (${entry.dates.trim()})` : head);
    }
    blocks.push(lines.join('\n'));
  }

  return `${blocks.filter((block) => block.length > 0).join('\n\n')}\n`;
}
