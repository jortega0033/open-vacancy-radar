// AD-09: this used to re-export process/* internals, both providers' build-args, and both
// providers' capability objects. No consumer outside this package used them, and the package's
// tests import them by relative path. docs/protocol-v1.md already
// (incorrectly) claimed build-args was unexported. Trimmed to what apps/daemon genuinely needs,
// so the documented "internal" surface is actually internal rather than merely undocumented.
export * from './types.js';
export * from './logger.js';
export * from './registry.js';
export * from './providers/claude/adapter.js';
export * from './providers/codex/adapter.js';
export * from './providers/fake/adapter.js';
