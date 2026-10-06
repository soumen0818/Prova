/**
 * KYC credential lifecycle on the device (Docs/kyc-verification.md §7).
 *
 * The credential is short-lived (90 days) **on purpose**: it lives in this phone's enclave and the
 * circuit only checks `expiry >= currentTime`, so there is no way to revoke it remotely. A short
 * window limits how long the demo credential can be used. There is no real identity
 * re-screening or automatic renewal in this build.
 *
 * Rule of thumb for callers: never read the credential directly from the enclave — go through
 * `getUsableCredential()`, which drops expired credentials. The user must request
 * another operator-approved test credential after expiry.
 */
import { fetchCredential, type KycCredential } from './api';
import { getSecret, SecureKey, setSecret, deleteSecret } from './secure-store';

const DAY_SECONDS = 24 * 60 * 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Read the stored credential, or null if absent/corrupt. */
export async function getStoredCredential(): Promise<KycCredential | null> {
  const raw = await getSecret(SecureKey.kycCredential);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as KycCredential;
  } catch {
    return null;
  }
}

/** Persist a credential to the secure enclave. */
export async function storeCredential(cred: KycCredential): Promise<void> {
  await setSecret(SecureKey.kycCredential, JSON.stringify(cred));
}

/** Remove the credential (rejection, revocation, or reset). */
export async function clearCredential(): Promise<void> {
  await deleteSecret(SecureKey.kycCredential);
}

/** True once the credential has expired — the circuit would reject any proof built with it. */
export function isExpired(cred: KycCredential, at = nowSeconds()): boolean {
  return cred.expiry <= at;
}

/** Whole days left before expiry (0 if already expired). */
export function daysRemaining(cred: KycCredential, at = nowSeconds()): number {
  return Math.max(0, Math.floor((cred.expiry - at) / DAY_SECONDS));
}

/**
 * The credential to prove with, or null if the user must (re-)verify.
 *
 * Expired credentials are dropped rather than returned, so a stale credential can never be used to
 * build a proof the contract would reject. The demo does not silently extend credentials.
 */
export async function getUsableCredential(userId: string): Promise<KycCredential | null> {
  const cred = await getStoredCredential();
  if (!cred) return null;

  if (isExpired(cred)) {
    await clearCredential();
    return null;
  }

  if (cred.userId !== userId) return null;

  return cred;
}

/**
 * Collect the credential after a verification is approved. Returns null if the backend refuses
 * (403 = not approved), which is the gate working as designed — not a client error.
 */
export async function collectCredential(userId: string): Promise<KycCredential | null> {
  try {
    const cred = await fetchCredential(userId);
    if (cred.userId !== userId || isExpired(cred)) return null;
    await storeCredential(cred);
    return cred;
  } catch {
    return null;
  }
}
