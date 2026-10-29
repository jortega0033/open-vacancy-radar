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
  user_domain: 'a website you confirmed for this vacancy',
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

/** Network failures only: a claim the quote floor refused was never fetched, and its reason is listed above. */
const UNREACHABLE_REASONS = new Set(['timeout', 'blocked', 'not_found', 'fetch_failed', 'not_text', 'cancelled']);

function lastCheckText(fact: ClassifiedFact): string | null {
  if (!fact.lastRefreshOutcome || fact.lastRefreshOutcome === 'renewed') return null;
  if (fact.lastRefreshOutcome === 'cache_hit') return 'Still current, so the source was not fetched again.';
  if (fact.lastRefreshReason === 'quote_context_unsupported') {
    return 'On the page, this passage is part of a longer sentence, or next to wording on the same subject (such as "only", "except" or "but not"), that the claim leaves out.';
  }
  if (fact.lastRefreshOutcome === 'source_changed') return 'The last check no longer found this passage on the source page.';
  if (fact.lastRefreshReason === 'quote_not_found') return 'The quoted passage was not found on the source page.';
  if (fact.lastRefreshReason === 'content_too_large') return 'The source page is too large to check safely, so it was not used.';
  if (UNREACHABLE_REASONS.has(fact.lastRefreshReason ?? '')) return 'The last check could not reach the source, so the dates above did not change.';
  return null;
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
 * app last observed it and why it is, or is not, usable. A claim is "Usable" (eligible) only while
 * its quoted passage was found on its page and the claim repeats one whole sentence of it with nothing
 * nearby limiting it (or the person confirmed the source says it), it is current, nothing disagrees with
 * it and it fits this role. "Used" is reserved
 * for what a prepared letter actually carried (its snapshot), never for mere eligibility.
 *
 * Nothing here runs by itself: reading shows what is stored, and every network action (research,
 * checking sources) is a button with a Stop button beside it. Closing the panel stops an action it
 * started. A stopped or failed action leaves the saved evidence and every prepared draft as they were.
 */
export function CompanyEvidencePanel({ target, reloadKey, onChanged }: CompanyEvidencePanelProps) {
  const [view, setView] = useState<CompanyEvidenceView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [domain, setDomain] = useState('');
  const [entityRef, setEntityRef] = useState('');
  const [editing, setEditing] = useState<{ id: string; claim: string; quote: string } | null>(null);
  /** The fact whose one-step "the source says this" attestation is open. */
  const [attesting, setAttesting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState({ claim: '', sourceUrl: '', quote: '', scope: 'company' as CompanyEvidenceScope, topic: 'general' as CompanyEvidenceTopic });
  const mounted = useRef(true);
  const targetKey = 'attemptId' in target ? `a:${target.attemptId}` : `p:${target.applicationId}`;
  /** The long-running action THIS panel started (research / refresh), so closing it can stop it. */
  const ownedRun = useRef<CompanyEvidenceTargetInput | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const owned = ownedRun.current;
      ownedRun.current = null;
      // Work the person can no longer see is stopped, not left running out of sight.
      if (owned && typeof window.companyEvidence?.cancel === 'function') {
        void window.companyEvidence.cancel(owned).catch(() => undefined);
      }
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
      const long = name === 'research' || name === 'refresh';
      if (long) ownedRun.current = target;
      try {
        accept(await action(), changed);
      } catch {
        if (mounted.current) setError('That did not work. Nothing was changed.');
      } finally {
        if (long) ownedRun.current = null;
        if (mounted.current) setBusy(null);
      }
    },
    [accept, target],
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
            {fact.support === 'supported' ? 'Usable' : 'Lead only'}
          </span>
          <span className="badge badge-sm badge-outline">{scopeLabel(fact)}</span>
          <span className="badge badge-sm badge-outline">{TOPIC_LABEL[fact.topic]}</span>
          <span className="badge badge-sm badge-outline">
            {fact.verification === 'source_confirmed'
              ? 'Quoted passage found'
              : fact.verification === 'user_confirmed'
                ? 'You confirmed'
                : 'Not confirmed'}
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
        {lastCheckText(fact) && <p className="mt-1 text-xs text-base-content/70">{lastCheckText(fact)}</p>}
        {fact.quote && <p className="mt-1 break-words text-xs text-base-content/70">Saved passage: &ldquo;{fact.quote}&rdquo;</p>}
        {fact.correction && (
          <p className="mt-1 break-words text-xs text-base-content/70">
            You corrected this on {formatDay(fact.correction.correctedAt)}. It first read: {fact.correction.originalClaim}
            {fact.correction.originalQuote
              ? ` (its passage is kept for the record but no longer supports it: "${fact.correction.originalQuote}")`
              : ''}
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
                  onChange={(event) => setEditing({ ...editing, claim: event.target.value })}
                />
                <textarea
                  aria-label="Passage from the page that says the corrected wording (optional)"
                  className="textarea textarea-bordered textarea-sm w-full"
                  rows={2}
                  placeholder="Optional: copy the passage that says the corrected wording, so the app can check it"
                  value={editing.quote}
                  onChange={(event) => setEditing({ ...editing, quote: event.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-primary btn-xs"
                  disabled={!idle}
                  onClick={() =>
                    void run('correct', () =>
                      window.companyEvidence.correctFact(
                        target,
                        fact.id,
                        editing.claim,
                        editing.quote.trim() === '' ? undefined : editing.quote,
                      ),
                    ).then(() => setEditing(null))
                  }
                >
                  Save correction
                </button>
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                {fact.verification !== 'user_confirmed' && fact.sourceKind !== 'ind_register' && attesting !== fact.id && (
                  <button type="button" className="btn btn-outline btn-xs" disabled={!idle} onClick={() => setAttesting(fact.id)}>
                    The source says this&hellip;
                  </button>
                )}
                <button type="button" className="btn btn-ghost btn-xs" disabled={!idle} onClick={() => setEditing({ id: fact.id, claim: fact.claim, quote: '' })}>
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
        {attesting === fact.id && !isEditing && (
          <div className="mt-2 rounded-box border border-warning/60 p-2 text-xs" role="group" aria-label="Confirm what the source says" data-testid="company-fact-attest">
            <p className="break-words">
              Only confirm this if you opened {sourceHost(fact.sourceUrl)} yourself and it says exactly: &ldquo;{fact.claim}&rdquo;
            </p>
            {fact.reasons.some((reason) => reason !== 'unverified') && (
              <p className="mt-1 break-words">
                The app did not use it automatically:{' '}
                {fact.reasons
                  .filter((reason) => reason !== 'unverified')
                  .map((reason) => LEAD_REASON_TEXT[reason])
                  .join(' ')}
              </p>
            )}
            <p className="mt-1 text-base-content/70">
              It is then marked &ldquo;You confirmed&rdquo; (your statement, not a check by the app). Sponsorship still needs the
              employer&apos;s own page about this role.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-warning btn-xs"
                disabled={!idle}
                onClick={() =>
                  void run('confirm', () => window.companyEvidence.confirmFact(target, fact.id)).then(() => setAttesting(null))
                }
              >
                I read {sourceHost(fact.sourceUrl)} and it says this
              </button>
              <button type="button" className="btn btn-ghost btn-xs" onClick={() => setAttesting(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <section aria-label="Company evidence" data-testid="company-evidence" data-state={view.state} className="rounded-box border border-base-300 p-3 text-sm">
      <h3 className="font-semibold">Company evidence</h3>
      <p className="mt-0.5 text-xs text-base-content/70">
        Public facts about this employer, kept apart from your CV. Only two things use them: the cover letter this app prepares
        for an application, and the &ldquo;Prepare interview&rdquo; prompt. The Letters page and the CV assistant do not. A claim
        is usable only while its quoted passage was found on its page and the claim repeats one whole sentence of it, with nothing
        on the page next to it limiting it (or you confirmed the source says it), it is current, nothing disagrees with it and it
        fits this role. That checks the wording only; it does not prove the page or the claim is right. Everything else is a lead.
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
            We cannot tell which employer this is from the posting alone, and a name or a register match is not enough. Enter the
            employer&apos;s own website to start a record for this vacancy (not a job board, recruiting system or hosting site:
            every page on the address you confirm counts as the employer&apos;s own). Another vacancy with the same name is not
            affected.
          </p>
          {view.suggestions.length > 0 && (
            <ul className="mt-2 space-y-1" data-testid="company-domain-suggestions">
              {view.suggestions.map((suggestion) => (
                <li key={suggestion.domain} className="flex flex-wrap items-center gap-2 text-xs">
                  <span>
                    {suggestion.domain} (
                    {suggestion.basis === 'posting_domain'
                      ? "the domain of this posting. It may be a job site or a hosting service: use it only if it is the employer's own website"
                      : 'you confirmed it for another vacancy with this name'}
                    )
                  </span>
                  <button type="button" className="btn btn-ghost btn-xs" disabled={!idle} onClick={() => setDomain(suggestion.domain)}>
                    Use this address
                  </button>
                </li>
              ))}
            </ul>
          )}
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
            <label className="sr-only" htmlFor="company-evidence-entity">
              Registration number or legal name (optional)
            </label>
            <input
              aria-label="Registration number or legal name (optional)"
              id="company-evidence-entity"
              className="input input-bordered input-sm min-w-0 flex-1"
              placeholder="Optional: registration number or legal name"
              value={entityRef}
              onChange={(event) => setEntityRef(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!idle || domain.trim().length < 3}
              onClick={() =>
                void run('domain', () =>
                  window.companyEvidence.confirmDomain(target, { domain, ...(entityRef.trim() ? { entityRef } : {}) }),
                )
              }
            >
              Confirm website
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-2 text-xs text-base-content/70" data-testid="company-identity">
            Identified by {IDENTITY_BASIS_LABEL[view.identity.keyKind ?? 'ats_tenant']}
            {view.identity.tenant
              ? ` (${view.identity.tenant.provider} board "${view.identity.tenant.board}"; the employer's own website is not known)`
              : view.identity.host
                ? ` (${view.identity.host})`
                : ''}
            {view.entityRef ? `, entity reference ${view.entityRef}` : ''}. {view.supportedCount} usable, {view.leadCount} leads.
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
            Research searches the public web for facts about this employer only and takes up to about 90 seconds: one web session
            of up to 60 seconds, then up to 30 seconds checking the pages it cites. Your CV, letters and notes are never sent. The
            session&apos;s searches are counted as they happen and it is stopped, with its results discarded, if it goes over its
            budget; a search that has already started cannot be prevented. Nothing prepared changes if it fails or you stop it, and
            closing this panel stops it.
          </p>
          {view.research && (
            <p className="mt-1 text-xs text-base-content/70" data-testid="company-research-last">
              Last research {formatDay(view.research.at)}: {view.research.status.replace('_', ' ')}, {view.research.candidates} possible claims,{' '}
              {view.research.confirmed} confirmed against their source.
            </p>
          )}

          {used.length > 0 && (
            <>
              <h4 className="mt-3 text-xs font-semibold uppercase tracking-wide">Usable in the prepared letter and interview prep</h4>
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
                : `Used in the prepared letter: ${view.lettersUsed.length} sourced company claim${view.lettersUsed.length === 1 ? '' : 's'}: ${view.lettersUsed
                    .map(
                      (use) =>
                        `"${use.claim}" (${sourceHost(use.sourceUrl)}, observed ${formatDay(use.observedAt)}${use.verification === 'user_confirmed' ? ', you confirmed it; the app did not check its wording' : ''})`,
                    )
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
                  <span className="text-xs">
                    Delete everything saved about {view.identity.displayName}? Documents already prepared keep what they said.
                  </span>
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
