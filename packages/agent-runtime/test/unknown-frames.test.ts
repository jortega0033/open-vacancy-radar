import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { utf8ByteLength } from '@agent-dock/shared';
import {
  checkProviderFrameBounds,
  PROVIDER_FRAME_BOUNDS,
  UnknownFrameLedger,
} from '../src/providers/common/unknown-frames.js';

describe('PROVIDER_FRAME_BOUNDS', () => {
  it('is frozen and sized for CLI output, not for negotiation payloads', () => {
    expect(Object.isFrozen(PROVIDER_FRAME_BOUNDS)).toBe(true);
    expect(PROVIDER_FRAME_BOUNDS.maxBytes).toBe(1024 * 1024);
    expect(PROVIDER_FRAME_BOUNDS.maxStringBytes).toBe(256 * 1024);
  });

  it('accepts a realistically large tool-result frame that tighter bounds would reject', () => {
    // A shell tool returning 64 KB of build output is entirely ordinary. If this were rejected,
    // the ledger would fill with false positives and stop being a usable signal.
    const frame = { type: 'item.completed', item: { output: 'x'.repeat(64 * 1024) } };
    expect(checkProviderFrameBounds(frame)).toBeUndefined();
  });

  it('reports a violation for a genuinely pathological frame', () => {
    const frame = { type: 'runaway', blob: 'x'.repeat(2 * 1024 * 1024) };
    expect(checkProviderFrameBounds(frame)).toBeTypeOf('string');
  });
});

describe('UnknownFrameLedger bounding', () => {
  it('folds 10,000 distinct unknown types into exactly maxKinds + 1 entries', () => {
    const ledger = new UnknownFrameLedger({ maxKinds: 64 });
    for (let i = 0; i < 10_000; i += 1) {
      ledger.record('unrecognized_event_type', `{"type":"weird_${i}"}`, `weird_${i}`);
    }
    // maxKinds distinct entries, plus the single per-kind overflow bucket everything else
    // collapsed into.
    expect(ledger.entries()).toHaveLength(65);

    const overflow = ledger.entries().find((entry) => entry.eventType === undefined);
    expect(overflow).toBeDefined();
    expect(overflow!.kind).toBe('unrecognized_event_type');
    // Folded, not dropped: the overflow bucket accounts for every observation beyond the cap.
    expect(overflow!.occurrences).toBe(10_000 - 64);
  });

  it('tallies the same type repeated 10,000 times as one entry with occurrences 10000', () => {
    const ledger = new UnknownFrameLedger();
    for (let i = 0; i < 10_000; i += 1) {
      ledger.record('unrecognized_event_type', '{"type":"repeat_me"}', 'repeat_me');
    }
    const entries = ledger.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.occurrences).toBe(10_000);
    expect(entries[0]!.eventType).toBe('repeat_me');
  });

  it('saturates rather than wrapping past maxObservations', () => {
    const ledger = new UnknownFrameLedger({ maxObservations: 5 });
    for (let i = 0; i < 50; i += 1) ledger.record('unparseable_line', 'garbage');
    expect(ledger.entries()[0]!.occurrences).toBe(5);
  });

  it('keeps distinct kinds of the same event type separate', () => {
    const ledger = new UnknownFrameLedger();
    ledger.record('unrecognized_event_type', '{"type":"x"}', 'x');
    ledger.record('frame_bounds_exceeded', '{"type":"x"}', 'x', 'too big');
    expect(ledger.entries()).toHaveLength(2);
  });

  it('advances lastSeenAtMs while preserving firstSeenAtMs', async () => {
    const ledger = new UnknownFrameLedger();
    ledger.record('unparseable_line', 'garbage');
    const first = ledger.entries()[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    ledger.record('unparseable_line', 'garbage');
    const second = ledger.entries()[0]!;
    expect(second.firstSeenAtMs).toBe(first.firstSeenAtMs);
    expect(second.lastSeenAtMs).toBeGreaterThanOrEqual(first.lastSeenAtMs);
  });
});

/**
 * The "no raw retention" proof.
 *
 * An unknown frame is by definition one whose contents this repo has not modelled and therefore
 * cannot claim to have sanitized — it may contain file contents, an API response, or a credential
 * a CLI echoed by mistake. The ledger is attached to a session outcome that may be logged or put
 * in a diagnostic bundle, so "the raw line is never stored" has to be a tested property, not a
 * code-reading exercise.
 */
