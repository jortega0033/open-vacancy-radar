import { stableCvSourceJson } from '../../../electron/workspace/cv-source-schema.js';
import type { CvSourceDocument } from '../../window.js';

/**
 * SHA-256 hex, computed in the renderer via the Web Crypto API (`crypto.subtle`, a standard
 * Chromium API, not a Node one -- this runs in the renderer process, which `node:crypto` cannot).
 * Matches the `sha256Hex` shape `workspace/validate.ts` already enforces on
 * `sourceCvContentHash`/`jdSnapshotHash`, the same drift-detection pair `applicationAttempts`
 * established (#198) and `CvEvidenceOverlay` (#419) reuses.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The one place a `CvSourceDocument` gets hashed in the renderer, so every call site agrees on
 * both the serialization (`stableCvSourceJson` -- sorted keys, so a legacy record backfilled with
 * `withStableExperienceIds` hashes identically to the same content freshly written with its id in
 * a different key position) and the digest. `main.ts`'s export handler hashes the same way, with
 * `node:crypto` in place of `crypto.subtle` (the one unavoidable platform difference -- the two
 * primitives produce identical hex for identical input bytes), so a hash computed here and a hash
 * computed there always agree for the same source content.
 */
export function sha256HexOfSource(source: CvSourceDocument | null): Promise<string> {
  return sha256Hex(source ? stableCvSourceJson(source) : 'null');
}
