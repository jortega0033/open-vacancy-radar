import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UNSERIALIZABLE_SENTINEL, digestAndPreviewOfUnknown } from '../src/content-digest.js';

/**
 * `digestAndPreviewOfUnknown` (ADI-29): a digest plus a bounded preview, from one serialization
 * pass. `session-manager.ts` relies on `preview` being the *complete* content whenever `bytes` is
 * within `maxPreviewBytes` -- that is what lets it hand `preview` straight to the attachment store
 * as the full retained content, not a second, separately-computed encoding.
 */

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('digestAndPreviewOfUnknown', () => {
  it('returns the whole content as the preview when it fits under the bound, matching the real digest', () => {
    const value = { command: 'ls', exitCode: 0 };
    const encoded = JSON.stringify(value);
    const result = digestAndPreviewOfUnknown(value, 1_000);

    expect(result.bytes).toBe(Buffer.byteLength(encoded, 'utf8'));
    expect(result.sha256).toBe(sha256(encoded));
    expect(result.preview).toBe(encoded);
    expect(result.previewTruncated).toBe(false);
  });

  it('truncates the preview, but the digest still describes the full original content', () => {
    const value = { output: 'x'.repeat(1_000) };
    const encoded = JSON.stringify(value);
    const result = digestAndPreviewOfUnknown(value, 100);

    expect(result.bytes).toBe(Buffer.byteLength(encoded, 'utf8'));
    expect(result.sha256).toBe(sha256(encoded)); // hashes the ORIGINAL, not the truncated preview
    expect(Buffer.byteLength(result.preview, 'utf8')).toBeLessThanOrEqual(100);
    expect(result.previewTruncated).toBe(true);
    expect(encoded.startsWith(result.preview)).toBe(true);
  });

  it('previews a plain string as itself, not as a JSON-quoted, backslash-escaped copy', () => {
    const value = 'line1\nline2\n';
    const result = digestAndPreviewOfUnknown(value, 1_000);

    // `bytes`/`sha256` stay keyed to the JSON-encoded form (matching `digestOfUnknown`'s encoding
    // of the same value for the persisted digest), but `preview` is the raw, readable text -- not
    // `"line1\\nline2\\n"` with literal quotes and escaped newlines.
    const encoded = JSON.stringify(value);
    expect(result.bytes).toBe(Buffer.byteLength(encoded, 'utf8'));
    expect(result.sha256).toBe(sha256(encoded));
    expect(result.preview).toBe(value);
    expect(result.previewTruncated).toBe(false);
  });

  it('truncates a plain string preview against its own raw length, not the JSON-encoded one', () => {
    const value = 'x'.repeat(1_000);
    const result = digestAndPreviewOfUnknown(value, 100);

    expect(Buffer.byteLength(result.preview, 'utf8')).toBeLessThanOrEqual(100);
    expect(result.previewTruncated).toBe(true);
    expect(value.startsWith(result.preview)).toBe(true);
  });

  it('never splits a multi-byte character across the preview boundary', () => {
    const value = '😀'.repeat(50); // each emoji is 4 UTF-8 bytes
    const result = digestAndPreviewOfUnknown(value, 21); // not a multiple of 4
    expect(Buffer.byteLength(result.preview, 'utf8')).toBeLessThanOrEqual(21);
    expect(result.preview).not.toContain('�');
  });

  it('digests an unserializable value (circular reference) to the constant sentinel', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = digestAndPreviewOfUnknown(circular, 1_000);
    expect(result.sha256).toBe(sha256(UNSERIALIZABLE_SENTINEL));
    expect(result.preview).toBe(UNSERIALIZABLE_SENTINEL);
    expect(result.previewTruncated).toBe(false);
  });

  it('treats undefined the same way digestOfUnknown does -- the sentinel, not an empty string', () => {
    const result = digestAndPreviewOfUnknown(undefined, 1_000);
    expect(result.preview).toBe(UNSERIALIZABLE_SENTINEL);
  });
});
