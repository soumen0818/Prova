'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef } from 'react';

/** Taps needed, and how long the run may take. Tight enough that nobody arrives here by accident. */
const TAPS_REQUIRED = 3;
const WINDOW_MS = 800;

/**
 * The way into the operator console: triple-tap the footer symbol.
 *
 * ## Why this rather than a link
 *
 * The console must not be advertised on a marketing page, but "type /ops from memory" is a bad
 * answer for the person who actually has to get in — especially on a phone. A triple-tap on an
 * unlabelled mark is undiscoverable by browsing, works on touch and mouse alike, and needs nothing
 * memorised.
 *
 * It is worth being plain about what this is: **it is not a security control.** Anyone can type
 * `/ops/login`. What protects the console is the email-and-password check and the signed session
 * behind it. This only keeps the door from being visible to people who have no business at it.
 */
export function StaffDoor({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const taps = useRef<number[]>([]);

  const onClick = useCallback(() => {
    const now = Date.now();
    // Keep only taps inside the window, so three slow clicks over a minute never add up.
    taps.current = [...taps.current, now].filter((t) => now - t < WINDOW_MS);
    if (taps.current.length >= TAPS_REQUIRED) {
      taps.current = [];
      router.push('/ops/login');
    }
  }, [router]);

  return (
    <span
      onClick={onClick}
      // No label, no role, no tab stop — this is decoration to everyone except the person who
      // knows it is here, and announcing it to a screen reader would defeat the point.
      aria-hidden="true"
      style={{ cursor: 'default', userSelect: 'none', display: 'inline-flex' }}>
      {children}
    </span>
  );
}
