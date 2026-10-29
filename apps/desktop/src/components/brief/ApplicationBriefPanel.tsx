import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ApplicationBriefView,
  BriefRequirementItem,
  BriefTargetInput,
  EligibilityItem,
} from '../../../electron/application-brief.js';
import { discoveryProviderLabel } from '../../discovery-provider-labels.js';
import { Eyebrow } from '../shell/Eyebrow.js';
import {
  ASSESSMENT_HEADLINE,
  BRIEF_INTRO,
  CLASSIFICATION_LABEL,
  ELIGIBILITY_EXPLAIN,
  ELIGIBILITY_HEADLINE,
  GROUP_FIELD_LABEL,
  MISSING_ASSESSMENT_NOTE,
  POSTING_HEADLINE,
  PREFERENCE_NOTE,
  formatDay,
  isHttpUrl,
} from './brief-text.js';

export interface ApplicationBriefPanelProps {
  /** The saved job or the preparation attempt this brief describes. Main re-derives everything else. */
  target: BriefTargetInput;
  /** Changes whenever the surrounding record changes, so the stored brief is read again. */
  reloadKey?: string | number;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; view: ApplicationBriefView };

function targetKey(target: BriefTargetInput): string {
  return 'savedJobId' in target ? `job-${target.savedJobId}` : `application-${target.attemptId}`;
}

/**
 * Reads the stored brief. A response for a target the panel has since moved away from (or after it
 * unmounted) is dropped, so a slow read can never paint another job's brief.
 */
function useBrief(target: BriefTargetInput, reloadKey: string | number | undefined) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const generation = useRef(0);
  const key = targetKey(target);
  const targetRef = useRef(target);
  targetRef.current = target;

  const load = useCallback(async () => {
    const mine = (generation.current += 1);
    if (typeof window.applicationBrief?.get !== 'function') {
      // A bridge from an older build: say nothing rather than fail the surrounding screen.
      setState({ status: 'error', message: '' });
      return;
    }
    try {
      const result = await window.applicationBrief.get(targetRef.current);
      if (mine !== generation.current) return;
      setState(result.ok ? { status: 'ready', view: result.view } : { status: 'error', message: result.message });
    } catch {
      if (mine === generation.current) setState({ status: 'error', message: 'We could not load this brief.' });
    }
  }, []);

  useEffect(() => {
    setState({ status: 'loading' });
    void load();
    return () => {
      generation.current += 1;
    };
  }, [key, reloadKey, load]);

  return { state, reload: load };
}

function Section({ title, children, badge }: { title: string; children: ReactNode; badge?: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow as="h4">{title}</Eyebrow>
        {badge}
      </div>
      {children}
    </section>
  );
}

function Pill({ tone, children }: { tone: 'neutral' | 'info' | 'success' | 'warning' | 'error'; children: ReactNode }) {
  const cls = {
    neutral: 'badge-neutral',
    info: 'badge-info',
    success: 'badge-success',
    warning: 'badge-warning',
    error: 'badge-error',
  }[tone];
  return <span className={`badge badge-soft badge-sm ${cls}`}>{children}</span>;
}

function RequirementList({ items, empty }: { items: readonly BriefRequirementItem[]; empty: string }) {
  if (items.length === 0) return <p className="text-xs text-base-content/60">{empty}</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map((item) => (
        <li key={item.requirementId}>
          <span className="font-medium">{item.text}</span>{' '}
          <span className="text-xs text-base-content/60">({CLASSIFICATION_LABEL[item.classification]})</span>
          <div className="text-xs text-base-content/60">
            {item.evidenceLabel ? `Evidence: ${item.evidenceLabel}` : 'No CV entry is linked to this yet.'}
            {item.jdAnchor ? ` · From the posting: “${item.jdAnchor}”` : ''}
          </div>
        </li>
      ))}
    </ul>
  );
}

function EligibilityRow({ item }: { item: EligibilityItem }) {
  return (
    <li className="text-sm">
      <span>{item.label}</span> <span className="font-medium">{item.summary}</span>
      {item.detail && <div className="text-xs text-base-content/70">{item.detail}</div>}
      <div className="text-xs text-base-content/60">
        Source: {item.source.replace(/_/gu, ' ') || 'not stated'} · about {item.scope.replace(/_/gu, ' ') || 'unknown'}
        {item.observedAt ? ` · seen ${formatDay(item.observedAt)}` : ' · no date'}
        {item.freshness ? ` (${item.freshness})` : ''}
      </div>
    </li>
  );
}

