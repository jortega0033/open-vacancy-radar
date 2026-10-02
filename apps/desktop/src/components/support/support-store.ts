import {
  nextSupportState,
  readSupportPrompt,
  type SupportPromptEvent,
  type SupportPromptState,
} from '../../../electron/workspace/support-prompt.js';
import type { AppSettingsRecord } from '../../window.js';

/**
 * Read-modify-write of the stored Support ask state. Reads the current value every time rather
 * than trusting a copy held in memory, so a click on a Support link in Settings and a success
 * moment in the shell can never overwrite each other with a stale counter. Returns the settings
 * row the write produced.
 */
export async function applySupportEvent(event: SupportPromptEvent): Promise<AppSettingsRecord> {
  const current = await window.workspace.getSettings();
  // Read tolerantly: a settings row from an older build or a stub may carry no value at all.
  const before = readSupportPrompt(current.supportPrompt);
  const next: SupportPromptState = nextSupportState(before, event);
  if (next === before) return current;
  return window.workspace.updateSettings({ supportPrompt: next });
}
