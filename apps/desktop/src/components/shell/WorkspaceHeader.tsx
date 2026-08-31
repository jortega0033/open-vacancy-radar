export type RuntimeState = 'connecting' | 'ready' | 'unavailable';

export interface WorkspaceHeaderProps {
  title: string;
  subtitle: string;
  runtimeLabel: string;
  runtimeState: RuntimeState;
}

const RUNTIME_TEXT: Record<RuntimeState, string> = {
  connecting: 'Starting',
  ready: 'Ready',
  unavailable: 'Unavailable',
};

/**
 * The 52px band above every page: what you are looking at on the left, whether the AI runtime is
 * usable on the right.
 *
 * The runtime dot is one of the few places this design spends a hue: `success` when the local
 * CLI daemon is up, `error` when it is not. The word next to it says the same thing, so the color
 * is reinforcement rather than the only carrier of the state.
 */
export function WorkspaceHeader({ title, subtitle, runtimeLabel, runtimeState }: WorkspaceHeaderProps) {
  const dotClass =
    runtimeState === 'ready' ? 'bg-success' : runtimeState === 'unavailable' ? 'bg-error' : 'bg-base-content/30';

  return (
    <header className="ovr-header flex flex-none items-center justify-between gap-4 border-b border-base-300 px-5">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
        <p className="truncate text-xs text-base-content/50">{subtitle}</p>
      </div>
      <div className="flex flex-none items-center gap-3.5 text-xs text-base-content/70">
        <span className="flex items-center gap-1.5">
          <span className={`size-1.5 rounded-full ${dotClass}`} aria-hidden="true" />
          {/* Label and state read as one phrase ("Claude Code Ready") in a single element, rather
              than as two separately-addressable nodes: the provider name on its own is not a
              status, and splitting it out would make the header a second element in the document
              whose entire text is just the provider name. */}
          <span className="font-medium">
            {runtimeLabel} <span className="font-normal text-base-content/50">{RUNTIME_TEXT[runtimeState]}</span>
          </span>
        </span>
      </div>
    </header>
  );
}
