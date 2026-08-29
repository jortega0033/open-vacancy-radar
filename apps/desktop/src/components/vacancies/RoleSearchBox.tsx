/**
 * Plain-text, case-insensitive substring filter over the titles of the already-fetched report.
 * Filtering happens client-side in the parent as the value changes — this component only owns
 * the input itself.
 */
export function RoleSearchBox({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-sm font-medium">Filter by role title</span>
      <input
        className="input w-full"
        type="text"
        role="searchbox"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. frontend, react, staff engineer…"
        disabled={disabled}
      />
    </label>
  );
}
