import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COMPANY_EVIDENCE_TOPICS,
  LEAD_REASON_TEXT,
  type ClassifiedFact,
  type CompanyEvidenceResult,
  type CompanyEvidenceScope,
  type CompanyEvidenceTargetInput,
  type CompanyEvidenceTopic,
  type CompanyEvidenceView,
} from '../../../electron/company-evidence.js';

export interface CompanyEvidencePanelProps {
  /** Which application or attempt this is about. Main resolves the employer and role from it. */
  target: CompanyEvidenceTargetInput;
  /** Changes whenever the target changes, so the stored evidence is read again. */
  reloadKey?: string;
  /** Called after anything changed, so a sibling that built a prompt from the evidence can re-read it. */
  onChanged?: () => void;
}

const TOPIC_LABEL: Record<CompanyEvidenceTopic, string> = {
  general: 'General',
  products: 'Products or services',
  size: 'Size',
  location: 'Location',
  remote_policy: 'Remote policy',
  funding: 'Funding or ownership',
  leadership: 'Leadership',
  sponsorship: 'Visa sponsorship',
  other: 'Other',
};

const IDENTITY_BASIS_LABEL: Record<string, string> = {
  ats_tenant: 'the job board account in the posting address',
  posting_host: "the employer's own site in the posting address",
  user_domain: 'a website you confirmed',
};

