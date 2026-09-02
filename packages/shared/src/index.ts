/**
 * The barrel every consumer of `@agent-dock/shared` imports from, and the reason it is not simply
 * "every file in `src/`".
 *
 * ## `content-digest.ts` is deliberately absent
 *
 * Every module listed below is pure data: zod schemas, type declarations, and functions over
 * plain values. None of them touches a Node built-in, so importing this barrel is safe from any
 * of the four contexts in this repo -- the daemon, Electron's main process, the renderer, and
 * Electron's **sandboxed preload script**.
 *
 * `content-digest.ts` is the one module that is not: it imports `node:crypto` and uses `Buffer`
 * (its own header says so). A sandboxed preload script gets a small polyfilled subset of Node,
 * not `node:crypto`, and a preload script that references it does not merely lose that one
 * function -- Electron fails to load the entire script, so `contextBridge.exposeInMainWorld`
 * never runs for *any* namespace and every bridge on `window` is undefined.
 *
 * That is not hypothetical. ADI-07 added `export * from './content-digest.js'` here, and because
 * `preload.ts` imports two zod schemas from this barrel, Rollup kept a bare
 * `require("node:crypto")` at the top of `dist-electron/preload.js` (the module's *exports* were
 * tree-shaken; the module's assumed side effects were not). The whole desktop app failed to boot.
 *
 * So the rule this file encodes is: **the barrel is preload-safe, and anything that is not goes
 * behind its own subpath.** Node-side callers import the digest helpers explicitly from
 * `@agent-dock/shared/content-digest`, which reads as the deliberate act it is. Adding another
 * Node-only module here would silently re-break preload, so give it a subpath too.
 *
 * `apps/desktop/test/preload-node-builtins.test.ts` walks preload's real import graph and fails if
 * a Node built-in ever reappears in it, whichever route it takes.
 */
export * from './provider.js';
export * from './events.js';
export * from './session.js';
export * from './schemas.js';
export * from './protocol.js';
export * from './mcp.js';
export * from './session-v2.js';
export * from './workspace-v2.js';
export * from './capabilities-v2.js';
export * from './negotiation-v2.js';
