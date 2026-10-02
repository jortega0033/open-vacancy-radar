import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface MenuItem {
  key: string;
  label: ReactNode;
  /** May return a promise: the menu then stays open, with the chosen item focused, until it settles. */
  onSelect: () => void | Promise<unknown>;
}

export interface MenuProps {
  /** Content of the trigger button; it also supplies the trigger's accessible name. */
  trigger: ReactNode;
  items: ReadonlyArray<MenuItem>;
  disabled?: boolean;
  /** Class names for the trigger button. */
  triggerClassName?: string;
  /** Class names for the popup list (width, spacing). */
  menuClassName?: string;
  /** Class names for the element that wraps the trigger and the popup. */
  className?: string;
}

/**
 * Action menu opened by a button. Enter, Space, click or ArrowDown/ArrowUp on the trigger open it
 * and focus an item; ArrowUp/ArrowDown/Home/End move between items; Enter or Space on an item runs
 * it; Escape closes and returns focus to the trigger; Tab or a click outside closes it. When an item
 * returns a promise, the menu stays open on that item until the promise settles, then closes and
 * returns focus to the trigger.
 */
export function Menu({
  trigger,
  items,
  disabled,
  triggerClassName,
  menuClassName = '',
  className = '',
}: MenuProps) {
  const id = useId();
  const triggerId = `${id}-trigger`;
  const menuId = `${id}-menu`;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusOnOpen = useRef<'first' | 'last'>('first');
  const returnFocus = useRef(false);

  useEffect(() => {
    if (open) {
      const list = itemRefs.current.filter((node): node is HTMLButtonElement => node !== null);
      (focusOnOpen.current === 'last' ? list[list.length - 1] : list[0])?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const close = useCallback((restoreFocus: boolean) => {
    returnFocus.current = restoreFocus;
    setOpen(false);
  }, []);

  const openWith = (which: 'first' | 'last') => {
    focusOnOpen.current = which;
    setOpen(true);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openWith(event.key === 'ArrowDown' ? 'first' : 'last');
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const list = itemRefs.current.filter((node): node is HTMLButtonElement => node !== null);
    const current = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = (current + 1) % list.length;
        break;
      case 'ArrowUp':
        next = (current - 1 + list.length) % list.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = list.length - 1;
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    if (!pending) list[next]?.focus();
  };

  const select = (item: MenuItem) => {
    if (pending) return;
    const result = item.onSelect();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      setPending(true);
      const settle = () => {
        setPending(false);
        close(true);
      };
      (result as Promise<unknown>).then(settle, settle);
    } else {
      close(true);
    }
  };

  return (
    <div ref={wrapperRef} className={`relative inline-block ${className}`}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(true) : openWith('first'))}
        onKeyDown={onTriggerKeyDown}
      >
        {trigger}
      </button>
      {open && (
        <ul
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          className={`menu absolute right-0 z-10 mt-1 bg-base-100 rounded-box border border-base-300 p-2 shadow ${menuClassName}`}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <li key={item.key} role="none">
              <button
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={pending || undefined}
                onClick={() => select(item)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
