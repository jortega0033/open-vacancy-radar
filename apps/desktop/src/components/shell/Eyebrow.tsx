import type { ElementType, ReactNode } from 'react';

export interface EyebrowProps {
  children: ReactNode;
  /** Element to render. Defaults to `span`; use a heading only when the label starts a real section. */
  as?: ElementType;
  className?: string;
}

/** The small uppercase label used above groups of fields and list sections. */
export function Eyebrow({ children, as: Tag = 'span', className }: EyebrowProps) {
  return <Tag className={['ovr-eyebrow', className].filter(Boolean).join(' ')}>{children}</Tag>;
}
