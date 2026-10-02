import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem<Id extends string> {
  id: Id;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<Id extends string> {
  /** Accessible name of the tablist. */
  label: string;
  /** Prefix that keeps the tab and panel ids unique on the page. Pair it with `<TabPanel>`. */
  idPrefix: string;
  tabs: ReadonlyArray<TabItem<Id>>;
  value: Id;
  onChange: (id: Id) => void;
  className?: string;
  /** Class names for one tab button. Defaults to the daisyUI `tab` look. */
  tabClassName?: (selected: boolean) => string;
}

export const tabId = (idPrefix: string, id: string) => `${idPrefix}-tab-${id}`;
export const tabPanelId = (idPrefix: string, id: string) => `${idPrefix}-panel-${id}`;

const defaultTabClassName = (selected: boolean) => `tab ${selected ? 'tab-active' : ''}`;

/**
 * Accessible tablist with automatic activation: only the selected tab is in the Tab order, and
 * ArrowLeft, ArrowRight, Home and End move both focus and selection. Disabled tabs are skipped.
 */
export function Tabs<Id extends string>({
  label,
  idPrefix,
  tabs,
  value,
  onChange,
  className,
  tabClassName = defaultTabClassName,
}: TabsProps<Id>) {
  const buttons = useRef(new Map<Id, HTMLButtonElement>());

  const move = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const enabled = tabs.filter((tab) => !tab.disabled);
    if (enabled.length === 0) return;
    const current = enabled.findIndex((tab) => tab.id === tabs[from]?.id);
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (current + 1) % enabled.length;
        break;
      case 'ArrowLeft':
        next = (current - 1 + enabled.length) % enabled.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = enabled.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = enabled[next];
    if (!target) return;
    onChange(target.id);
    buttons.current.get(target.id)?.focus();
  };

  return (
    <div role="tablist" aria-label={label} className={className}>
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) buttons.current.set(tab.id, node);
              else buttons.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={tabId(idPrefix, tab.id)}
            aria-selected={selected}
            aria-controls={tabPanelId(idPrefix, tab.id)}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            className={tabClassName(selected)}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => move(event, index)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  idPrefix: string;
  /** The id of the tab this panel belongs to. */
  id: string;
  className?: string;
  children?: ReactNode;
}

/** The panel for the selected tab, linked back to it with aria-labelledby. */
export function TabPanel({ idPrefix, id, className, children }: TabPanelProps) {
  return (
    <div role="tabpanel" id={tabPanelId(idPrefix, id)} aria-labelledby={tabId(idPrefix, id)} className={className}>
      {children}
    </div>
  );
}
