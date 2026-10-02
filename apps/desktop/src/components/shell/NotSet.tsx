export interface NotSetProps {
  /** Wording that fits the column, for example "Not set", "None" or "Not scored". */
  label?: string;
}

/** Muted text for an empty table cell. Replaces the bare dash, which screen readers read aloud as "em dash". */
export function NotSet({ label = 'Not set' }: NotSetProps) {
  return <span className="text-base-content/50">{label}</span>;
}
