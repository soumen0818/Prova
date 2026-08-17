'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { GetAppButton } from '@/components/get-app-button';

/**
 * Navigation for narrow screens.
 *
 * Below 760px the header's links were simply `display: none`, leaving only the download button —
 * so a visitor on a phone could reach About, How it works and Contact from the footer or not at
 * all. The site was responsive in the sense that nothing overflowed, and unusable in the sense that
 * most of it could not be reached.
 *
 * A disclosure panel rather than a full-screen drawer: there are three links, and a slide-over that
 * covers the page for three links is theatre. It opens under the header, pushes nothing, and closes
 * on selection, on Escape, or on the next route change.
 */
export function MobileNav({ links }: { links: { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close when navigation happens. Without this the panel stays open over the new page, because
  // the header is not remounted between routes.
  useEffect(() => setOpen(false), [pathname]);

  // Escape closes it, which is the behaviour anyone who uses a keyboard will try first.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="mobile-nav">
      <button
        type="button"
        className="mobile-nav-toggle"
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        aria-label={open ? 'Close menu' : 'Open menu'}
        onClick={() => setOpen((v) => !v)}>
        {/*
          Two bars that become an X. `aria-hidden` because the button's own label already says what
          this does — announcing the decorative bars as well would just be noise.
        */}
        <span className={`burger${open ? ' is-open' : ''}`} aria-hidden="true">
          <span />
          <span />
        </span>
      </button>

      <div id="mobile-nav-panel" className={`mobile-nav-panel${open ? ' is-open' : ''}`} hidden={!open}>
        {links.map((link) => (
          <Link key={link.href} href={link.href} className="mobile-nav-link">
            {link.label}
          </Link>
        ))}
        <GetAppButton className="btn btn-primary mobile-nav-cta" />
      </div>
    </div>
  );
}
