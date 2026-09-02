import { createHash } from 'node:crypto';

/**
 * The one implementation of "describe this content without keeping it": byte counts, SHA-256
 * digests, and UTF-8-safe truncation.
 *
 * ## Why this lives in `@agent-dock/shared` rather than beside its first caller
 *
 * ADI-05 wrote these four helpers privately inside `apps/daemon/src/persisted-session-schema.ts`,
 * where they are the mechanism behind that file's "no event content is ever written to disk" rule.
 * ADI-07 needs *exactly the same* mechanism on the other side of the app -- the desktop main
 * process sanitizes live SSE envelopes before they cross into the renderer -- and the desktop app
 * cannot import from `apps/daemon` at all (it is an application, not a package, and is not one of
 * `@agent-dock/desktop`'s dependencies).
 *
 * That left two options: a second copy of the digesting rules in `apps/desktop/electron`, or one
 * copy here that both sides import. A second copy is the worse choice by a wide margin, because
 * the two copies would be *security-relevant* and would look correct while drifting: a change to
 * how an unserializable value is digested, or to how a multi-byte character is truncated, would
 * silently apply to only one of the two redaction boundaries. So the daemon's private helpers were
 * moved here verbatim (behavior unchanged, its tests unchanged) and it now imports them.
 *
 * Nothing here is renderer-safe: `node:crypto` and `Buffer` are Node APIs. Both callers are Node
 * processes (the daemon, and Electron's main/preload), which is the boundary this module is for.
 */

/** UTF-8 byte length, the unit every cap in this repo is expressed in. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Truncates on the UTF-8 byte sequence, then drops a trailing partial character.
 *
 * Slicing bytes can cut a multi-byte character in half, which decodes to U+FFFD -- itself three
 * bytes, which can push the result back over the budget. Dropping the last code unit in that case
 * keeps the guarantee the caller actually needs ("never more than N bytes") rather than an
 * approximate one.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return utf8Bytes(cut) <= maxBytes ? cut : cut.slice(0, -1);
}

/** A content-free description of some content: how much of it there was, and what it was. */
export interface ContentDigest {
  bytes: number;
  sha256: string;
}

/**
 * The canonical string form of an `unknown` payload (`tool.started.input`,
 * `tool.completed.result`), used only as hash input and never stored.
 *
 * A value that cannot be serialized (circular, a BigInt) still needs *some* stable digest, because
 * silently omitting the pair would make "this tool produced nothing" and "this tool produced
 * something we could not encode" indistinguishable. The sentinel is a constant, so it leaks
 * nothing while remaining recognizable.
 */
export const UNSERIALIZABLE_SENTINEL = '<unserializable>';

export function digestOfUnknown(value: unknown): ContentDigest {
  let text: string;
  try {
    const encoded = JSON.stringify(value);
    text = encoded === undefined ? UNSERIALIZABLE_SENTINEL : encoded;
  } catch {
    text = UNSERIALIZABLE_SENTINEL;
  }
  return { bytes: utf8Bytes(text), sha256: sha256OfText(text) };
}

export function digestOfText(text: string): ContentDigest {
  return { bytes: utf8Bytes(text), sha256: sha256OfText(text) };
}
