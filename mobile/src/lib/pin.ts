/**
 * Device PIN — a 6-digit unlock and payment step-up factor (Docs/account-recovery.md §4).
 *
 * We never store the PIN, only a **verifier**: a salted **native SHA-256** (via expo-crypto), stored
 * in the secure enclave, checked by recomputing + constant-time comparing.
 *
 * Why a fast hash (not a heavy KDF) is correct here: the local verifier only *gates the UI* — the
 * master seed is protected by the hardware keystore, not by the PIN, so cracking the verifier doesn't
 * yield funds. Its real defenses are the **enclave** + **rate-limiting** (below). Pure-JS KDFs are
 * also far too slow on Hermes for an every-unlock path. The memory-hard **Argon2id** lives on the
 * cloud vault (lib/vault.ts), where the ciphertext is actually exposed to offline attackers.
 *
 * A 6-digit PIN is only 10^6 wide, so we still **rate-limit**: too many wrong tries → escalating
 * lockout. Legacy PBKDF2 records (v1) are still accepted so an existing PIN keeps working until it's
 * next changed.
 */
import * as Crypto from 'expo-crypto';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { deleteSecret, getSecret, SecureKey, setSecret } from './secure-store';

export const PIN_LENGTH = 6;
const RECORD_VERSION = 2; // v2 = native salted SHA-256; v1 = legacy PBKDF2

/** Wrong-attempt lockout: after MAX_ATTEMPTS fails, lock for escalating durations (ms). */
const MAX_ATTEMPTS = 5;
const LOCKOUTS_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

interface PinRecord {
  v: number;
  salt: string; // hex, 16 bytes
  hash: string; // hex
  iters?: number; // v1 only (PBKDF2 work factor)
  failed: number; // consecutive failed attempts
  lockedUntil: number; // unix ms; 0 = not locked
}

export interface VerifyResult {
  ok: boolean;
  /** Unix ms the PIN is locked until (0 if not locked). */
  lockedUntil: number;
  /** Attempts left before the next lockout (0 while locked). */
  attemptsRemaining: number;
}

/** True for exactly 6 digits. */
export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

async function readRecord(): Promise<PinRecord | null> {
  const raw = await getSecret(SecureKey.pinRecord);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PinRecord;
  } catch {
    return null;
  }
}

/** v2 verifier: native salted SHA-256 (fast — a single hardware digest call). */
function computeHashV2(pin: string, saltHex: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `prova.pin.v2:${saltHex}:${pin}`,
    { encoding: Crypto.CryptoEncoding.HEX },
  );
}

/** v1 verifier: legacy PBKDF2 (kept only to validate PINs set before v2). */
function computeHashV1(pin: string, saltHex: string, iters: number): string {
  return bytesToHex(pbkdf2(sha256, utf8ToBytes(pin), hexToBytes(saltHex), { c: iters, dkLen: 32 }));
}

async function hashForRecord(pin: string, record: PinRecord): Promise<string> {
  if (record.v >= 2) return computeHashV2(pin, record.salt);
  return computeHashV1(pin, record.salt, record.iters ?? 100_000);
}

/** Constant-time equality for equal-length hex strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomSaltHex(): string {
  return bytesToHex(Crypto.getRandomBytes(16));
}

/** Whether a PIN has been set on this device. */
export async function hasPin(): Promise<boolean> {
  return (await getSecret(SecureKey.pinRecord)) !== null;
}

/** Set (or replace) the PIN. Resets any prior lockout/attempt state. */
export async function setPin(pin: string): Promise<void> {
  if (!isValidPin(pin)) throw new Error(`PIN must be ${PIN_LENGTH} digits`);
  const salt = randomSaltHex();
  const record: PinRecord = {
    v: RECORD_VERSION,
    salt,
    hash: await computeHashV2(pin, salt),
    failed: 0,
    lockedUntil: 0,
  };
  await setSecret(SecureKey.pinRecord, JSON.stringify(record));
}

/**
 * Verify a PIN. Enforces lockout: while locked, returns `ok: false` with `lockedUntil` without even
 * checking. On success, resets attempts; on failure, increments and locks out past MAX_ATTEMPTS.
 */
export async function verifyPin(pin: string): Promise<VerifyResult> {
  const record = await readRecord();
  if (!record) return { ok: false, lockedUntil: 0, attemptsRemaining: 0 };

  const now = Date.now();
  if (record.lockedUntil > now) {
    return { ok: false, lockedUntil: record.lockedUntil, attemptsRemaining: 0 };
  }

  const candidate = await hashForRecord(pin, record);
  if (timingSafeEqual(candidate, record.hash)) {
    if (record.v < RECORD_VERSION) {
      // Self-heal: a legacy (slow PBKDF2 v1) PIN is slow to verify exactly once — on success we
      // re-store it as the fast v2 native hash, so every later unlock is instant.
      const salt = randomSaltHex();
      const hash = await computeHashV2(pin, salt);
      await setSecret(
        SecureKey.pinRecord,
        JSON.stringify({ v: RECORD_VERSION, salt, hash, failed: 0, lockedUntil: 0 }),
      );
    } else if (record.failed !== 0 || record.lockedUntil !== 0) {
      await setSecret(
        SecureKey.pinRecord,
        JSON.stringify({ ...record, failed: 0, lockedUntil: 0 }),
      );
    }
    return { ok: true, lockedUntil: 0, attemptsRemaining: MAX_ATTEMPTS };
  }

  const failed = record.failed + 1;
  let lockedUntil = 0;
  if (failed >= MAX_ATTEMPTS) {
    const idx = Math.min(failed - MAX_ATTEMPTS, LOCKOUTS_MS.length - 1);
    lockedUntil = now + LOCKOUTS_MS[idx];
  }
  await setSecret(SecureKey.pinRecord, JSON.stringify({ ...record, failed, lockedUntil }));
  return {
    ok: false,
    lockedUntil,
    attemptsRemaining: Math.max(0, MAX_ATTEMPTS - failed),
  };
}

/** Remove the PIN (used on wallet reset). */
export async function clearPin(): Promise<void> {
  await deleteSecret(SecureKey.pinRecord);
}
