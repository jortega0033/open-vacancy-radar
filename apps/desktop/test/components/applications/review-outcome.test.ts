import { describe, expect, it } from 'vitest';
import {
  alreadySentFailure,
  describeSubmitRefusal,
  notSentFailure,
  toSentence,
  unconfirmedFailure,
} from '../../../src/components/applications/review-outcome.js';

describe('review outcome wording (#468)', () => {
  it('turns a lowercase error fragment into a sentence', () => {
    expect(toSentence('could not skip this attempt')).toBe('Could not skip this attempt.');
    expect(toSentence('Already a sentence.')).toBe('Already a sentence.');
    expect(toSentence('   ')).toBe('');
  });

  it('says not sent for a refusal raised before the submit control was clicked', () => {
    const failure = describeSubmitRefusal({ reason: 'form_not_ready', detail: 'Email is empty' });
    expect(failure.outcome).toBe('not_sent');
    expect(failure.message).toBe('Not sent. The form still has checks to finish.');
    expect(failure.detail).toBe('Email is empty');
  });

  it.each(['captcha_detected', 'submit_refused', 'submission_rejected', 'company_not_found_in_documents'] as const)(
    'treats %s as not sent',
    (reason) => {
      expect(describeSubmitRefusal({ reason }).outcome).toBe('not_sent');
    },
  );

  it.each(['submission_unknown', 'submission_outcome_unresolved', 'already_submitting', 'already_submitted'] as const)(
    'treats %s as could not be confirmed',
    (reason) => {
      const failure = describeSubmitRefusal({ reason });
      expect(failure.outcome).toBe('unconfirmed');
      expect(failure.message).toBe(
        'We could not confirm whether this was sent. Check the employer site before trying again.',
      );
    },
  );

  it('never calls a missing or unknown reason not sent', () => {
    expect(describeSubmitRefusal({}).outcome).toBe('unconfirmed');
    expect(describeSubmitRefusal({ reason: 'a_future_reason' as never }).outcome).toBe('unconfirmed');
  });

  it('builds the other two outcomes with fixed sentence-case wording and no em dash', () => {
    expect(notSentFailure('we could not open the live page', '  ').detail).toBeUndefined();
    expect(unconfirmedFailure('page closed').detail).toBe('page closed');
    const sent = alreadySentFailure();
    expect(sent.outcome).toBe('sent');
    for (const text of [sent.message, notSentFailure('x').message, unconfirmedFailure().message]) {
      expect(text).not.toContain('—');
    }
  });
});