function PreferenceCorrection({
  groups,
  onSaved,
}: {
  groups: readonly string[];
  onSaved: () => void;
}) {
  const [country, setCountry] = useState('');
  const [languages, setLanguages] = useState('');
  const [relocation, setRelocation] = useState<'' | 'yes' | 'no'>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function save() {
    const correction: { primaryCountry?: string; professionalLanguage?: string; relocationWilling?: boolean } = {};
    if (groups.includes('location') && country.trim()) correction.primaryCountry = country.trim();
    if (groups.includes('languages') && languages.trim()) correction.professionalLanguage = languages.trim();
    if (groups.includes('relocation') && relocation) correction.relocationWilling = relocation === 'yes';
    if (Object.keys(correction).length === 0) {
      setError('Fill in at least one answer first.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.applicationBrief.correctPreference(correction);
      if (!result.ok) setError(result.message);
      else onSaved();
    } catch {
      setError('Your preference could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-box border border-base-300 bg-base-200 p-2.5 text-sm" aria-label="Correct my preferences">
      <p className="text-xs text-base-content/70">{PREFERENCE_NOTE}</p>
      <div className="mt-2 grid gap-2">
        {groups.includes('location') && (
          <label className="block text-xs">
            {GROUP_FIELD_LABEL.location}
            <input className="input input-sm mt-0.5 w-full" aria-label={GROUP_FIELD_LABEL.location} value={country} onChange={(e) => setCountry(e.target.value)} />
          </label>
        )}
        {groups.includes('languages') && (
          <label className="block text-xs">
            {GROUP_FIELD_LABEL.languages}
            <input className="input input-sm mt-0.5 w-full" aria-label={GROUP_FIELD_LABEL.languages} value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="e.g. English, Dutch" />
          </label>
        )}
        {groups.includes('relocation') && (
          <label className="block text-xs">
            {GROUP_FIELD_LABEL.relocation}
            <select className="select select-sm mt-0.5 w-full" aria-label={GROUP_FIELD_LABEL.relocation} value={relocation} onChange={(e) => setRelocation(e.target.value as '' | 'yes' | 'no')}>
              <option value="">No answer</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
        )}
      </div>
      {error && (
        <p className="mt-1 text-xs text-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn btn-outline btn-xs mt-2" disabled={busy} onClick={() => void save()}>
        Save my preference
      </button>
    </div>
  );
}

/**
 * The compact decision brief for one job (#688), mounted inside the screens the person already uses
 * (the saved-job drawer and the application drawer). Not a page of its own. Reading it never starts a
 * model session or a request; the only AI in this feature is the explicit "Assess selected jobs" action
 * on the Saved jobs page.
 *
 * Four things are kept visibly apart: the Search score (deterministic, from the scan), the assessment
 * against your CV (which may not exist yet), your own readiness, and what was actually sent.
 */
export function ApplicationBriefPanel({ target, reloadKey }: ApplicationBriefPanelProps) {
  const { state, reload } = useBrief(target, reloadKey);
  if (state.status === 'loading') {
    return (
      <section aria-label="Application brief" aria-busy="true" className="rounded-box border border-base-300 p-3.5 text-sm text-base-content/60">
        Loading the brief…
      </section>
    );
  }
  if (state.status === 'error') {
    return state.message ? (
      <section aria-label="Application brief" className="rounded-box border border-base-300 p-3.5 text-sm text-error" role="alert">
        {state.message}
      </section>
    ) : null;
  }
  const { view } = state;
  const { relevance, eligibility, assessment, readiness, postingCheck, companyEvidence, submission } = view;
  const groups = ['known_mismatch', 'uncertain', 'informational', 'consistent'] as const;

  return (
    <section aria-label="Application brief" className="space-y-4 rounded-box border border-base-300 p-3.5">
      <div>
        <Eyebrow as="h3">Application brief</Eyebrow>
        <p className="mt-0.5 text-xs text-base-content/60">{BRIEF_INTRO}</p>
      </div>

      {view.notices.length > 0 && (
        <div className="rounded-box bg-base-200 p-2.5 text-xs" role="status" aria-label="What changed">
          <div className="font-semibold">What changed</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {view.notices.slice(0, 4).map((notice) => (
              <li key={`${notice.at}-${notice.text}`}>
                {notice.text} <span className="text-base-content/60">({formatDay(notice.at)})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Section
        title="Why consider it"
        badge={relevance.status === 'stale' ? <Pill tone="warning">Out of date</Pill> : relevance.status === 'not_scored' ? <Pill tone="neutral">Not scored</Pill> : undefined}
      >
        {relevance.score === null ? (
          <p className="text-sm text-base-content/70">{relevance.reason}</p>
        ) : (
          <>
            <p className="text-sm">
              <span className="font-semibold">Search score {relevance.score} out of 100</span>{' '}
              <span className="text-xs text-base-content/60">
                · {relevance.provenance}. Based on what you are looking for. It does not compare your CV.
              </span>
            </p>
            {relevance.fits && (
              <p className="text-xs text-base-content/60">
                Technical {relevance.fits.technical} · Role {relevance.fits.role} · Seniority {relevance.fits.seniority}
              </p>
            )}
            {relevance.reason && <p className="text-xs">{relevance.reason}</p>}
            {relevance.signals.length > 0 && (
              <p className="text-sm">
                <span className="font-medium">Matches what you are looking for:</span> {relevance.signals.join(', ')}
              </p>
            )}
            {relevance.caveats.length > 0 && (
              <p className="text-sm">
                <span className="font-medium">Score gaps and caps:</span> {relevance.caveats.join('; ')}
              </p>
            )}
            {relevance.unmetMandatoryLanguages.length > 0 && (
              <p className="text-sm font-medium">Known mismatch: needs {relevance.unmetMandatoryLanguages.join(', ')}.</p>
            )}
          </>
        )}
      </Section>

      <Section
        title="Can you take this job?"
        badge={eligibility.status === 'stale' ? <Pill tone="warning">Out of date</Pill> : undefined}
      >
        {eligibility.items.length === 0 ? (
          <p className="text-sm text-base-content/70">{eligibility.reason}</p>
        ) : (
          <>
            {eligibility.reason && <p className="text-xs">{eligibility.reason}</p>}
            {groups.map((classification) => {
              const items = eligibility.items.filter((item) => item.classification === classification);
              if (items.length === 0) return null;
              return (
                <div key={classification}>
                  <div className="text-xs font-semibold">
                    {ELIGIBILITY_HEADLINE[classification]} ({items.length}){' '}
                    <span className="font-normal text-base-content/60">{ELIGIBILITY_EXPLAIN[classification]}</span>
                  </div>
                  <ul className="mt-1 space-y-1.5">
                    {items.map((item) => (
                      <EligibilityRow key={item.key} item={item} />
                    ))}
                  </ul>
                </div>
              );
            })}
            {eligibility.correctable.length > 0 && <PreferenceCorrection groups={eligibility.correctable} onSaved={() => void reload()} />}
          </>
        )}
      </Section>

      <Section
        title="Strengths and gaps against your CV"
        badge={
          <Pill tone={assessment.state === 'current' ? 'success' : assessment.state === 'stale' || assessment.state === 'partial' ? 'warning' : 'neutral'}>
            {ASSESSMENT_HEADLINE[assessment.state]}
          </Pill>
        }
      >
        {assessment.state === 'missing' && <p className="text-sm text-base-content/70">{MISSING_ASSESSMENT_NOTE}</p>}
        {assessment.reason && <p className="text-sm text-base-content/70">{assessment.reason}</p>}
        {assessment.summary && (
          <div className="space-y-2">
            {assessment.state === 'stale' && <p className="text-xs font-semibold">Earlier result (it may no longer apply):</p>}
            <div>
              <div className="text-xs font-semibold">Strengths backed by your CV</div>
              <RequirementList items={assessment.summary.strengths} empty="No requirement is backed by a CV entry yet." />
            </div>
            <div>
              <div className="text-xs font-semibold">Material gaps</div>
              <RequirementList items={assessment.summary.gaps} empty="No material gap found in what was read." />
            </div>
            <div>
              <div className="text-xs font-semibold">Still to check</div>
              <RequirementList items={assessment.summary.openQuestions} empty="Nothing waiting on you." />
            </div>
          </div>
        )}
      </Section>

      <Section title="Your readiness">
        <p className="text-sm">
          {readiness.cv === 'ready' && `Your CV “${readiness.cvName}” has reviewed source details.`}
          {readiness.cv === 'cv_not_reviewed' && `Your CV “${readiness.cvName}” has not had its source details reviewed yet.`}
          {readiness.cv === 'no_cv' && 'You have no CV yet.'}
        </p>
        {readiness.notes.map((note) => (
          <p key={note} className="text-xs text-base-content/70">
            {note}
          </p>
        ))}
      </Section>

      <Section title="Posting and deadline" badge={<Pill tone={postingCheck.status === 'confirmed_open' ? 'success' : postingCheck.status === 'not_checked' || postingCheck.status === 'not_applicable' ? 'neutral' : 'warning'}>{POSTING_HEADLINE[postingCheck.status]}</Pill>}>
        <p className="text-xs text-base-content/70">{postingCheck.note}</p>
        {postingCheck.checkedAt && (
          <p className="text-xs text-base-content/60">
            Checked {formatDay(postingCheck.checkedAt)}
            {postingCheck.stale ? '. That is a while ago, so it will be checked again when you prepare.' : '.'}
          </p>
        )}
        {postingCheck.deadline && (
          <p className="text-sm">
            Deadline stated by the posting: <span className="font-medium">{postingCheck.deadline.date}</span>{' '}
            <span className="text-xs text-base-content/60">“{postingCheck.deadline.excerpt}”</span>
          </p>
        )}
        {postingCheck.noDeadlineStated && <p className="text-xs text-base-content/60">The posting states no deadline.</p>}
      </Section>

      <Section title="Company evidence">
        <p className="text-xs text-base-content/70">{companyEvidence.note}</p>
        {companyEvidence.facts.length > 0 && (
          <ul className="space-y-1.5 text-sm">
            {companyEvidence.facts.map((fact) => (
              <li key={`${fact.sourceUrl}-${fact.claim}`}>
                {fact.claim}{' '}
                <Pill tone={fact.state === 'current' ? 'success' : fact.state === 'expired' ? 'warning' : 'neutral'}>
                  {fact.state === 'current' ? 'Current' : fact.state === 'expired' ? 'Out of date' : 'Not confirmed'}
                </Pill>
                <div className="text-xs text-base-content/60">
                  {isHttpUrl(fact.sourceUrl) ? (
                    <a className="link" href={fact.sourceUrl} target="_blank" rel="noopener noreferrer">
                      {fact.sourceUrl}
                    </a>
                  ) : (
                    fact.sourceUrl
                  )}{' '}
                  · {fact.retrievedAt ? `retrieved ${formatDay(fact.retrievedAt)}` : 'never fetched'} · expires {formatDay(fact.expiresAt)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Sent so far">
        {submission.attempts.length === 0 ? (
          <p className="text-sm text-base-content/70">Nothing has been prepared or sent for this job.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {submission.attempts.map((attempt) => (
              <li key={attempt.attemptId}>
                {attempt.label}{' '}
                <span className="text-xs text-base-content/60">
                  · {formatDay(attempt.submittedAt ?? attempt.createdAt)}
                  {attempt.receipts > 0 ? ` · ${attempt.receipts} receipt${attempt.receipts === 1 ? '' : 's'}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {view.pin && (
        <details className="rounded-box border border-base-300 p-2.5 text-sm">
          <summary className="cursor-pointer font-medium">What you knew when you started preparing</summary>
          <div className="mt-2 space-y-1 text-xs">
            <p>Kept as it was on {formatDay(view.pin.pinnedAt)}. It does not change when the job or your CV does.</p>
            <p>
              Search score: {view.pin.snapshot.relevance.score === null ? 'not scored' : `${view.pin.snapshot.relevance.score} out of 100`}
              {view.pin.snapshot.relevance.provenance ? ` (${view.pin.snapshot.relevance.provenance})` : ''}
            </p>
            {view.pin.snapshot.eligibility.knownMismatch.length > 0 && <p>Known mismatch: {view.pin.snapshot.eligibility.knownMismatch.join('; ')}</p>}
            {view.pin.snapshot.eligibility.uncertain.length > 0 && <p>Not known yet: {view.pin.snapshot.eligibility.uncertain.join('; ')}</p>}
            <p>Assessment then: {ASSESSMENT_HEADLINE[view.pin.snapshot.assessment.state]}</p>
            {view.pin.snapshot.assessment.strengths.length > 0 && <p>Strengths: {view.pin.snapshot.assessment.strengths.join('; ')}</p>}
            {view.pin.snapshot.assessment.gaps.length > 0 && <p>Gaps: {view.pin.snapshot.assessment.gaps.join('; ')}</p>}
            <p>Posting then: {POSTING_HEADLINE[view.pin.snapshot.posting.status]}</p>
          </div>
        </details>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer font-medium">Where this came from ({view.sources.length})</summary>
        <ul className="mt-1.5 space-y-1 text-xs">
          {view.sources.map((source) => (
            <li key={source.aliasKey}>
              <span className="font-medium">{source.provider ? discoveryProviderLabel(source.provider) : source.label || 'Source'}</span>
              {' · '}
              {isHttpUrl(source.url) ? (
                <a className="link break-all" href={source.url} target="_blank" rel="noopener noreferrer">
                  {source.url}
                </a>
              ) : (
                'no link'
              )}
              <span className="text-base-content/60"> · first seen {formatDay(source.firstSeenAt)}</span>
            </li>
          ))}
          {view.sources.length === 0 && <li className="text-base-content/60">No source link is stored for this job.</li>}
        </ul>
        <p className="mt-1.5 text-xs text-base-content/60">
          Every copy of this job found by Search shares this one brief. Identity: {view.identity.kind.replace(/_/gu, ' ')}.
        </p>
      </details>
    </section>
  );
}
