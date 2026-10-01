import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { documentKindForArtifact, stagedArtifactPath } from '../electron/application-artifact-staging.js';

// The module under test imports `BrowserWindow` for its one real Electron call (`printToPDF`).
// Nothing exercised in this file goes near it, and loading the real `electron` package in a plain
// Node test process can stall for seconds on a cold CI runner while it resolves its own binary.
vi.mock('electron', () => ({ BrowserWindow: class {} }));

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

describe('documentKindForArtifact', () => {
  it('maps every artifact kind that carries a real document, and nothing else', () => {
    expect(documentKindForArtifact('cv_pdf')).toBe('cv');
    expect(documentKindForArtifact('cover_letter_pdf')).toBe('cover_letter');
    expect(documentKindForArtifact('combined_pdf')).toBe('combined');
    expect(documentKindForArtifact('other')).toBeNull();
  });
});
