import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stagedArtifactPath } from '../electron/application-artifact-staging.js';

describe('stagedArtifactPath', () => {
  it('namespaces the path under the attempt id and names the file by content hash', () => {
    const path = stagedArtifactPath('/data/application-artifacts', 'attempt-1', 'abc123', 'resume.pdf');
    expect(path).toBe(join('/data/application-artifacts', 'attempt-1', 'abc123-resume.pdf'));
  });

  it('gives two different attempts distinct paths even for identical content and file names', () => {
    const a = stagedArtifactPath('/data/application-artifacts', 'attempt-1', 'abc123', 'resume.pdf');
    const b = stagedArtifactPath('/data/application-artifacts', 'attempt-2', 'abc123', 'resume.pdf');
    expect(a).not.toBe(b);
  });

  it('gives identical (storageRoot, attempt, content) the same path, making re-staging idempotent on disk', () => {
    const first = stagedArtifactPath('/data/application-artifacts', 'attempt-1', 'abc123', 'resume.pdf');
    const second = stagedArtifactPath('/data/application-artifacts', 'attempt-1', 'abc123', 'resume.pdf');
    expect(first).toBe(second);
  });
});
