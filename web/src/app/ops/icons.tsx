/**
 * Icons for the console.
 *
 * Inline SVG rather than an icon package: a handful of glyphs at one or two sizes, in a tool with
 * three screens. Shipping a dependency to draw them would cost every page load more than the icons
 * are worth.
 *
 * All of them are decorative — every icon here sits beside a text label — so they carry
 * `aria-hidden` and are never the only way to understand a control.
 */

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

type Props = { size?: number };

export function GridIcon({ size = 18 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function ShieldIcon({ size = 18 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function ChatIcon({ size = 18 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-5.5A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8Z" />
    </svg>
  );
}

export function ArrowRightIcon({ size = 15 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function ArrowLeftIcon({ size = 15 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  );
}

export function CheckIcon({ size = 22 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

export function InboxIcon({ size = 22 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <path d="M3 13h5l2 3h4l2-3h5" />
      <path d="M5 5h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l2-8Z" />
    </svg>
  );
}

export function InfoIcon({ size = 16 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

export function AlertIcon({ size = 18 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...base}>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}
