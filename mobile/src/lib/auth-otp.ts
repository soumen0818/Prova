/**
 * Sign-in one-time codes, by EMAIL.
 *
 * **Always goes through the backend**, so development exercises the same path that ships. What the
 * server does depends on its own configuration:
 *
 *  - SMTP configured → a real random code is emailed, and no `devCode` comes back.
 *  - SMTP absent, dev → the fixed dev code is returned so the screen can pre-fill it.
 *  - SMTP absent, production → sign-in is refused with a clear message.
 *
 * Previously this short-circuited on the client in dev and never called the API at all, which meant
 * real email, rate limiting and the code store were untestable without flipping the app into
 * production mode. The only remaining local fallback is for an unreachable backend, so an offline
 * dev loop still works.
 *
 * The email is the account identifier. The phone number collected during KYC is separate — see
 * `requestPhoneOtp` in `api.ts`.
 */
import { ApiError, requestOtp as apiRequestOtp, verifyOtp as apiVerifyOtp } from './api';
import { env } from '@/config/env';

export interface OtpChallenge {
  /** The code to pre-fill, when the server is running without a mail sender. */
  devCode?: string;
}

/** True when the failure was "couldn't reach the server" rather than a rejection. */
function isOffline(e: unknown): boolean {
  return e instanceof ApiError && e.status === 0;
}

/** Kick off a sign-in challenge for an email address. */
export async function requestOtp(email: string): Promise<OtpChallenge> {
  try {
    const res = await apiRequestOtp(email);
    return { devCode: res.devCode };
  } catch (e) {
    // Only an unreachable backend falls back, and only in development. Every real rejection —
    // rate limited, invalid address, provider down — is surfaced with the server's own message.
    if (env.auth.isDev && isOffline(e)) {
      return { devCode: env.auth.devOtp };
    }
    throw e;
  }
}

/**
 * Verify the code.
 *
 * Resolves with whether this address already had an account, so sign-in can offer a restore rather
 * than starting a second wallet on a reinstalled device. Throws an ApiError carrying the server's
 * message on failure.
 */
export async function verifyOtp(
  email: string,
  code: string,
): Promise<{ returning: boolean; token?: string }> {
  const normalized = code.replace(/\D/g, '');
  try {
    const res = await apiVerifyOtp(email, normalized);
    return { returning: res.returning === true, token: res.token };
  } catch (e) {
    if (env.auth.isDev && isOffline(e)) {
      if (normalized !== env.auth.devOtp) {
        throw new ApiError(
          'That code isn’t right. Please check and try again.',
          'unauthenticated',
          401,
        );
      }
      // Offline dev fallback: no server answered, so nothing recognised this address. Treated as
      // new — restoring needs a backend anyway.
      return { returning: false };
    }
    throw e;
  }
}
