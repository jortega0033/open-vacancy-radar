/**
 * The runtime status shown to the user, one step more specific than "is the daemon up": the
 * daemon being ready says nothing about whether the selected AI CLI is actually installed or
 * authenticated (see the `providerRuntimeState` effect in `App.tsx`), so this type also carries the two
 * CLI-specific states `RuntimePage` already knew about but the shell status dot didn't.
 */
export type RuntimeState = 'connecting' | 'ready' | 'unavailable' | 'not-installed' | 'not-authenticated';

export interface WorkspaceHeaderProps {
  title: string;
  subtitle: string;
}

/**
 * The 52px band above every page: what you are looking at on the left. The AI runtime status
 * lives only in the sidebar footer now (see `AppSidebar.tsx`) — it used to be duplicated here too,
 * which was both redundant and, since it read the daemon's own readiness rather than the actual
 * CLI's installed/authenticated state, sometimes claimed "Ready" with no CLI installed at all.
 */
export function WorkspaceHeader({ title, subtitle }: WorkspaceHeaderProps) {
  return (
    <header className="ovr-header flex flex-none items-center border-b border-base-300 px-5">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
        <p className="truncate text-xs text-base-content/50">{subtitle}</p>
      </div>
    </header>
  );
}
