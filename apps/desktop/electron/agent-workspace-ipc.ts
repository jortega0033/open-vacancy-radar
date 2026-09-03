import { toHistoryEntry } from './agent-activity-sanitize.js';
import { toCapacity, toSessionSummary } from './agent-workspace-view.js';
import type { GuardedIpcHandle } from './ipc-sender-guard.js';
import type {
  AttachResult,
  HistoryEntry,
  SessionEventsPage,
  SessionListPage,
  SessionSummary,
} from './agent-workspace-types.js';
import {
  parseAgentWorkspaceAttachInput,
  parseAgentWorkspaceDetachInput,
  parseAgentWorkspaceEventsInput,
  parseAgentWorkspaceGetInput,
  parseAgentWorkspaceListInput,
} from './workspace/validate.js';

/*
 * ---------------------------------------------------------------------------------------------
 * AI Workspace IPC (ADI-07): the seventh preload namespace.
 *
 * Five channels, and the same rule the grant channels in main.ts keep: **none of them accepts or
 * returns a location**. Every request payload is parsed by an allow-listing validator
 * (workspace/validate.ts) that has no `path`, `cwd`, `workspaceId`, or `incarnation` parser at all,
 * and every response is rebuilt field by field (agent-workspace-view.ts, agent-activity-sanitize.ts)
 * so a `cwd` the daemon's own v2 view carries cannot cross even if a future daemon build added
 * more path-shaped fields beside it.
 *
 * The renderer never talks to the daemon. These handlers are the only thing that does, over
 * loopback, with a bearer token that stays in the main process.
 *
 * ## Why this is a module rather than five `ipcMain.handle` calls inline in main.ts
 *
 * main.ts registers roughly fifty IPC channels at module scope and has never been importable by a
 * test: importing it boots Electron. That is a pre-existing problem this feature does not try to
 * solve. What it does do is keep its own five channels, its own paging helpers, and its own alias
 * book out of that module scope entirely, behind one call. The whole feature is therefore
 * removable by deleting a single line from main.ts, and testable without main.ts -- see
 * test/agent-workspace-ipc.test.ts, which registers these handlers against a stub registrar.
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Every channel this feature owns, in one place so a test can assert that all five are additive and
 * that none of them collides with a channel some other part of main.ts already answers.
 */
export const AGENT_WORKSPACE_CHANNELS = [
  'agent-workspace:list',
  'agent-workspace:get',
  'agent-workspace:events',
  'agent-workspace:attach',
  'agent-workspace:detach',
] as const;

/** The one-way push channel the relay uses. Not an `ipcMain.handle` channel: main sends on it. */
export const AGENT_WORKSPACE_ACTIVITY_CHANNEL = 'agent-workspace:activity';

/** How many sessions' alias maps are kept. Well above the daemon's own four-session ceiling. */
export const MAX_ALIAS_BOOKS = 64;

/**
 * One tool-call alias map per session, shared by the live relay and the history reader.
 *
 * A native `toolCallId` never crosses to the renderer; a locally-minted `t1`/`t2` alias does, so a
 * `tool.started` and its `tool.completed` stay pairable in the UI. Both halves have to consult the
 * *same* map or a session's live entries and its history entries would disagree about which alias
 * belongs to which call.
 *
 * Bounded by oldest-first eviction, matching `WorkspaceGrantManager`'s tombstone bound: an
 * unbounded map in a process that runs for days is a leak, and losing an alias map only costs a
 * re-numbering of that session's tool aliases on its next read.
 *
 * A factory rather than a module-level `Map`, so the state belongs to whoever created it. A shared
 * module global here would be a smaller version of exactly the `activeSessionId` /
 * `activeStreamAbort` pair ADI-07 removed from main.ts.
 */
export function createSessionAliasBook(maxBooks: number = MAX_ALIAS_BOOKS): (sessionId: string) => Map<string, string> {
  const books = new Map<string, Map<string, string>>();
  return (sessionId: string): Map<string, string> => {
    const existing = books.get(sessionId);
    if (existing) return existing;
    while (books.size >= maxBooks) {
      const oldest = books.keys().next();
      if (oldest.done) break;
      books.delete(oldest.value);
    }
    const created = new Map<string, string>();
    books.set(sessionId, created);
    return created;
  };
}

/** An `ipcMain.handle` listener, narrowed to what these handlers actually use. */
export type IpcInvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

