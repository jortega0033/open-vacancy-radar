import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NonReusableWorkspaceError, WorkspaceTrustStore } from '../src/workspace-trust-store.js';
import type { WorkspaceIdentity } from '../src/workspace-identity.js';

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-trust-'));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function identity(overrides: Partial<WorkspaceIdentity> = {}): WorkspaceIdentity {
  return {
    workspaceId: 'a'.repeat(64),
    incarnation: 'b'.repeat(64),
    canonicalPath: join('C:', 'Users', 'someone', 'SENTINEL_PROJECT_PATH'),
    displayName: 'SENTINEL_PROJECT_NAME',
    reusable: true,
    ...overrides,
  };
}

function trustFile(): string {
  return join(stateRoot, 'workspace-trust', 'trust.json');
}

describe('WorkspaceTrustStore: what it will and will not remember', () => {
  it('records a trusted workspace at a specific incarnation, and survives a restart', async () => {
    const store = new WorkspaceTrustStore({ stateRoot });
    await store.setTrusted(identity(), 'claude');

    const reopened = new WorkspaceTrustStore({ stateRoot });
    expect((await reopened.inspect('a'.repeat(64))).state).toBe('trusted');
    expect(reopened.matches('a'.repeat(64), 'b'.repeat(64))).toBe(true);
  });

  it('does not consider a workspace trusted at a DIFFERENT incarnation', async () => {
    const store = new WorkspaceTrustStore({ stateRoot });
    await store.setTrusted(identity(), 'claude');

    // Same object, different place or different birth: the user approved a folder, and this is no
    // longer the thing they approved. Without this, trusting `repo/packages/a` would silently
    // trust `repo/packages/b`, because a Git-keyed workspaceId covers the whole repository.
    expect(store.matches('a'.repeat(64), 'c'.repeat(64))).toBe(false);
  });

  it('refuses to remember a non-reusable identity at all', async () => {
    const store = new WorkspaceTrustStore({ stateRoot });
    await expect(store.setTrusted(identity({ reusable: false }), 'claude')).rejects.toBeInstanceOf(
      NonReusableWorkspaceError,
    );
    expect(store.all()).toHaveLength(0);
    // And nothing was written: a record claiming an approval no check could ever honor is worse
    // than no record.
    expect(existsSync(trustFile())).toBe(false);
  });

  it('reads an unknown workspace as untrusted rather than erroring', async () => {
    const store = new WorkspaceTrustStore({ stateRoot });
    expect((await store.inspect('f'.repeat(64))).state).toBe('untrusted');
    expect(store.inspectSync('f'.repeat(64)).state).toBe('untrusted');
    expect(store.matches('f'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

  it('never writes a path or a folder name to disk, only digests and enums', async () => {
    const store = new WorkspaceTrustStore({ stateRoot });
    await store.setTrusted(identity(), 'claude');

    const contents = readFileSync(trustFile(), 'utf8');
    expect(contents).not.toContain('SENTINEL_PROJECT_PATH');
    expect(contents).not.toContain('SENTINEL_PROJECT_NAME');
    expect(contents).not.toMatch(/[A-Za-z]:\\/);
  });
});

describe('WorkspaceTrustStore: lowering trust', () => {
  it('moves through revoking to untrusted', async () => {
    const store = new WorkspaceTrustStore({ stateRoot });
    await store.setTrusted(identity(), 'claude');

    await store.beginRevocation('a'.repeat(64));
    expect(store.inspectSync('a'.repeat(64)).state).toBe('revoking');
    // Already not trusted for any new decision, even before revocation finishes.
    expect(store.matches('a'.repeat(64), 'b'.repeat(64))).toBe(false);

    await store.setUntrusted('a'.repeat(64));
    expect(store.inspectSync('a'.repeat(64)).state).toBe('untrusted');
  });

  it('downgrades a record left in `revoking` by a crash to untrusted on the next load', async () => {
    const store = new WorkspaceTrustStore({ stateRoot });
    await store.setTrusted(identity(), 'claude');
    await store.beginRevocation('a'.repeat(64));

    // Resuming as "still trusted" would undo an explicit withdrawal because the daemon happened to
    // die mid-revocation, which is the one direction this must never fail in.
    const reopened = new WorkspaceTrustStore({ stateRoot });
    expect(reopened.inspectSync('a'.repeat(64)).state).toBe('untrusted');
  });

  it('treats revoking an unknown workspace as a no-op rather than creating a record', async () => {
    const store = new WorkspaceTrustStore({ stateRoot });
    await store.setUntrusted('e'.repeat(64));
    expect(store.all()).toHaveLength(0);
  });
});

describe('WorkspaceTrustStore: serialized writes and corrupt state', () => {
  it('keeps the file consistent with memory under concurrent mutations', async () => {
    const store = new WorkspaceTrustStore({ stateRoot });
    const ids = Array.from({ length: 12 }, (_unused, index) => String(index).padStart(64, '0'));

    // Every mutation rewrites the whole file, so two interleaved writes would leave the file
    // holding a snapshot taken before one of them.
    await Promise.all(ids.map((id) => store.setTrusted(identity({ workspaceId: id }), 'claude')));

    const onDisk = JSON.parse(readFileSync(trustFile(), 'utf8')) as {
      workspaces: { workspaceId: string }[];
    };
    expect(onDisk.workspaces.map((record) => record.workspaceId).sort()).toEqual([...ids].sort());
    expect(store.all()).toHaveLength(12);
  });

  it('quarantines a corrupt trust file and starts with nothing trusted', async () => {
    const store = new WorkspaceTrustStore({ stateRoot });
    await store.setTrusted(identity(), 'claude');
    writeFileSync(trustFile(), '{ this is not json');

    const reopened = new WorkspaceTrustStore({ stateRoot });
    // Fail-closed: a damaged file means nothing is trusted, never "keep whatever parsed".
    expect(reopened.all()).toHaveLength(0);
    expect(readdirSync(join(stateRoot, 'workspace-trust', 'quarantine'))).toHaveLength(1);
  });

  it('quarantines a file whose records do not match this build, rather than accepting a subset', async () => {
    // Seeded through a real store so the directory exists exactly as the constructor makes it.
    const seed = new WorkspaceTrustStore({ stateRoot });
    await seed.setTrusted(identity(), 'claude');
    writeFileSync(
      trustFile(),
      JSON.stringify({
        schemaVersion: 1,
        // A `workspaceId` that is not a digest is exactly what a path smuggled into that field
        // would look like, so this must be refused wholesale rather than partially accepted.
        workspaces: [{ workspaceId: 'C:\\Users\\someone', incarnation: 'x', state: 'trusted' }],
      }),
    );

    const store = new WorkspaceTrustStore({ stateRoot });
    expect(store.all()).toHaveLength(0);
    expect(readdirSync(join(stateRoot, 'workspace-trust', 'quarantine'))).toHaveLength(1);
  });
});
