import {
  PROJECTS_UNLIMITED,
  selectSourceProjects,
  type CvEngagementType,
  type CvSourceDocument,
} from '../../../electron/workspace/cv-source-schema.js';

export interface CvSourceReviewProps {
  source: CvSourceDocument;
  disabled?: boolean;
  onChange: (next: CvSourceDocument) => void;
}

const ENGAGEMENT_LABEL: Record<CvEngagementType, string> = {
  employment: 'Direct employment',
  client_engagement: 'Client engagement',
};

function linksToText(links: readonly string[]): string {
  return links.join(', ');
}

function textToLinks(text: string): string[] {
  return text
    .split(',')
    .map((link) => link.trim())
    .filter((link) => link.length > 0);
}

/**
 * The review step between reading a CV into records and using those records (#274).
 *
 * Everything on this panel is a fact that either survives into an exported or tailored document or
 * is deliberately left out of it, and each one is here because the ticket names a way it was being
 * lost: contact details and links had nowhere to live, employer history had nowhere to live,
 * projects had no representation at all, and a CV too long to read in one pass was shortened with
 * nothing to show for it.
 *
 * Employment history and education are shown but not retyped here. The engagement type is the one
 * exception, and it is editable for a specific reason: "was this a job at the client, or a contract
 * delivered for them" is the single fact in this record a reader of the CV can misread, the one an
 * extraction gets wrong most often, and the one whose being wrong misstates the candidate's own
 * history. Everything else is corrected by re-extracting or by editing the CV itself.
 */
