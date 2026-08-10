import 'server-only';

import { headers } from 'next/headers';

/**
 * A small in-process rate limiter for public form submissions.
 *
 * ## Why this exists here and not in the backend
 *
 * The Go backend already limits by IP — but every contact-form submission reaches it from the
 * **Next.js server's** address, not the visitor's. So to the backend the whole website looks like
 * one client: the limit would never protect against a spammer, and worse, one spammer hitting it
 * would lock out every genuine visitor at once. A limit on public form abuse has to be applied
 * where the visitor's own address is still visible, which is here.
 *
 * ## What this is not
 *
 * It is in-memory, so it resets on deploy and is per-instance — two instances mean twice the
 * allowance. That is a real limitation and it is the right trade for now: this is one server, and a
 * shared Redis counter would be infrastructure to run and monitor for a form that receives a
 * handful of messages a day. When the site is replicated, move the counter to the same Redis the
 * backend already uses. What this does defeat is the actual threat today — a script posting the
 * same form in a loop.
 */

interface Bucket {
  /** Submission timestamps inside the window, oldest first. */
  hits: number[];
}

const buckets = new Map<string, Bucket>();

/** Drop buckets nothing has touched for a while, so an idle server does not grow forever. */
function sweep(now: number, windowMs: number): void {
  for (const [key, bucket] of buckets) {
    const live = bucket.hits.filter((t) => now - t < windowMs);
    if (live.length === 0) buckets.delete(key);
    else bucket.hits = live;
  }
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the next attempt would be allowed. Only meaningful when `allowed` is false. */
  retryAfterSeconds: number;
}

/**
 * Allow at most `limit` events per `windowMs` for `key`.
 *
 * A sliding window rather than a fixed one: with fixed windows, a script can send its whole
 * allowance at the end of one window and again at the start of the next, doubling the real rate at
 * exactly the moment somebody is watching.
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  // Cheap enough to run on each call at this volume, and it keeps the map bounded without a timer
  // that would keep a serverless instance alive.
  sweep(now, windowMs);

  const bucket = buckets.get(key) ?? { hits: [] };
  const hits = bucket.hits.filter((t) => now - t < windowMs);

  if (hits.length >= limit) {
    const oldest = hits[0];
    buckets.set(key, { hits });
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)),
    };
  }

  hits.push(now);
  buckets.set(key, { hits });
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * The visitor's IP address, as best the request reveals it.
 *
 * Proxy headers are attacker-controlled unless a proxy you trust overwrote them, so behind a CDN
 * take the **first** entry of `x-forwarded-for` (the client) and accept that a direct-to-origin
 * request can spoof it. That is why the limiter below is one signal among several rather than the
 * only defence — the honeypot and the per-address limit do not depend on the IP being truthful.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return h.get('x-real-ip') ?? 'unknown';
}
