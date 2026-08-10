import type { Metadata, Viewport } from 'next';
import { Urbanist } from 'next/font/google';

import './globals.css';

/**
 * Urbanist is the app's typeface, self-hosted by `next/font` at build time.
 *
 * Loading it from Google's CDN at runtime would put a third party in the render path of every page
 * view and hand them a log of who visited — an odd thing to do on a site whose subject is not being
 * observed.
 */
const urbanist = Urbanist({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-urbanist',
});

export const metadata: Metadata = {
  /*
   * Absolute base for the social-preview image. Without it the OG image resolves against whatever
   * host rendered the page — which in production would be an internal address, so the preview card
   * would come back blank everywhere it was shared. Set NEXT_PUBLIC_SITE_URL when you deploy.
   */
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'),
  title: 'Prova — private, compliant money transfer',
  description:
    'Send money home without publishing what you sent. Prova proves a transfer is compliant on your phone, and settles it on Stellar in seconds.',
  // The same marks the app ships with, so a bookmark and the home-screen icon match.
  icons: {
    icon: '/favicon.png',
    apple: '/brand/symbol.png',
  },
  openGraph: {
    title: 'Prova — private, compliant money transfer',
    description:
      'Send money home without publishing what you sent. Compliance proved on your phone; nothing personal ever leaves it.',
    type: 'website',
    images: ['/brand/symbol.png'],
  },
};

export const viewport: Viewport = {
  themeColor: '#0E0E11',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * `suppressHydrationWarning` is required here, not cosmetic.
     *
     * The inline script below removes `no-js` from this element before React hydrates, so the
     * server-rendered class list and the client's genuinely differ — React reports that as a
     * hydration mismatch. This is the documented escape hatch for exactly this pattern (the same
     * one theme scripts use), and it applies only to this element, so a real mismatch anywhere
     * inside the app is still reported.
     */
    <html lang="en" className={`${urbanist.variable} no-js`} suppressHydrationWarning>
      <head>
        {/*
          Removes the `no-js` class before first paint. The class is what keeps scroll-revealed
          content visible for anyone without JavaScript; dropping it here — inline, before the body
          renders — means the animations arm without a flash of already-visible content.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `document.documentElement.classList.remove('no-js')`,
          }}
        />
      </head>
      <body style={{ fontFamily: 'var(--font-urbanist), var(--font-sans)' }}>{children}</body>
    </html>
  );
}
