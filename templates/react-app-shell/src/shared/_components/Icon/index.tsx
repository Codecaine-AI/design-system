import type { ReactNode } from 'react';

export type IconName = 'dashboard' | 'list' | 'chart' | 'wallet' | 'link' | 'bot' | 'settings';

export type IconProps = {
  name: IconName;
};

// Example glyphs for the template's nav, drawn on a 24px grid. Swap in your
// app's icon set; the shell only needs an <svg> that strokes currentColor.
const glyphs: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="4" y="4" width="7" height="16" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  list: (
    <>
      <path d="M9 7h11M9 12h11M9 17h11" />
      <circle cx="5" cy="7" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="17" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  chart: (
    <>
      <rect x="4" y="13" width="4" height="7" rx="1" />
      <rect x="10" y="9" width="4" height="11" rx="1" />
      <rect x="16" y="4" width="4" height="16" rx="1" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="5.5" width="18" height="14" rx="2.5" />
      <path d="M21 10.5h-4.5a2 2 0 0 0 0 4H21" />
      <circle cx="17" cy="12.5" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  link: (
    <g transform="rotate(-45 12 12)">
      <rect x="2.5" y="8.5" width="11" height="7" rx="3.5" />
      <rect x="10.5" y="8.5" width="11" height="7" rx="3.5" />
    </g>
  ),
  bot: (
    <>
      <rect x="4.5" y="8" width="15" height="11" rx="3" />
      <path d="M12 8V5M10.5 16h3" />
      <circle cx="12" cy="4" r="1" />
      <circle cx="9.5" cy="13" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="13" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  settings: (
    <>
      <path d="M6 4v4M6 12v8M12 4v10M12 18v2M18 4v2M18 10v10" />
      <circle cx="6" cy="10" r="2" />
      <circle cx="12" cy="16" r="2" />
      <circle cx="18" cy="8" r="2" />
    </>
  ),
};

export function Icon({ name }: IconProps) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyphs[name]}
    </svg>
  );
}
