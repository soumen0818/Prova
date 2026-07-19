/**
 * Device PIN — a 6-digit fallback unlock and payment step-up factor (Docs/account-recovery.md §4).
 *
 * We never store the PIN. We store a **verifier**: PBKDF2-SHA256(pin, random salt) in the secure
 * enclave, and check by recomputing + constant-time comparing. A 6-digit PIN is only 10^6 wide, so
 * this module also **rate-limits**: after too many wrong tries it locks out with escalating backoff.
 *
 * (The vault-encryption key in Phase A3 uses a memory-hard KDF — Argon2id — because that ciphertext
 * lives in the cloud where an attacker can brute-force offline. This local verifier is protected by
 * the hardware enclave, so PBKDF2 + lockout is the right, fast choice here.)
 */
import * as Crypto from 'expo-crypto';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import { deleteSecret, getSecret, SecureKey, setSecret } from './secure-store';

export const PIN_LENGTH = 6;

/** PBKDF2 work factor. ~0.2s in Node; a tolerable one-shot on-device, backed by the enclave. */
const ITERATIONS = 100_000;
const DK_LEN = 32;

/** Wrong-attempt lockout: after MAX_ATTEMPTS fails, lock for escalating durations (ms). */
const MAX_ATTEMPTS = 5;
const LOCKOUTS_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

interface PinRecord {
  v: 1;
  salt: string; // hex, 16 bytes
  hash: string; // hex, PBKDF2 output
  iters: number;
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

function computeHash(pin: string, saltHex: string, iters: number): string {
  const dk = pbkdf2(sha256, utf8ToBytes(pin), hexToBytes(saltHex), { c: iters, dkLen: DK_LEN });
  return bytesToHex(dk);
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
    v: 1,
    salt,
    hash: computeHash(pin, salt, ITERATIONS),
    iters: ITERATIONS,
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

  const candidate = computeHash(pin, record.salt, record.iters);
  if (timingSafeEqual(candidate, record.hash)) {
    if (record.failed !== 0 || record.lockedUntil !== 0) {
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
