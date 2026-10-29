/**
 * The one place a staged artifact's on-disk file name is spelled (#199, reused by #691).
 *
 * Pure and free of any Electron import, so both the staging writer (`stagedArtifactPath`) and the
 * submission-package manifest can use it. The browser names a file input's selection by this name,
 * and the review session requires the read-back to contain it before it records an attachment, so
 * anything that asks "was this artifact the file attached?" must compare against exactly this.
 */
export function stagedArtifactFileName(contentHash: string, fileName: string): string {
  return `${contentHash}-${fileName}`;
}

/**
 * The last path segment of a reported file name, for either separator. A file input can report
 * `C:\fakepath\<name>` (Chromium's value), a full path, or the bare name; all of them name the same file.
 */
export function reportedBaseName(reported: string): string {
  const trimmed = reported.trim();
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
}