describe('UnknownFrameLedger never retains raw content', () => {
  const SECRET = 'sk-live-51H8xQqRfExampleSecretValue';

  it('does not expose an embedded secret anywhere in the serialized entries', () => {
    const ledger = new UnknownFrameLedger();
    ledger.record(
      'unrecognized_event_type',
      `{"type":"leaky","authorization":"Bearer ${SECRET}"}`,
      'leaky',
    );
    const serialized = JSON.stringify(ledger.entries());
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('authorization');
  });

  it('does not leak content through the unparseable_line or non_object_frame paths either', () => {
    const ledger = new UnknownFrameLedger();
    ledger.record('unparseable_line', `not json at all ${SECRET}`);
    ledger.record('non_object_frame', `"${SECRET}"`);
    ledger.record('frame_bounds_exceeded', `{"blob":"${SECRET}"}`, undefined, 'value too large');
    expect(JSON.stringify(ledger.entries())).not.toContain(SECRET);
  });

  it('stores a sha256 that still correlates two reports of the same frame', () => {
    const raw = `{"type":"leaky","authorization":"Bearer ${SECRET}"}`;
    const ledger = new UnknownFrameLedger();
    ledger.record('unrecognized_event_type', raw, 'leaky');
    const entry = ledger.entries()[0]!;
    expect(entry.sha256).toBe(createHash('sha256').update(raw, 'utf8').digest('hex'));
    expect(entry.bytes).toBe(utf8ByteLength(raw));
  });

  it('gives the overflow bucket a constant hash rather than a real frame digest', () => {
    const ledger = new UnknownFrameLedger({ maxKinds: 1 });
    ledger.record('unrecognized_event_type', '{"type":"first"}', 'first');
    ledger.record('unrecognized_event_type', `{"type":"second","secret":"${SECRET}"}`, 'second');
    const overflow = ledger.entries().find((entry) => entry.eventType === undefined)!;
    expect(overflow.sha256).toBe(createHash('sha256').update('<overflow>', 'utf8').digest('hex'));
    expect(JSON.stringify(ledger.entries())).not.toContain(SECRET);
  });
});

describe('UnknownFrameLedger event type normalization', () => {
  it('truncates a 10,000-character event type to at most 128 UTF-8 bytes', () => {
    const ledger = new UnknownFrameLedger();
    ledger.record('unrecognized_event_type', '{}', 'a'.repeat(10_000));
    const eventType = ledger.entries()[0]!.eventType!;
    expect(utf8ByteLength(eventType)).toBeLessThanOrEqual(128);
    expect(eventType).toBe('a'.repeat(128));
  });

  it('stays within 128 bytes when truncation lands mid multi-byte character', () => {
    const ledger = new UnknownFrameLedger();
    // Three-byte characters do not divide 128 evenly, so the cut necessarily splits one.
    ledger.record('unrecognized_event_type', '{}', 'ページ'.repeat(1000));
    const eventType = ledger.entries()[0]!.eventType!;
    expect(utf8ByteLength(eventType)).toBeLessThanOrEqual(128);
    expect(eventType).not.toContain('�');
  });

  it('strips control characters, including NUL, CR, and ANSI escapes', () => {
    const ledger = new UnknownFrameLedger();
    // Assembled from escapes: NUL, CR, LF, and a real ANSI escape sequence. Written this way so
    // no literal control byte ever sits in this source file.
    const hostile = [
      'we',
      '\u0000',
      'ird',
      '\r',
      '\n',
      '\u001b',
      '[31m',
      '\u009c',
    ].join('');
    ledger.record('unrecognized_event_type', '{}', hostile);
    const eventType = ledger.entries()[0]!.eventType!;
    expect(eventType).toBe('weird[31m');
    for (const character of eventType) {
      const codePoint = character.codePointAt(0)!;
      expect(codePoint > 0x1f && !(codePoint >= 0x7f && codePoint <= 0x9f)).toBe(true);
    }
  });

  it('keeps a long, control-laden event type both stripped and bounded', () => {
    const ledger = new UnknownFrameLedger();
    const noisy = `\u0007${'b'.repeat(10_000)}\u0000`;
    ledger.record('unrecognized_event_type', '{}', noisy);
    const eventType = ledger.entries()[0]!.eventType!;
    expect(utf8ByteLength(eventType)).toBeLessThanOrEqual(128);
    expect(eventType).toBe('b'.repeat(128));
  });

  it('omits eventType entirely for kinds that have none', () => {
    const ledger = new UnknownFrameLedger();
    ledger.record('unparseable_line', 'garbage');
    expect('eventType' in ledger.entries()[0]!).toBe(false);
  });
});
