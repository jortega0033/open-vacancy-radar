/**
 * The universal, secret-shaped substrings and vendor prefixes real-world tooling overwhelmingly
 * uses for credentials -- the one piece two independent environment-filtering boundaries in this
 * repo are supposed to agree on (issue #176):
 *
 * - `packages/agent-runtime/src/providers/common/provider-environment.ts` (ADI-15), which bounds
 *   what a spawned `claude`/`codex` child sees.
 * - `apps/desktop/electron/daemon-environment.ts` (ADI-21), which bounds what the spawned daemon
 *   sees one hop earlier.
 *
 * Both modules also deny additional, differently-scoped names of their own (this product's
 * `AGENT_DOCK_*`/`ELECTRON_*`/`OVR_*`/`VITE_*` internals for the provider boundary; the vacancy-
 * source credential names for both) -- those stay local to each module, because they are not the
 * same list by design, only overlapping in this shared, universal subset. Before this module
 * existed, that subset was hand-duplicated in both places with a comment asking whoever changed
 * one to remember the other; sharing one array makes divergence structurally impossible instead of
 * a discipline to remember.
 *
 * This is a backstop, not the primary control, for either caller: `provider-environment.ts`'s
 * allowlist is what actually bounds a provider child's environment, and `daemon-environment.ts`'s
 * own doc comment explains why the daemon needs a deny list rather than an allowlist at all. A
 * pattern list alone would be a denylist, and a denylist is exactly the thing an allowlist-based
 * control is not.
 */
export const CREDENTIAL_SHAPED_ENV_DENY_PATTERNS: readonly RegExp[] = [
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSWD/i,
  /CREDENTIAL/i,
  /PRIVATE_KEY/i,
  /API_?KEY/i,
  /_KEY$/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GCP_/i,
  /^GOOGLE_APPLICATION_/i,
  /^GH_/i,
  /^GITHUB_/i,
  /^NPM_/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^SSH_/i,
  /^VAULT_/i,
];
