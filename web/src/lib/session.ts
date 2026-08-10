import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * Operator sign-in.
 *
 * ## Why a single password and no user accounts
 *
 * One person runs this console. Per-user accounts would mean a user table, a password reset flow and
 * an invite flow, all to distinguish one operator from themselves — structure with nothing on the
 * other side of it. When a second person joins, the thing to add is real accounts, not a second
 * shared password; the audit trail already has an `actor` column waiting for a name.
 *
 * ## What protects it
 *
 * The password is compared in constant time and never leaves the server. The cookie holds no
 * credential — only an expiry and an HMAC over it, keyed by `OPS_SESSION_SECRET` — so a stolen
 * cookie cannot be extended and cannot be forged without the secret. It is `httpOnly`, `sameSite`
 * strict, and `secure` outside development.
 */

const COOKIE = 'prova_ops';
/** Eight hours: a working day, after which an unattended browser stops being a way in. */
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function secret(): string {
  const value = process.env.OPS_SESSION_SECRET ?? '';
  if (!value) {
    // Refuses rather than falling back to a default key. A signing secret with a known value is not
    // a degraded session — it is a forgeable one, and it would fail open silently.
    throw new Error('OPS_SESSION_SECRET is not set — the operator console cannot sign sessions.');
  }
  return value;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('hex');
}

/** Constant-time equality that tolerates length differences without leaking them through timing. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Still burn a comparison so a wrong-length guess is not measurably faster than a wrong value.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Check an operator's email and password against the configured credentials.
 *
 * Both must match. Two factors of the same kind is not two factors — anyone who learns the password
 * has to know the address too, which is a modest bar but a real one against someone who finds the
 * login page and starts guessing.
 *
 * Unset credentials deny everything. That is deliberate: the alternative — treating "nothing
 * configured" as "nothing required" — turns a missing environment variable into an open console,
 * which is exactly the mistake this project already documents for COMPLIANCE_TOKEN.
 *
 * Both comparisons always run, and the result is combined at the end rather than returned early, so
 * the time taken does not reveal whether it was the address or the password that was wrong.
 */
export function credentialsMatch(email: string, password: string): boolean {
  const expectedEmail = (process.env.OPS_EMAIL ?? '').trim().toLowerCase();
  const expectedPassword = process.env.OPS_PASSWORD ?? '';
  if (!expectedEmail || !expectedPassword) return false;

  const emailOk = safeEqual(email.trim().toLowerCase(), expectedEmail);
  const passwordOk = safeEqual(password, expectedPassword);
  return emailOk && passwordOk;
}

/** Issue a session cookie. */
export async function createSession(): Promise<void> {
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = String(expiresAt);
  const jar = await cookies();
  jar.set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Drop the session cookie. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

/** Whether the current request carries a valid, unexpired session. */
export async function isSignedIn(): Promise<boolean> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return false;

  const [payload, mac] = raw.split('.');
  if (!payload || !mac) return false;
  if (!safeEqual(mac, sign(payload))) return false;

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}
