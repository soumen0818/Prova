import Image from 'next/image';
import Link from 'next/link';

import { CONTACT_EMAIL } from '@/lib/site';

import { StaffDoor } from './staff-door';

const NAV_LINKS = [
  { href: '/about', label: 'About' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/contact', label: 'Contact' },
];

/**
 * The site header.
 *
 * Uses the real brand symbol and wordmark rather than a CSS approximation, so the site and the app
 * icon on someone's home screen are visibly the same product. Both are served from `public/brand`,
 * copied from `mobile/assets/images` — the app is the source of truth for the marks.
 */
export function SiteHeader() {
  return (
    <header className="nav">
      <div className="page nav-inner">
        <Link href="/" className="logo" aria-label="Prova home">
          <Image
            src="/brand/symbol.png"
            alt=""
            width={34}
            height={34}
            className="logo-symbol"
            priority
          />
          <Image
            src="/brand/wordmark.png"
            alt="Prova"
            width={104}
            height={30}
            className="logo-wordmark"
            priority
          />
        </Link>

        <nav className="nav-links">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
          <Link className="btn btn-primary btn-sm" href="/#get-the-app">
            Get the app
          </Link>
        </nav>
      </div>
    </header>
  );
}

/**
 * The site footer.
 *
 * The brand symbol here doubles as the way into the operator console — see `StaffDoor`. Nothing is
 * labelled, so the console stays unadvertised, but there is a reliable way in that does not depend
 * on remembering a URL.
 */
/** Small padlock for the staff link — inline so the footer pulls in no icon dependency. */
function LockIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="page">
        <div className="footer-top">
          <div className="footer-brand">
            <StaffDoor>
              <Image src="/brand/symbol.png" alt="" width={30} height={30} />
            </StaffDoor>
            <p className="muted">
              Private, compliant money transfer.
              <br />
              Running on the Stellar test network.
            </p>
          </div>

          <div className="footer-cols">
            <div>
              <h4>Product</h4>
              <Link href="/how-it-works">How it works</Link>
              <Link href="/#privacy">Privacy by design</Link>
              <Link href="/#get-the-app">Get the app</Link>
              {/*
                Staff entrance to the operator console.

                Visible on purpose, at the owner's request. It costs nothing security-wise: the
                console was never protected by being hard to find — it is protected by the
                email-and-password check and the signed session behind this link. What being
                visible does change is that the public now knows the console exists, so the sign-in
                page deliberately says nothing about what is behind it.
              */}
              <Link href="/ops" className="footer-ops">
                <LockIcon />
                Monitoring
              </Link>
            </div>
            <div>
              <h4>Company</h4>
              <Link href="/about">About</Link>
              <Link href="/contact">Contact</Link>
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            </div>
            <div>
              <h4>Legal</h4>
              <Link href="/privacy">Privacy Policy</Link>
              <Link href="/terms">Terms of Service</Link>
              <a href="https://stellar.org" target="_blank" rel="noreferrer noopener">
                Built on Stellar
              </a>
            </div>
          </div>
        </div>

        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} Prova. All rights reserved.</span>
          <span>Test assets only — they have no monetary value.</span>
        </div>
      </div>
    </footer>
  );
}
