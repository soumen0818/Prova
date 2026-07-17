/**
 * Wallet identity — one master seed, from which the ZK secret and the Stellar key are derived
 * (see Docs/account-recovery.md). The master is the single secret we back up; the ZK secret keeps
 * its existing hex format so the prover interface is unchanged.
 *
 * The master is generated with a **cryptographically secure RNG** (`expo-crypto`) — never
 * `Math.random` — and stored only in the secure enclave (`expo-secure-store`). Nothing here leaves
 * the device. Go through this module; screens should not touch the master or secret directly.
 */
import * as Crypto from 'expo-crypto';

import { deriveStellarKeypair, deriveZkSecret, type StellarKeypair } from './keys';
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

/** What every account derives from + exposes. */
export interface Account {
  /** ZK secret (hex) — the prover's private input; seeds commitment/nullifier/KYC user id. */
  zkSecret: string;
  /** Stellar receive address (`G…`). */
  address: string;
}

/**
 * Ensure the on-device account exists, creating it securely on first use, and return it.
 *
 * Idempotent: once the master seed exists, the same ZK secret + Stellar key are re-derived every
 * time. On first creation it persists the master, the derived ZK secret (for the prover), and the
 * Stellar keypair (secret + public address) into the enclave.
 */
export async function ensureAccount(): Promise<Account> {
  let master = await getSecret(SecureKey.masterSeed);
  if (!master) {
    master = secureRandomHex(32);
    await setSecret(SecureKey.masterSeed, master);
  }

  const zkSecret = deriveZkSecret(master);
  const stellar: StellarKeypair = deriveStellarKeypair(master);

  // Persist derived material so consumers (prover, receive screen) read it directly. Derivation is
  // deterministic, so re-writing the same values is harmless.
  await setSecret(SecureKey.zkSecretKey, zkSecret);
  await setSecret(SecureKey.stellarSecret, stellar.secret);
  await setSecret(SecureKey.stellarPublic, stellar.address);

  return { zkSecret, address: stellar.address };
}

/** Read the ZK secret, creating the account securely on first use. */
export async function getOrCreateSecret(): Promise<string> {
  return (await ensureAccount()).zkSecret;
}

/** Read the ZK secret without creating an account (null if no wallet yet). */
export function getSecretOrNull(): Promise<string | null> {
  return getSecret(SecureKey.zkSecretKey);
}

/** The Stellar receive address (`G…`), or null if the wallet hasn't been created yet. */
export function getStellarAddress(): Promise<string | null> {
  return getSecret(SecureKey.stellarPublic);
}

/** Whether a wallet (master seed) exists on this device. */
export function hasWallet(): Promise<boolean> {
  return hasSecret(SecureKey.masterSeed);
}

/** Wipe wallet + account material from the enclave (sign-out / reset). */
export async function resetWallet(): Promise<void> {
  await deleteSecret(SecureKey.masterSeed);
  await deleteSecret(SecureKey.zkSecretKey);
  await deleteSecret(SecureKey.kycCredential);
  await deleteSecret(SecureKey.stellarSecret);
  await deleteSecret(SecureKey.stellarPublic);
  await deleteSecret(SecureKey.session);
  await deleteSecret(SecureKey.balance);
  await deleteSecret(SecureKey.recipients);
}
