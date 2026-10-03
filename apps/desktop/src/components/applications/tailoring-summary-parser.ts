/**
 * Parses tailoring summary text to extract and categorize removed items.
 */

export interface RemovedItemGroup {
  kind: 'skill' | 'bullet' | 'summary';
  label: string;
  items: string[];
  count: number;
}

export interface ParsedTailoringSummary {
  base: string;
  removedGroups: RemovedItemGroup[];
  hasRemovals: boolean;
}

/**
 * Parses a tailoring summary string to extract removed items and group them by kind.
 * Handles text like:
 * - "CV tailored for this vacancy. Removed unsupported output: skill "React" is not in your reviewed CV profile; skill "TypeScript" is not in your reviewed CV profile."
 * - "Original reviewed CV used by your explicit choice after automatic tailoring stopped. Removed unsupported output: summary rewrite was not an exact reviewed fact."
 */
export function parseTailoringSummary(detail: string): ParsedTailoringSummary {
  const removeMarker = ' Removed unsupported output: ';
  const baseAndRemoved = detail.split(removeMarker);

  if (baseAndRemoved.length === 1) {
    return {
      base: detail,
      removedGroups: [],
      hasRemovals: false,
    };
  }

  const base = baseAndRemoved[0]!;
  const removedText = baseAndRemoved.slice(1).join(removeMarker);

  // Remove trailing period if present
  const cleanedRemoved = removedText.endsWith('.') ? removedText.slice(0, -1) : removedText;

  // Split on semicolon to get individual items
  const items = cleanedRemoved
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  // Group by kind
  const groups = new Map<'skill' | 'bullet' | 'summary', string[]>();

  for (const item of items) {
    if (item.startsWith('skill "')) {
      // Extract skill name from: skill "React" is not in your reviewed CV profile
      const match = item.match(/^skill "([^"]+)"/);
      const skillName = match?.[1] ?? item;
      const list = groups.get('skill') ?? [];
      list.push(skillName);
      groups.set('skill', list);
    } else if (item.startsWith('rewritten bullet')) {
      // Extract from: rewritten bullet for "Title at Company" was not an exact reviewed fact
      const match = item.match(/for "([^"]+)"/);
      const bulletDesc = match?.[1] ?? item;
      const list = groups.get('bullet') ?? [];
      list.push(bulletDesc);
      groups.set('bullet', list);
    } else if (item.includes('summary')) {
      const list = groups.get('summary') ?? [];
      list.push(item);
      groups.set('summary', list);
    }
  }

  const removedGroups: RemovedItemGroup[] = [];

  if (groups.has('skill')) {
    const skillItems = groups.get('skill')!;
    removedGroups.push({
      kind: 'skill',
      label: skillItems.length === 1 ? 'skill' : 'skills',
      items: skillItems,
      count: skillItems.length,
    });
  }

  if (groups.has('bullet')) {
    const bulletItems = groups.get('bullet')!;
    removedGroups.push({
      kind: 'bullet',
      label: bulletItems.length === 1 ? 'bullet' : 'bullets',
      items: bulletItems,
      count: bulletItems.length,
    });
  }

  if (groups.has('summary')) {
    removedGroups.push({
      kind: 'summary',
      label: 'summary',
      items: groups.get('summary')!,
      count: 1,
    });
  }

  return {
    base,
    removedGroups,
    hasRemovals: removedGroups.length > 0,
  };
}

/**
 * Creates a human-readable summary of removed items.
 * Example: "42 items were left out of your CV"
 */
export function formatRemovalSummary(groups: RemovedItemGroup[]): string {
  if (groups.length === 0) return '';

  if (groups.length === 1) {
    const group = groups[0]!;
    if (group.kind === 'skill') {
      return `${group.count} ${group.label} from this vacancy ${group.count === 1 ? 'is' : 'are'} not in your CV`;
    }
    if (group.kind === 'bullet') {
      return `${group.count} ${group.label} from this vacancy ${group.count === 1 ? 'is' : 'are'} not in your CV`;
    }
    if (group.kind === 'summary') {
      return 'Your CV summary could not be tailored for this vacancy';
    }
    return '';
  }

  // Multiple groups
  const parts: string[] = [];
  for (const group of groups) {
    if (group.kind === 'skill') {
      parts.push(`${group.count} ${group.label}`);
    } else if (group.kind === 'bullet') {
      parts.push(`${group.count} ${group.label}`);
    } else if (group.kind === 'summary') {
      parts.push('your summary');
    }
  }

  return parts.length > 0 ? `${parts.join(', ')} could not be used for this vacancy` : '';
}
