import type { MetadataRoute } from 'next';

/**
 * Keeps the operator console out of search results.
 *
 * This is politeness to well-behaved crawlers, not access control — a `Disallow` line is a public
 * list of paths worth trying. The console is actually protected by the password and the signed
 * session; this only stops it turning up in someone's search for "Prova".
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/ops' },
  };
}
