/**
 * Phone-login OTP client. Branches on `env.auth.mode` so the same UI works for dev and prod:
 *
 *  - development: verified on-device against a fixed dev code (no SMS, works offline). The dev phone
 *    and code are pre-filled by the auth screens. Flip to production via `EXPO_PUBLIC_AUTH_MODE`.
 *  - production: OTP is requested + verified through the backend (real SMS provider).
 */
import { requestOtp as apiRequestOtp, verifyOtp as apiVerifyOtp } from './api';
import { env } from '@/config/env';

export interface OtpChallenge {
  /** In development, the code the user should type (pre-fillable). Undefined in production. */
  devCode?: string;
}

/** Kick off an OTP challenge for a phone number. */
export async function requestOtp(phone: string): Promise<OtpChallenge> {
  if (env.auth.isDev) {
    return { devCode: env.auth.devOtp };
  }
  const res = await apiRequestOtp(phone);
  return { devCode: res.devCode };
}

/** Verify the code. Resolves on success, throws on an invalid code. */
export async function verifyOtp(phone: string, code: string): Promise<void> {
  const normalized = code.replace(/\D/g, '');
  if (env.auth.isDev) {
    if (normalized !== env.auth.devOtp) {
      throw new Error('Incorrect code');
    }
    return;
  }
  await apiVerifyOtp(phone, normalized);
}
