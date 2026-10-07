import { useEffect, useRef } from 'react';
import { SettingsRow, SettingsSection } from './controls.js';

export interface SearchProfileLinkProps {
  /** Opens the CV page, where "What you are looking for" lives. Hidden when not provided. */
  onOpenCvPage?: () => void;
  /** Opened from a "set up your profile" prompt: land on this section's heading. */
  focusOnOpen?: boolean;
}

/**
 * What Settings > Search keeps of the profile (#635): a pointer to the short summary on the CV page,
 * not the form itself.
 */
export function SearchProfileLink({ onOpenCvPage, focusOnOpen }: SearchProfileLinkProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!focusOnOpen) return;
    headingRef.current?.focus();
    headingRef.current?.scrollIntoView?.({ block: 'center' });
  }, [focusOnOpen]);

  return (
    <SettingsSection title="What you are looking for" headingRef={headingRef}>
      <SettingsRow
        label="Roles, country and skills"
        description="Used to rank jobs for you. You see it and edit it on the CV page."
      >
        {onOpenCvPage && (
          <button type="button" className="btn btn-outline btn-sm" onClick={onOpenCvPage}>
            Open on CV page
          </button>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
