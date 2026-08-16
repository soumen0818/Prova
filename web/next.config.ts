import type { NextConfig } from 'next';

/**
 * The operator console lives in the same deployment as the marketing site but must never be
 * indexed or advertised: `X-Robots-Tag` here is belt-and-braces alongside `robots.ts`, because a
 * crawler that reaches a /ops URL some other way (a shared link, a referrer log) never sees the
 * page's own meta tag if it is behind the login redirect.
 */
const nextConfig: NextConfig = {
  /*
   * Bundle a self-contained server into `.next/standalone`, so the runtime image can ship without
   * node_modules. Next traces exactly the files that are reached at runtime; copying the whole
   * dependency tree instead would put ~400 MB on a 2 GB server for no benefit.
   */
  output: 'standalone',

  /*
   * Dev and production builds get separate output directories.
   *
   * They shared `.next` by default, which meant running `next build` while `next dev` was running
   * overwrote the dev server's chunks underneath it. The dev server kept serving HTML referencing
   * chunk names that no longer existed, so the next hard refresh died with
   * "Cannot find module './195.js'" — a confusing failure with no obvious cause, and one that
   * survives until you delete `.next` by hand.
   *
   * `next start` runs with NODE_ENV=production and so reads `.next`, exactly as before; only the
   * dev server moves. Deployment is unaffected.
   */
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/ops/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};

export default nextConfig;
