import { afterEach, describe, expect, it } from 'vitest';
import { CODEX_ATTACHMENT_MIME_TYPES } from '../src/providers/codex/capabilities.js';
import { CodexProvider } from '../src/providers/codex/adapter.js';

/**
 * Port of agentdock#152/#153. Codex's attachment delivery (`-i/--image <path>` argv) is only wired
 * for the `'exec'` transport (build-args.ts); the opt-in `'app-server'`/`'auto'` transport has no
 * equivalent. `CodexProvider.startSession` must fail closed rather than silently starting a
 * session that ignores a requested attachment.
 */
describe('CodexProvider: attachments (port of agentdock#152/#153)', () => {
  afterEach(() => {
    delete process.env.AGENT_DOCK_CODEX_TRANSPORT;
  });

  it('reports the verified attachment MIME types', () => {
    const provider = new CodexProvider();
    expect(provider.getAttachmentMimeTypes()).toEqual(CODEX_ATTACHMENT_MIME_TYPES);
  });

  it('throws when attachments are requested on the app-server transport', () => {
    process.env.AGENT_DOCK_CODEX_TRANSPORT = 'app-server';
    const provider = new CodexProvider();
    expect(() =>
      provider.startSession({
        sessionId: 'sess-1',
        cwd: '/tmp',
        prompt: 'hi',
        attachments: [{ path: '/tmp/cv.pdf', mimeType: 'application/pdf' }],
      }),
    ).toThrow(/only supported on the 'exec' transport/);
  });

  it('throws when attachments are requested on the auto transport', () => {
    process.env.AGENT_DOCK_CODEX_TRANSPORT = 'auto';
    const provider = new CodexProvider();
    expect(() =>
      provider.startSession({
        sessionId: 'sess-1',
        cwd: '/tmp',
        prompt: 'hi',
        attachments: [{ path: '/tmp/cv.pdf', mimeType: 'application/pdf' }],
      }),
    ).toThrow(/only supported on the 'exec' transport/);
  });

  it('does not throw for a session with no attachments on a non-exec transport', () => {
    process.env.AGENT_DOCK_CODEX_TRANSPORT = 'app-server';
    const provider = new CodexProvider();
    expect(() =>
      provider.startSession({ sessionId: 'sess-1', cwd: '/tmp', prompt: 'hi' }),
    ).not.toThrow();
  });
});
