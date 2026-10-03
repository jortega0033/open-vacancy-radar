import {
  CaretLeft,
  CheckCircle,
  CircleNotch,
  Database,
  DownloadSimple,
  Hourglass,
  Key,
  Warning,
  XCircle,
  type Icon,
} from '@phosphor-icons/react';
import type { WorkspaceCounts } from '../../window.js';
import type { EngineHealth } from '../../engine-health.js';
import { OpenVacancyRadarMark } from '../brand/OpenVacancyRadarMark.js';
import { NavIcon } from './NavIcon.js';
import { badgeCount, PRIMARY_NAV, SECONDARY_NAV, type NavItem, type NavPage } from './nav.js';
import type { RuntimeState } from './WorkspaceHeader.js';

const RUNTIME_TEXT: Record<RuntimeState, string> = {
  connecting: 'starting',
  ready: 'ready',
  unavailable: 'unavailable',
  'not-installed': 'not installed',
  'not-authenticated': 'not signed in',
  'limit-reached': 'usage limit reached',
};

/** One shape per state, so every state can be told apart with no color at all (#477). */
const RUNTIME_ICON: Record<RuntimeState, Icon> = {
  ready: CheckCircle,
  connecting: CircleNotch,
  unavailable: XCircle,
  'not-installed': DownloadSimple,
  'not-authenticated': Key,
  'limit-reached': Hourglass,
};

const RUNTIME_TONE: Record<RuntimeState, string> = {
  ready: 'text-success',
  connecting: 'text-base-content/60',
  unavailable: 'text-error',
  'not-installed': 'text-warning',
  'not-authenticated': 'text-warning',
  'limit-reached': 'text-warning',
};

function engineText(engine: EngineHealth): string {
  if (engine.state === 'ready') return 'Job search ready';
  if (engine.state === 'checking') return 'Checking job search';
  return 'Job search needs attention';
}

export interface AppSidebarProps {
  active: NavPage;
  onNavigate(page: NavPage): void;
  collapsed: boolean;
  onToggleCollapsed(): void;
  counts: WorkspaceCounts | undefined;
  /** e.g. "Claude Code": the provider the AI features would use right now. */
  runtimeLabel: string;
  /** The one place this now shows: distinguishes an unreachable daemon from a daemon that's fine
   * but has no CLI installed/authenticated, so this never claims "ready" when nothing is. */
  runtimeState: RuntimeState;
  /** The job search engine, shown beside the AI runtime so one cannot mask the other (#477). */
  engine?: EngineHealth;
}

/**
 * The persistent left rail: 236px expanded, 64px collapsed.
 *
 * Collapsed is a real mode, not a visual trick. The labels are removed from the accessibility
 * tree along with the pixels, and each button keeps an `aria-label` plus a `title` so it is still
 * both announced and hoverable. `aria-current="page"` marks the active destination for screen
 * readers; the visual selected state (a `base-300` fill) is the same information for everyone
 * else, never the only signal.
 */
export function AppSidebar({
  active,
  onNavigate,
  collapsed,
  onToggleCollapsed,
  counts,
  runtimeLabel,
  runtimeState,
  engine = { state: 'checking' },
}: AppSidebarProps) {
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';

  return (
    <aside
      className={`${collapsed ? 'ovr-sidebar-collapsed' : 'ovr-sidebar'} flex flex-none flex-col border-r border-base-300 bg-base-200`}
      aria-label="Main"
    >
      <div className={collapsed ? 'flex flex-col items-center gap-1.5 px-0 pt-3.5 pb-2' : 'flex items-center gap-2 py-3 pr-2.5 pl-3.5'}>
        <div
          className="flex size-5.5 flex-none items-center justify-center rounded-sm bg-primary text-primary-content"
          title={collapsed ? 'Open Vacancy Radar' : undefined}
        >
          <OpenVacancyRadarMark size={18} label={collapsed ? 'Open Vacancy Radar' : undefined} />
        </div>
        {!collapsed && (
          <span className="truncate text-sm font-semibold tracking-tight">Open Vacancy Radar</span>
        )}
        <button
          type="button"
          className={`btn btn-ghost btn-square ${collapsed ? 'ovr-nav-icon' : 'btn-sm ml-auto'}`}
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          title={toggleLabel}
          onClick={onToggleCollapsed}
        >
          <CaretLeft size={15} className={collapsed ? 'rotate-180' : undefined} aria-hidden="true" />
        </button>
      </div>

      <NavGroup items={PRIMARY_NAV} {...{ active, onNavigate, collapsed, counts }} />
      <div className="mx-3 my-2.5 h-px bg-base-300" />
      <NavGroup items={SECONDARY_NAV} {...{ active, onNavigate, collapsed, counts }} />

      <div className="flex-1" />

      <SidebarStatus
        collapsed={collapsed}
        runtimeLabel={runtimeLabel}
        runtimeState={runtimeState}
        engine={engine}
        onOpenRuntime={() => onNavigate('runtime')}
        onOpenSearch={() => onNavigate('search')}
      />
    </aside>
  );
}

interface SidebarStatusProps {
  collapsed: boolean;
  runtimeLabel: string;
  runtimeState: RuntimeState;
  engine: EngineHealth;
  onOpenRuntime(): void;
  onOpenSearch(): void;
}

