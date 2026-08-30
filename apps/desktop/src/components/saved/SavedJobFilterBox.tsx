/**
 * Plain-text, case-insensitive substring filter over the role/company of the already-fetched
 * saved-job list. Filtering happens client-side in the parent as the value changes — this
 * component only owns the input itself, mirroring `vacancies/RoleSearchBox.tsx`.
 */
export function SavedJobFilterBox({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="sr-only">Filter by role or company</span>
      <input
        className="input input-sm w-64"
        type="text"
        role="searchbox"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter by role or company"
        aria-label="Filter by role or company"
        disabled={disabled}
      />
    </label>
  );
}