export function CvSourceReview({ source, disabled, onChange }: CvSourceReviewProps) {
  const selectedProjects = selectSourceProjects(source);
  const selectedIds = new Set(selectedProjects.map((project) => project.id));
  const pinnedCount = source.projects.filter((project) => project.pinned).length;

  function patch(next: Partial<CvSourceDocument>) {
    onChange({ ...source, ...next });
  }

  function patchContact(next: Partial<CvSourceDocument['contact']>) {
    onChange({ ...source, contact: { ...source.contact, ...next } });
  }

  function setEngagement(index: number, engagement: CvEngagementType) {
    onChange({
      ...source,
      experience: source.experience.map((entry, i) =>
        i === index ? { ...entry, engagement, client: engagement === 'client_engagement' ? entry.client : '' } : entry,
      ),
    });
  }

  function setClient(index: number, client: string) {
    onChange({
      ...source,
      experience: source.experience.map((entry, i) => (i === index ? { ...entry, client } : entry)),
    });
  }

  function togglePinned(id: string) {
    onChange({
      ...source,
      projects: source.projects.map((project) =>
        project.id === id ? { ...project, pinned: !project.pinned } : project,
      ),
    });
  }

  return (
    <section className="rounded-box border border-base-300 bg-base-200 p-3" aria-label="Source CV review">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-base-content/60">Source CV</h3>

      {!source.complete && (
        <div className="alert alert-warning mt-2 text-xs" role="alert">
          <span>
            Incomplete: {source.incompleteReason || 'this CV was not read all the way through.'} Exports are blocked
            until this is fixed, so nothing goes out looking finished while it is missing sections.
          </span>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
            Full name
          </span>
          <input
            className="input input-sm w-full"
            value={source.contact.name}
            onChange={(e) => patchContact({ name: e.target.value })}
            disabled={disabled}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
            Email
          </span>
          <input
            className="input input-sm w-full"
            value={source.contact.email}
            onChange={(e) => patchContact({ email: e.target.value })}
            disabled={disabled}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
            Phone
          </span>
          <input
            className="input input-sm w-full"
            value={source.contact.phone}
            onChange={(e) => patchContact({ phone: e.target.value })}
            disabled={disabled}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
            Location
          </span>
          <input
            className="input input-sm w-full"
            value={source.contact.location}
            onChange={(e) => patchContact({ location: e.target.value })}
            disabled={disabled}
          />
        </label>
      </div>

      <label className="mt-2.5 block">
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">Links</span>
        <input
          className="input input-sm w-full"
          value={linksToText(source.contact.links)}
          onChange={(e) => patchContact({ links: textToLinks(e.target.value) })}
          disabled={disabled}
          placeholder="Comma-separated, e.g. github.com/you, yoursite.dev"
        />
      </label>

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-base-content/60">
        Employment history ({source.experience.length})
      </h4>
      {source.experience.length === 0 ? (
        <p className="mt-1 text-xs text-base-content/60">Nothing read from this CV yet.</p>
      ) : (
        <ul className="mt-1.5 space-y-2">
          {source.experience.map((entry, index) => (
            <li key={`${entry.company}-${entry.title}-${index}`} className="rounded border border-base-300 bg-base-100 p-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">
                  {[entry.title, entry.company].filter((part) => part.trim().length > 0).join(', ')}
                </span>
                <span className="text-xs text-base-content/60">{entry.dates}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs">
                  <span className="sr-only">How this role was held</span>
                  <select
                    className="select select-xs"
                    value={entry.engagement}
                    onChange={(e) => setEngagement(index, e.target.value as CvEngagementType)}
                    disabled={disabled}
                    aria-label={`How ${entry.title || entry.company} was held`}
                  >
                    <option value="employment">{ENGAGEMENT_LABEL.employment}</option>
                    <option value="client_engagement">{ENGAGEMENT_LABEL.client_engagement}</option>
                  </select>
                </label>
                {entry.engagement === 'client_engagement' && (
                  <input
                    className="input input-xs flex-1"
                    value={entry.client}
                    onChange={(e) => setClient(index, e.target.value)}
                    disabled={disabled}
                    placeholder="End client"
                    aria-label={`End client for ${entry.title || entry.company}`}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-base-content/60">
        Projects ({source.projects.length})
      </h4>
      <label className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-base-content/60">Include at most</span>
        <input
          className="input input-xs w-20"
          type="number"
          min={0}
          max={source.projects.length || undefined}
          value={source.maxProjects}
          onChange={(e) => patch({ maxProjects: Math.max(0, Number.parseInt(e.target.value, 10) || 0) })}
          disabled={disabled}
          aria-label="Maximum projects to include"
        />
        <span className="text-base-content/60">
          {source.maxProjects === PROJECTS_UNLIMITED
            ? 'projects (0 means all of them)'
            : `projects. Pinned ones are always kept: ${pinnedCount} pinned now.`}
        </span>
      </label>
      {source.projects.length === 0 ? (
        <p className="mt-1.5 text-xs text-base-content/60">No projects read from this CV.</p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {source.projects.map((project) => (
            <li key={project.id} className="flex items-start gap-2 rounded border border-base-300 bg-base-100 p-2">
              <input
                type="checkbox"
                className="checkbox checkbox-xs mt-0.5"
                checked={project.pinned}
                onChange={() => togglePinned(project.id)}
                disabled={disabled}
                aria-label={`Always include ${project.name}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{project.name}</span>
                  <span className="text-xs text-base-content/60">{project.dates}</span>
                </div>
                <p className="text-xs text-base-content/60">
                  {[project.role, project.organization].filter((part) => part.trim().length > 0).join(', ')}
                </p>
                {!selectedIds.has(project.id) && (
                  <p className="text-xs text-warning">Left out by the limit above. Pin it to always keep it.</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-base-content/60">
        Education ({source.education.length})
      </h4>
      {source.education.length === 0 ? (
        <p className="mt-1 text-xs text-base-content/60">Nothing read from this CV yet.</p>
      ) : (
        <ul className="mt-1.5 space-y-1 text-sm">
          {source.education.map((entry, index) => (
            <li key={`${entry.institution}-${entry.credential}-${index}`}>
              {[entry.credential, entry.institution].filter((part) => part.trim().length > 0).join(', ')}
              {entry.dates && <span className="text-xs text-base-content/60"> ({entry.dates})</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
