import { realpathSync, statSync } from 'node:fs';

/**
 * `fs.realpathSync` (the plain JS implementation) does not expand Windows 8.3 short names (e.g.
 * `GEBRUI~1` for a longer real username), while `fs.realpathSync.native` delegates to the OS
 * resolver and does -- the exact same distinction `workspace-identity.ts` documents and relies on
 * for `canonicalPath`. Using the non-native form here would silently fail to match a real, correct
 * `cwd`/attachment pair whenever the OS handed either path back in short form (observed in
 * practice: Windows' own `os.tmpdir()` can return one), which would make the jail check *reject*
 * legitimate attachments -- an availability bug, not a security one, but still wrong. Calling
 * `.native` explicitly at each use below is what keeps this check's notion of "the same path"
 * consistent with `identity.canonicalPath`, the value every real caller actually passes.
 */
import { relative, resolve as resolvePath } from 'node:path';
import { MAX_SESSION_ATTACHMENT_BYTES } from '@agent-dock/agent-runtime';
import type { ProviderCapabilities } from '@agent-dock/shared';

/** The subset of `AgentSession` request attachments this module validates. */
export interface SessionAttachmentRequest {
  path: string;
  mimeType: string;
}

export interface AttachmentValidationFailure {
  status: number;
  code: string;
  message: string;
}

/**
 * Whether `candidatePath` resolves (symlinks followed) to a location inside `directory` (port of
 * agentdock#152/#153). `cwd` itself has no such jail -- a caller can already point the provider
 * process at any working directory it can read -- but an attachment is a categorically different
 * capability: its *bytes* are automatically base64-encoded (Claude) or handed to the CLI directly
 * (Codex) and sent to a third-party AI provider's API with no further action needed from whatever's
 * inside the prompt. Without this jail, a caller of these routes could name any file the daemon
 * process can read as an attachment -- a direct "read this arbitrary file and exfiltrate it"
 * primitive, wider than what a caller can already do through `cwd`. Requiring the attachment to
 * live inside the session's own `cwd` means a caller must already control (or have staged a file
 * into) that directory -- the same trust bar `cwd`'s own contents already sit behind -- rather than
 * naming anything the daemon process happens to have read access to.
 */
export function isWithinDirectory(candidatePath: string, directory: string): boolean {
  let realCandidate: string;
  let realDirectory: string;
  try {
    realCandidate = realpathSync.native(candidatePath);
    realDirectory = realpathSync.native(directory);
  } catch {
    return false;
  }
  const rel = relative(realDirectory, realCandidate);
  return rel !== '' && !rel.startsWith('..') && !resolvePath(rel).startsWith('..');
}

/**
 * Validates a request's `attachments` against the target provider's capability, its accepted MIME
 * types, the attachment file's existence and size, and the cwd-jail above -- shared by both
 * `routes/sessions.ts` (v1) and `routes/v2-sessions-create.ts` (v2, the path the desktop app
 * actually exercises) so the two never drift out of sync on what "a valid attachment" means.
 * Returns `null` when there's nothing to validate (no attachments) or everything passes; otherwise
 * the first failure found, in the same order every call site should check them (the caller should
 * stop and reply with it immediately, not accumulate multiple failures).
 */
export function validateSessionAttachments(
  attachments: readonly SessionAttachmentRequest[] | undefined,
  provider: string,
  capabilities: ProviderCapabilities,
  acceptedMimeTypes: readonly string[],
  effectiveCwd: string,
): AttachmentValidationFailure | null {
  if (!attachments?.length) return null;
  if (!capabilities.attachments) {
    return {
      status: 400,
      code: 'attachments_not_supported',
      message: `provider does not support attachments: ${provider}`,
    };
  }
  for (const attachment of attachments) {
    if (!acceptedMimeTypes.includes(attachment.mimeType)) {
      return {
        status: 400,
        code: 'attachment_mime_type_not_accepted',
        message: `provider ${provider} does not accept attachment MIME type: ${attachment.mimeType}`,
      };
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(attachment.path);
    } catch {
      return {
        status: 400,
        code: 'attachment_not_found',
        message: `attachment file does not exist: ${attachment.path}`,
      };
    }
    if (!stat.isFile()) {
      return {
        status: 400,
        code: 'attachment_not_found',
        message: `attachment file does not exist: ${attachment.path}`,
      };
    }
    if (!isWithinDirectory(attachment.path, effectiveCwd)) {
      return {
        status: 400,
        code: 'attachment_outside_cwd',
        message: `attachment must be inside the session's working directory: ${attachment.path}`,
      };
    }
    if (stat.size > MAX_SESSION_ATTACHMENT_BYTES) {
      return {
        status: 400,
        code: 'attachment_too_large',
        message: `attachment "${attachment.path}" exceeds the ${MAX_SESSION_ATTACHMENT_BYTES} byte limit`,
      };
    }
  }
  return null;
}