/**
 * The two system statuses at the foot of the rail: the AI runtime and the job search engine, each
 * its own button that opens where it is fixed. They are separate on purpose (#477): a provider that
 * is ready says nothing about whether scans can run. Every state has its own icon and its own words,
 * and the button's name carries the whole state, so the collapsed rail (which drops the words)
 * announces exactly what the expanded one shows.
 */
function SidebarStatus({ collapsed, runtimeLabel, runtimeState, engine, onOpenRuntime, onOpenSearch }: SidebarStatusProps) {
  const RuntimeIcon = RUNTIME_ICON[runtimeState];
  const runtimeName = `AI runtime: ${runtimeLabel}, ${RUNTIME_TEXT[runtimeState]}`;
  const EngineIcon = engine.state === 'attention' ? Warning : Database;
  const engineLabel = engineText(engine);
  const engineName = `Job search: ${engine.state === 'attention' ? `needs attention, ${engine.message}` : engine.state === 'ready' ? 'ready' : 'checking'}`;
  const engineTone = engine.state === 'attention' ? 'text-warning' : engine.state === 'ready' ? 'text-success' : 'text-base-content/60';

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 border-t border-base-300 py-2">
        <button type="button" className="btn btn-ghost btn-square ovr-nav-icon" aria-label={runtimeName} title={runtimeName} onClick={onOpenRuntime}>
          <span className={RUNTIME_TONE[runtimeState]}>
            <RuntimeIcon size={18} weight="bold" aria-hidden="true" className={runtimeState === 'connecting' ? 'animate-spin' : undefined} />
          </span>
        </button>
        <button type="button" className="btn btn-ghost btn-square ovr-nav-icon" aria-label={engineName} title={engineName} onClick={onOpenSearch}>
          <span className={engineTone}>
            <EngineIcon size={18} weight="bold" aria-hidden="true" />
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 border-t border-base-300 px-2 py-2">
      <button
        type="button"
        className="btn btn-ghost btn-sm h-auto min-h-0 justify-start gap-2.5 py-1.5 text-left font-normal"
        aria-label={runtimeName}
        title={runtimeName}
        onClick={onOpenRuntime}
      >
        <span className={`flex-none ${RUNTIME_TONE[runtimeState]}`}>
          <RuntimeIcon size={18} weight="bold" aria-hidden="true" className={runtimeState === 'connecting' ? 'animate-spin' : undefined} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium">AI runtime</span>
          <span className="block truncate text-xs text-base-content/60">
            {runtimeLabel} {RUNTIME_TEXT[runtimeState]}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm h-auto min-h-0 justify-start gap-2.5 py-1.5 text-left font-normal"
        aria-label={engineName}
        title={engine.state === 'attention' ? engine.message : engineLabel}
        onClick={onOpenSearch}
      >
        <span className={`flex-none ${engineTone}`}>
          <EngineIcon size={18} weight="bold" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium">{engineLabel}</span>
          {engine.state === 'attention' && <span className="block truncate text-xs text-base-content/60">Open Search to fix it</span>}
        </span>
      </button>
    </div>
  );
}

interface NavGroupProps {
  items: readonly NavItem[];
  active: NavPage;
  onNavigate(page: NavPage): void;
  collapsed: boolean;
  counts: WorkspaceCounts | undefined;
}

function NavGroup({ items, active, onNavigate, collapsed, counts }: NavGroupProps) {
  return (
    <div className="flex flex-col gap-0.5 px-2">
      {items.map((item) => {
        const isActive = item.id === active;
        const count = badgeCount(counts, item.badge);
        // Review work and scheduled sends sit on the Applications row so they are visible from
        // every page, not only once the Review queue tab has been opened (#445).
        const attention = item.id === 'applications' ? (counts?.needsReview ?? 0) + (counts?.scheduledSubmissions ?? 0) : 0;
        const label = attention > 0 ? `${item.label}, ${attention} to review` : item.label;
        return (
          <button
            key={item.id}
            type="button"
            aria-label={label}
            title={label}
            {...(isActive ? { 'aria-current': 'page' as const } : {})}
            onClick={() => onNavigate(item.id)}
            className={[
              'btn btn-ghost btn-sm gap-2.5 font-medium',
              // `justify-start` and `justify-center` must never both be present at once: Tailwind
              // resolves conflicting utilities by generated-CSS order, not by class-string order,
              // so having both here left the collapsed icon pinned to the button's start edge
              // instead of centered in its 44px `ovr-nav-icon` box, overriding daisyUI's own
              // centered-by-default `.btn` layout.
              collapsed ? 'ovr-nav-icon relative mx-auto justify-center px-0' : 'w-full justify-start',
              isActive ? 'bg-base-300 text-base-content' : 'text-base-content/70',
            ].join(' ')}
          >
            <NavIcon page={item.id} className="flex-none" />
            {!collapsed && (
              <>
                <span className="truncate">{item.label}</span>
                {attention > 0 && (
                  <span className="badge badge-warning badge-sm ml-auto font-semibold" aria-hidden="true">
                    {attention} to review
                  </span>
                )}
                {count !== undefined && (
                  <span className={`${attention > 0 ? '' : 'ml-auto '}text-xs font-normal text-base-content/60`}>{count}</span>
                )}
              </>
            )}
            {collapsed && attention > 0 && (
              <span className="absolute right-1 top-1 size-2 rounded-full bg-warning" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );
}
