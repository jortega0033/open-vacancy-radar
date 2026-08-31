import { CaretLeft, User } from '@phosphor-icons/react';
import type { WorkspaceCounts } from '../../window.js';
import { OpenVacancyRadarMark } from '../brand/OpenVacancyRadarMark.js';
import { NavIcon } from './NavIcon.js';
import { badgeCount, PRIMARY_NAV, SECONDARY_NAV, type NavItem, type NavPage } from './nav.js';
import type { RuntimeState } from './WorkspaceHeader.js';

const RUNTIME_TEXT: Record<RuntimeState, string> = {
  connecting: 'starting',
  ready: 'ready',
  unavailable: 'unavailable',
  'not-installed': 'not installed',
  'not-authenticated': 'not authenticated',
};

export interface AppSidebarProps {
  active: NavPage;
  onNavigate(page: NavPage): void;
  collapsed: boolean;
  onToggleCollapsed(): void;
  counts: WorkspaceCounts;
  /** e.g. "Claude Code": the provider the AI features would use right now. */
  runtimeLabel: string;
  /** The one place this now shows: distinguishes an unreachable daemon from a daemon that's fine
   * but has no CLI installed/authenticated, so this never claims "ready" when nothing is. */
  runtimeState: RuntimeState;
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
}: AppSidebarProps) {
  const runtimeReady = runtimeState === 'ready';
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

      <div
        className={`border-t border-base-300 ${collapsed ? 'flex flex-col items-center gap-1.5 py-3' : 'flex items-center gap-2 px-3.5 py-3'}`}
      >
        <div className="relative flex-none">
          <div
            className="flex size-7 items-center justify-center rounded-full bg-base-300 text-base-content/70"
            aria-label="Local profile"
          >
            <User size={15} weight="bold" aria-hidden="true" />
          </div>
          <span
            className={`absolute right-0 bottom-0 size-2 rounded-full border-2 border-base-200 ${runtimeReady ? 'bg-success' : 'bg-base-content/30'}`}
            aria-hidden="true"
          />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">Local profile</div>
            <div className="truncate text-xs text-base-content/50">
              {runtimeLabel} {RUNTIME_TEXT[runtimeState]}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

interface NavGroupProps {
  items: readonly NavItem[];
  active: NavPage;
  onNavigate(page: NavPage): void;
  collapsed: boolean;
  counts: WorkspaceCounts;
}

function NavGroup({ items, active, onNavigate, collapsed, counts }: NavGroupProps) {
  return (
    <div className="flex flex-col gap-0.5 px-2">
      {items.map((item) => {
        const isActive = item.id === active;
        const count = badgeCount(counts, item.badge);
        return (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            title={item.label}
            {...(isActive ? { 'aria-current': 'page' as const } : {})}
            onClick={() => onNavigate(item.id)}
            className={[
              'btn btn-ghost btn-sm gap-2.5 font-medium',
              // `justify-start` and `justify-center` must never both be present at once: Tailwind
              // resolves conflicting utilities by generated-CSS order, not by class-string order,
              // so having both here left the collapsed icon pinned to the button's start edge
              // instead of centered in its 44px `ovr-nav-icon` box, overriding daisyUI's own
              // centered-by-default `.btn` layout.
              collapsed ? 'ovr-nav-icon mx-auto justify-center px-0' : 'w-full justify-start',
              isActive ? 'bg-base-300 text-base-content' : 'text-base-content/70',
            ].join(' ')}
          >
            <NavIcon page={item.id} className="flex-none" />
            {!collapsed && (
              <>
                <span className="truncate">{item.label}</span>
                {count !== undefined && (
                  <span className="ml-auto text-xs font-normal text-base-content/50">{count}</span>
                )}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
