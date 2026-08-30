import type { SVGProps } from 'react';

export interface OpenVacancyRadarMarkProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
  /** Give the mark an accessible name when it carries meaning. Omit for decorative use. */
  label?: string;
}

/** Compact product mark that works in each theme and appears in the application shell. */
export function OpenVacancyRadarMark({ size = 22, label, ...props }: OpenVacancyRadarMarkProps) {
  return (
    <svg
      {...props}
      data-testid="open-vacancy-radar-mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      focusable="false"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle
        cx="30"
        cy="34"
        r="19"
        stroke="currentColor"
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeDasharray="91 29"
        transform="rotate(-48 30 34)"
      />
      <circle cx="30" cy="34" r="4.5" fill="currentColor" />
      <rect x="45" y="11" width="10" height="10" rx="2.7" fill="currentColor" />
    </svg>
  );
}