/**
 * The one method these registrations need from `ipcMain`, named so a test can supply a stub.
 *
 * `registerAgentWorkspaceHandlers` itself takes `GuardedIpcHandle` (ipc-sender-guard.ts), not this
 * interface, even though the shape is identical -- ADI-16 found that two structurally-identical
 * "ipc registrar" interfaces are indistinguishable to TypeScript, so a future module wired to raw
 * `ipcMain` by copy-paste would typecheck fine here. Requiring the branded type instead makes that
 * mistake a compile error. A test that needs a plain stub (no real guard behavior) casts it to the
 * branded type explicitly, which is a visible, deliberate opt-out rather than an accidental one.
 */
export interface IpcHandleRegistrar {
  handle(channel: string, listener: IpcInvokeHandler): void;
}

/** The live relay surface these handlers use. `AgentWorkspaceRelay` satisfies it. */
export interface AgentWorkspaceRelayHandle {
  attach(sessionId: string, lastSeq?: number): AttachResult;
  detach(sessionId: string): boolean;
}

export interface AgentWorkspaceIpcDeps {
  /**
   * One authenticated GET against a v2 read route, returning the parsed body or `undefined` for a
   * 404. Supplied by main.ts, which owns the daemon's loopback address and bearer token: nothing
   * in this module knows either.
   */
  getJson(path: string): Promise<Record<string, unknown> | undefined>;
  /** The per-session tool-call alias book, shared with the relay so history and live agree. */
  aliasesFor(sessionId: string): Map<string, string>;
  relay: AgentWorkspaceRelayHandle;
}

/** `?cursor=&limit=` for a v2 read route, built here so no caller hand-concatenates a query. */
function pageQuery(page: { cursor?: string; limit: number }): string {
  const params = new URLSearchParams({ limit: String(page.limit) });
  if (page.cursor !== undefined) params.set('cursor', page.cursor);
  return `?${params.toString()}`;
}

function readCursor(body: Record<string, unknown> | undefined): string | undefined {
  const cursor = body?.nextCursor;
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}

/**
 * Registers the five AI Workspace channels. Called once, from main.ts.
 *
 * Not calling it is the feature's off switch: nothing else in main.ts reads anything this module
 * owns, so the remaining channels behave identically with or without this call.
 */
export function registerAgentWorkspaceHandlers(ipc: GuardedIpcHandle, deps: AgentWorkspaceIpcDeps): void {
  const { getJson, aliasesFor, relay } = deps;

  ipc.handle('agent-workspace:list', async (_event, input: unknown): Promise<SessionListPage> => {
    const page = parseAgentWorkspaceListInput(input);
    const body = await getJson(`/v2/sessions${pageQuery(page)}`);
    const raw = Array.isArray(body?.sessions) ? body.sessions : [];
    const sessions: SessionSummary[] = [];
    for (const view of raw) {
      const summary = toSessionSummary(view);
      if (summary !== null) sessions.push(summary);
    }
    const nextCursor = readCursor(body);
    return {
      sessions,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      capacity: toCapacity(body?.capacity),
    };
  });

  ipc.handle('agent-workspace:get', async (_event, input: unknown): Promise<SessionSummary | null> => {
    const sessionId = parseAgentWorkspaceGetInput(input);
    const body = await getJson(`/v2/sessions/${encodeURIComponent(sessionId)}`);
    return body === undefined ? null : toSessionSummary(body.session);
  });

  ipc.handle('agent-workspace:events', async (_event, input: unknown): Promise<SessionEventsPage> => {
    const { sessionId, ...page } = parseAgentWorkspaceEventsInput(input);
    const body = await getJson(`/v2/sessions/${encodeURIComponent(sessionId)}/events${pageQuery(page)}`);
    const raw = Array.isArray(body?.events) ? body.events : [];
    const aliases = aliasesFor(sessionId);
    const events: HistoryEntry[] = [];
    for (const record of raw) {
      const entry = toHistoryEntry(record, aliases);
      if (entry !== null) events.push(entry);
    }
    const nextCursor = readCursor(body);
    return { sessionId, events, ...(nextCursor === undefined ? {} : { nextCursor }) };
  });

  ipc.handle('agent-workspace:attach', (_event, input: unknown): AttachResult => {
    const { sessionId, lastSeq } = parseAgentWorkspaceAttachInput(input);
    return relay.attach(sessionId, lastSeq);
  });

  ipc.handle('agent-workspace:detach', (_event, input: unknown): void => {
    relay.detach(parseAgentWorkspaceDetachInput(input));
  });
}
