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
