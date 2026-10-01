import {
  BookmarkSimple,
  Cpu,
  EnvelopeSimple,
  FileText,
  GearSix,
  ListChecks,
  MagnifyingGlass,
  Terminal,
  type Icon,
} from '@phosphor-icons/react';
import type { NavPage } from './nav.js';

/**
 * One Phosphor icon per destination, "regular" weight (the default) to match the app's flat,
 * near-monochrome aesthetic. Every Phosphor icon renders with `color: currentColor` by default, so
 * it inherits whatever `text-*` token its button carries and needs no per-theme handling, the
 * same property the hand-drawn icons this replaced relied on.
 */
const NAV_ICON: Record<NavPage, Icon> = {
  search: MagnifyingGlass,
  saved: BookmarkSimple,
  applications: ListChecks,
  cv: FileText,
  letters: EnvelopeSimple,
  // A terminal, not a robot: the thing running is the user's own CLI, in a folder they approved.
  'agent-workspace': Terminal,
  runtime: Cpu,
  settings: GearSix,
};

export function NavIcon({ page, className }: { page: NavPage; className?: string }) {
  const Icon = NAV_ICON[page];
  return <Icon className={className} size={16} aria-hidden="true" />;
}
