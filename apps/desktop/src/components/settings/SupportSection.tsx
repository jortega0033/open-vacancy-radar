import { COFFEE_URL, REPOSITORY_URL } from '../../support-links.js';
import { applySupportEvent } from '../support/support-store.js';
import { SettingsRow, SettingsSection } from './controls.js';

/**
 * The permanent home of the Support links (#503), so a person who dismissed the dialog can still
 * find them. Plain anchors that open in the system browser through the existing window-open
 * handler. Clicking one records `answered` so the dialog stays away; it never touches the other
 * counters, and a failed write is ignored because the link has already opened.
 */
export function SupportSection() {
  const recordAnswered = () => {
    void applySupportEvent('answered').catch(() => {});
  };
  return (
    <SettingsSection title="Support">
      <SettingsRow label="OVR is free and open source.">
        <div className="flex gap-2">
          <a
            className="btn btn-outline btn-sm"
            href={REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={recordAnswered}
          >
            Star on GitHub
          </a>
          <a
            className="btn btn-outline btn-sm"
            href={COFFEE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={recordAnswered}
          >
            Buy me a coffee
          </a>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