function formatDay(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return 'never';
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function scopeLabel(fact: ClassifiedFact): string {
  if (fact.viaLink) return `Company (from ${fact.viaLink})`;
  if (fact.scope === 'company') return 'Company';
  return fact.reasons.includes('other_role') ? `Other role: ${fact.roleLabel || 'unnamed'}` : 'This role';
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Sourced company evidence for one application (#689), in the screens the person already uses (the
 * attempt drawer and "Prepare interview"). Every claim shows its scope, its public source, when the
 * app last observed it and why it is, or is not, being used. A claim is "Used" only while it has a
 * confirmed source, is current, has no open disagreement and fits this role; everything else is a
 * lead the person can see and fix but the drafts never rely on.
 *
 * Nothing here runs by itself: reading shows what is stored, and every network action (research,
 * checking sources) is a button with a Stop button beside it. A stopped or failed action leaves the
 * saved evidence and every prepared draft exactly as they were.
 */
export function CompanyEvidencePanel({ target, reloadKey, onChanged }: CompanyEvidencePanelProps) {
  const [view, setView] = useState<CompanyEvidenceView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [domain, setDomain] = useState('');
  const [editing, setEditing] = useState<{ id: string; claim: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState({ claim: '', sourceUrl: '', quote: '', scope: 'company' as CompanyEvidenceScope, topic: 'general' as CompanyEvidenceTopic });
  const mounted = useRef(true);
  const targetKey = 'attemptId' in target ? `a:${target.attemptId}` : `p:${target.applicationId}`;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const accept = useCallback(
    (result: CompanyEvidenceResult, changed: boolean) => {
      if (!mounted.current) return;
      if (result.ok) {
        setView(result.view);
        setNotice(result.notice);
        setError('');
        setLoadFailed(false);
        if (changed) onChanged?.();
      } else {
        setError(result.message);
        setNotice('');
      }
    },
    [onChanged],
  );

  useEffect(() => {
    let cancelled = false;
    setNotice('');
    setError('');
    setConfirmDelete(false);
    if (typeof window.companyEvidence?.get !== 'function') return undefined;
    void window.companyEvidence
      .get(target)
      .then((result) => {
        if (cancelled || !mounted.current) return;
        if (result.ok) {
          setView(result.view);
          setLoadFailed(false);
        } else {
          setLoadFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled && mounted.current) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [targetKey, reloadKey]);

  const run = useCallback(
    async (name: string, action: () => Promise<CompanyEvidenceResult>, changed = true) => {
      setBusy(name);
      setError('');
      try {
        accept(await action(), changed);
      } catch {
        if (mounted.current) setError('That did not work. Nothing was changed.');
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [accept],
  );

  if (view === null) {
    if (!loadFailed) return null;
    return (
      <section aria-label="Company evidence" data-testid="company-evidence" className="rounded-box border border-base-300 p-3 text-sm">
        <p role="status" className="text-xs text-base-content/70">
          We could not load the company evidence. Your drafts are not affected.
        </p>
      </section>
    );
  }

  const company = view.identity.displayName;
  const longRunning = busy === 'research' || busy === 'refresh';
  const idle = busy === null;
  const used = view.facts.filter((fact) => fact.support === 'supported');
  const leads = view.facts.filter((fact) => fact.support === 'lead' && !fact.reasons.includes('other_role'));
  const otherRole = view.facts.filter((fact) => fact.reasons.includes('other_role'));
  const factById = new Map(view.facts.map((fact) => [fact.id, fact]));

  function renderFact(fact: ClassifiedFact) {
    const isEditing = editing?.id === fact.id;
    return (
      <li key={fact.id} className="rounded-box border border-base-300 p-2" data-testid="company-fact" data-support={fact.support}>
        <p className="break-words text-sm">{fact.claim}</p>
        <p className="mt-1 flex flex-wrap items-center gap-1 text-xs">
          <span className={fact.support === 'supported' ? 'badge badge-sm badge-success' : 'badge badge-sm badge-warning'}>
            {fact.support === 'supported' ? 'Used' : 'Lead only'}
          </span>
          <span className="badge badge-sm badge-outline">{scopeLabel(fact)}</span>
          <span className="badge badge-sm badge-outline">{TOPIC_LABEL[fact.topic]}</span>
          <span className="badge badge-sm badge-outline">
            {fact.verification === 'source_confirmed' ? 'Source checked' : fact.verification === 'user_confirmed' ? 'You confirmed' : 'Not confirmed'}
          </span>
        </p>
        <p className="mt-1 break-words text-xs text-base-content/70">
          Source:{' '}
          <a className="link" href={fact.sourceUrl} target="_blank" rel="noreferrer">
            {sourceHost(fact.sourceUrl)}
          </a>
          {fact.official ? ' (the employer)' : ''}. Last checked {formatDay(fact.retrievedAt)}
          {fact.retrievedAt ? '' : ' (you supplied it; the page was not fetched)'}.{' '}
          {fact.reasons.includes('expired') ? 'Expired on' : 'Valid until'} {formatDay(fact.expiresAt)}.
        </p>
        {fact.reasons.length > 0 && (
          <ul className="mt-1 list-disc pl-5 text-xs text-base-content/80">
            {fact.reasons.map((reason) => (
              <li key={reason}>{LEAD_REASON_TEXT[reason]}</li>
            ))}
          </ul>
        )}
        {fact.lastRefreshOutcome && fact.lastRefreshOutcome !== 'renewed' && (
          <p className="mt-1 text-xs text-base-content/70">
            {fact.lastRefreshOutcome === 'cache_hit'
              ? 'Still current, so the source was not fetched again.'
              : fact.lastRefreshOutcome === 'source_changed'
                ? 'The last check no longer found this passage on the source page.'
                : 'The last check could not reach the source, so the dates above did not change.'}
          </p>
        )}
        {fact.correction && (
          <p className="mt-1 break-words text-xs text-base-content/70">
            You corrected this on {formatDay(fact.correction.correctedAt)}. It first read: {fact.correction.originalClaim}
          </p>
        )}
        {!fact.viaLink && (
          <div className="mt-2 flex flex-wrap gap-2">
            {isEditing ? (
              <>
                <label className="sr-only" htmlFor={`fact-edit-${fact.id}`}>
                  Corrected claim
                </label>
                <input
                  aria-label="Corrected claim"
                  id={`fact-edit-${fact.id}`}
                  className="input input-bordered input-sm min-w-0 flex-1"
                  value={editing.claim}
                  onChange={(event) => setEditing({ id: fact.id, claim: event.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  disabled={!idle}
                  onClick={() => void run('correct', () => window.companyEvidence.correctFact(target, fact.id, editing.claim)).then(() => setEditing(null))}
                >
                  Save correction
                </button>
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                {fact.verification !== 'user_confirmed' && fact.sourceKind !== 'ind_register' && (
                  <button
                    type="button"
                    className="btn btn-outline btn-xs"
                    disabled={!idle}
                    onClick={() => void run('confirm', () => window.companyEvidence.confirmFact(target, fact.id))}
                  >
                    I read the source
                  </button>
                )}
                <button type="button" className="btn btn-ghost btn-xs" disabled={!idle} onClick={() => setEditing({ id: fact.id, claim: fact.claim })}>
                  Correct
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  disabled={!idle}
                  onClick={() => void run('withdraw', () => window.companyEvidence.withdrawFact(target, fact.id))}
                >
                  Remove
                </button>
              </>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <section aria-label="Company evidence" data-testid="company-evidence" data-state={view.state} className="rounded-box border border-base-300 p-3 text-sm">
      <h3 className="font-semibold">Company evidence</h3>
      <p className="mt-0.5 text-xs text-base-content/70">
        Public facts about {company}, kept apart from your CV. Only a fact with a checked source that is still current, has no
        disagreement and fits this role is used in a letter or interview prep. Everything else is a lead.
      </p>

      <div role="status" aria-live="polite" className="mt-2 min-h-4 text-xs">
        {notice}
      </div>
      {error && (
        <p className="text-xs text-error" role="alert">
          {error}
        </p>
      )}

      {view.state === 'no_identity' ? (
        <div className="mt-2" data-testid="company-identity-missing">
          <p className="text-xs">
            We cannot tell which {company} this is from the posting alone, and a name or a register match is not enough. Enter the
            company's own website to start a record.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <label className="sr-only" htmlFor="company-evidence-domain">
              Company website
            </label>
            <input
              aria-label="Company website"
              id="company-evidence-domain"
              className="input input-bordered input-sm min-w-0 flex-1"
              placeholder="example.com"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!idle || domain.trim().length < 3}
              onClick={() => void run('domain', () => window.companyEvidence.confirmDomain(target, { domain }))}
            >
              Confirm website
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-2 text-xs text-base-content/70" data-testid="company-identity">
            Identified by {IDENTITY_BASIS_LABEL[view.identity.keyKind ?? 'ats_tenant']}
            {view.identity.host ? ` (${view.identity.host})` : ''}. {view.supportedCount} used, {view.leadCount} leads.
          </p>

          {view.links.filter((link) => link.status === 'proposed').map((link) => (
            <div key={link.id} className="mt-2 rounded-box border border-info/40 bg-info/10 p-2" data-testid="company-link-proposal">
              <p className="text-xs">
                {link.otherName}
                {link.otherHost ? ` (${link.otherHost})` : ''} has a similar name but a different website. Is it the same company? Nothing is
                shared until you say so, and role claims are never shared.
              </p>
              <div className="mt-1 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-outline btn-xs"
                  disabled={!idle}
                  onClick={() => void run('link', () => window.companyEvidence.decideLink(target, link.id, 'confirmed'))}
                >
                  Same company, share company facts
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  disabled={!idle}
                  onClick={() => void run('link', () => window.companyEvidence.decideLink(target, link.id, 'rejected'))}
                >
                  Different company
                </button>
              </div>
            </div>
          ))}
          {view.links.filter((link) => link.status === 'confirmed').map((link) => (
            <p key={link.id} className="mt-2 text-xs text-base-content/70">
              Sharing company facts with {link.otherName}.{' '}
              <button
                type="button"
                className="link"
                disabled={!idle}
                onClick={() => void run('link', () => window.companyEvidence.decideLink(target, link.id, 'rejected'))}
              >
                Stop sharing
              </button>
            </p>
          ))}

          {view.contradictions.map((item) => {
            const a = factById.get(item.factAId);
            const b = factById.get(item.factBId);
            if (!a || !b) return null;
            return (
              <div key={item.id} className="mt-2 rounded-box border border-warning/50 bg-warning/10 p-2" data-testid="company-contradiction">
                <p className="text-xs font-medium">Two sources disagree about {TOPIC_LABEL[item.topic].toLowerCase()}. Neither is used until you choose.</p>
                {[a, b].map((side) => (
                  <div key={side.id} className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 break-words text-xs">
                      {side.claim} ({sourceHost(side.sourceUrl)})
                    </span>
                    <button
                      type="button"
                      className="btn btn-outline btn-xs"
                      disabled={!idle}
                      onClick={() => void run('resolve', () => window.companyEvidence.resolveContradiction(target, item.id, side.id))}
                    >
                      Keep this one
                    </button>
                  </div>
                ))}
              </div>
            );
          })}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!idle}
              onClick={() => void run('research', () => window.companyEvidence.research(target, { includeRole: true }))}
            >
              {busy === 'research' ? 'Researching...' : 'Research this company'}
            </button>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={!idle || view.facts.length === 0}
              onClick={() => void run('refresh', () => window.companyEvidence.refresh(target))}
            >
              {busy === 'refresh' ? 'Checking...' : 'Check sources again'}
            </button>
            {longRunning && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void window.companyEvidence.cancel(target)}>
                Stop
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-base-content/60">
            Research searches the public web for facts about {company} only. Your CV, letters and notes are never sent. Nothing
            prepared changes if it fails or you stop it.
          </p>
          {view.research && (
            <p className="mt-1 text-xs text-base-content/70" data-testid="company-research-last">
              Last research {formatDay(view.research.at)}: {view.research.status.replace('_', ' ')}, {view.research.candidates} possible claims,{' '}
              {view.research.confirmed} confirmed against their source.
            </p>
          )}

          {used.length > 0 && (
            <>
              <h4 className="mt-3 text-xs font-semibold uppercase tracking-wide">Used in letters and interview prep</h4>
              <ul className="mt-1 space-y-2">{used.map(renderFact)}</ul>
            </>
          )}
          {leads.length > 0 && (
            <>
              <h4 className="mt-3 text-xs font-semibold uppercase tracking-wide">Leads that are not used</h4>
              <ul className="mt-1 space-y-2">{leads.map(renderFact)}</ul>
            </>
          )}
          {otherRole.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium">About other roles at this company ({otherRole.length}), never used here</summary>
              <ul className="mt-1 space-y-2">{otherRole.map(renderFact)}</ul>
            </details>
          )}
          {view.facts.length === 0 && <p className="mt-3 text-xs text-base-content/70">Nothing saved for this company yet.</p>}
          {'attemptId' in target && (
            <p className="mt-3 text-xs text-base-content/70" data-testid="company-letter-uses">
              {view.lettersUsed.length === 0
                ? 'The prepared letter makes no claim about the company from these sources.'
                : `The prepared letter carries ${view.lettersUsed.length} sourced company claim${view.lettersUsed.length === 1 ? '' : 's'}: ${view.lettersUsed
                    .map((use) => `"${use.claim}" (${sourceHost(use.sourceUrl)}, observed ${formatDay(use.observedAt)})`)
                    .join('; ')}. Changing the evidence later does not change that letter.`}
            </p>
          )}

          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-medium">Add a source yourself</summary>
            <form
              className="mt-2 space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run('add', () => window.companyEvidence.addFact(target, form)).then(() =>
                  setForm((current) => ({ ...current, claim: '', sourceUrl: '', quote: '' })),
                );
              }}
            >
              <label className="block text-xs" htmlFor="company-fact-claim">
                What the source says about the company
                <input
                  aria-label="What the source says about the company"
                  id="company-fact-claim"
                  className="input input-bordered input-sm mt-1 w-full"
                  value={form.claim}
                  onChange={(event) => setForm({ ...form, claim: event.target.value })}
                />
              </label>
              <label className="block text-xs" htmlFor="company-fact-url">
                Public page address (https)
                <input
                  aria-label="Public page address (https)"
                  id="company-fact-url"
                  className="input input-bordered input-sm mt-1 w-full"
                  value={form.sourceUrl}
                  onChange={(event) => setForm({ ...form, sourceUrl: event.target.value })}
                />
              </label>
              <label className="block text-xs" htmlFor="company-fact-quote">
                A passage copied from that page (lets the app check it)
                <textarea
                  aria-label="A passage copied from that page"
                  id="company-fact-quote"
                  className="textarea textarea-bordered textarea-sm mt-1 w-full"
                  rows={2}
                  value={form.quote}
                  onChange={(event) => setForm({ ...form, quote: event.target.value })}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <label className="text-xs" htmlFor="company-fact-scope">
                  About
                  <select
                    id="company-fact-scope"
                    className="select select-bordered select-sm ml-1"
                    value={form.scope}
                    onChange={(event) => setForm({ ...form, scope: event.target.value as CompanyEvidenceScope })}
                  >
                    <option value="company">The company</option>
                    <option value="role">This role only</option>
                  </select>
                </label>
                <label className="text-xs" htmlFor="company-fact-topic">
                  Topic
                  <select
                    id="company-fact-topic"
                    className="select select-bordered select-sm ml-1"
                    value={form.topic}
                    onChange={(event) => setForm({ ...form, topic: event.target.value as CompanyEvidenceTopic })}
                  >
                    {COMPANY_EVIDENCE_TOPICS.map((topic) => (
                      <option key={topic} value={topic}>
                        {TOPIC_LABEL[topic]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button type="submit" className="btn btn-outline btn-sm" disabled={!idle || form.claim.trim().length < 8 || form.sourceUrl.trim().length < 12}>
                Save claim
              </button>
            </form>
          </details>

          {view.recordId && (
            <div className="mt-3">
              {confirmDelete ? (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm delete">
                  <span className="text-xs">Delete everything saved about {company}? Documents already prepared keep what they said.</span>
                  <button
                    type="button"
                    className="btn btn-outline btn-xs"
                    disabled={!idle}
                    onClick={() => void run('delete', () => window.companyEvidence.deleteRecord(target)).then(() => setConfirmDelete(false))}
                  >
                    Delete
                  </button>
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </button>
                </div>
              ) : (
                <button type="button" className="btn btn-ghost btn-xs" disabled={!idle} onClick={() => setConfirmDelete(true)}>
                  Delete company evidence
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
