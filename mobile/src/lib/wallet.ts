/**
 * Wallet identity — the ZK secret that everything (commitment, nullifier, KYC user id) derives from.
 *
 * The secret is generated with a **cryptographically secure RNG** (`expo-crypto`) — never
 * `Math.random` — and stored only in the secure enclave (`expo-secure-store`). It never leaves the
 * device. Go through this module; screens should not touch the secret key directly.
 */
import * as Crypto from 'expo-crypto';

import { deleteSecret, getSecret, hasSecret, SecureKey, setSecret } from './secure-store';

/** `byteLength` secure-random bytes as lowercase hex. */
export function secureRandomHex(byteLength = 32): string {
  const bytes = Crypto.getRandomBytes(byteLength);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** A secure-random u64 as a decimal string (safe for BigInt/u64 consumers like the prover). */
export function secureRandomU64(): string {
  const bytes = Crypto.getRandomBytes(8);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v.toString();
}

/** Read the wallet secret, creating one securely on first use. */
export async function getOrCreateSecret(): Promise<string> {
  const existing = await getSecret(SecureKey.zkSecretKey);
  if (existing) return existing;
  const secret = secureRandomHex(32);
  await setSecret(SecureKey.zkSecretKey, secret);
  return secret;
}

/** Read the wallet secret without creating one (null if no wallet yet). */
export function getSecretOrNull(): Promise<string | null> {
  return getSecret(SecureKey.zkSecretKey);
}

/** Whether a wallet secret exists on this device. */
export function hasWallet(): Promise<boolean> {
  return hasSecret(SecureKey.zkSecretKey);
}

/** Wipe wallet + account material from the enclave (sign-out / reset). */
export async function resetWallet(): Promise<void> {
  await deleteSecret(SecureKey.zkSecretKey);
  await deleteSecret(SecureKey.kycCredential);
  await deleteSecret(SecureKey.stellarSecret);
  await deleteSecret(SecureKey.session);
  await deleteSecret(SecureKey.balance);
  await deleteSecret(SecureKey.recipients);
}
