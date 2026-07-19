/**
 * The encrypted vault — the "locked box" we back up (Docs/account-recovery.md §2, A3/B).
 *
 * v2 uses **envelope encryption** (the standard DEK/KEK design):
 *
 *   DEK  = random 32-byte data key   → AES-256-GCM encrypts the vault JSON (fast, no PIN needed)
 *   KEK  = Argon2id(PIN, salt)       → AES-256-GCM *wraps* the DEK (slow, memory-hard)
 *
 * Why: the vault contents change often (balance, KYC, recipients), so re-sealing must be cheap —
 * with the DEK cached in the enclave, a re-seal is pure AES (milliseconds). The expensive Argon2id
 * derivation happens only when the PIN is involved: enabling backup, restoring on a new phone, or
 * changing the PIN. Because it's rare, the KEK uses *heavier* Argon2id parameters than the unlock
 * path — better resistance to offline brute-force once the box lives in the cloud.
 *
 * The `box` (wrapped DEK + ciphertext + public KDF params) contains no plaintext secret and is safe
 * to store anywhere. A wrong PIN or any tampering fails GCM authentication.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToUtf8 } from '@noble/ciphers/utils.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as Crypto from 'expo-crypto';

import { getBalanceMinor } from './balance';
import { listRecipients, type Recipient } from './recipients';
import { deleteSecret, getSecret, hasSecret, SecureKey, setSecret } from './secure-store';
import { getSession, type Session } from './session';

const VAULT_VERSION = 2;

/**
 * Argon2id parameters for the KEK (PIN → key). Heavier than the unlock verifier because this key
 * protects the *cloud* copy against offline brute-force, and is only derived at backup-enable /
 * restore / PIN-change (~2–4s on a mid-range phone, with progress UI). Stored in the box so future
 * versions can raise them without breaking old boxes.
 */
const KEK_ARGON = { m: 19_456, t: 4, p: 1 } as const;
const KEY_LEN = 32; // AES-256
const SALT_LEN = 16;
const NONCE_LEN = 12; // AES-GCM standard

/** Everything needed to fully rebuild the account on a new phone. */
export interface VaultData {
  v: number;
  /** Master seed (hex) — the one essential secret; ZK + Stellar keys re-derive from it. */
  master: string;
  /** Signed-in profile (phone + name), so restore recreates the session. */
  profile: Session | null;
  /** Anchor-signed KYC credential (re-issuable by the anchor, carried for convenience). */
  kycCredential: unknown | null;
  /** On-device private balance snapshot (minor units) as of the last sync. */
  balanceMinor: number;
  /** Saved beneficiaries. */
  recipients: Recipient[];
  /** Unix seconds this snapshot was sealed. */
  updatedAt: number;
}

interface Kdf {
  name: 'argon2id';
  m: number;
  t: number;
  p: number;
}

/** The self-contained encrypted box — this exact JSON is what Phase B uploads to the cloud. */
export interface VaultBox {
  v: number;
  kdf: Kdf;
  /** Salt for the KEK derivation (hex). */
  salt: string;
  /** AES-GCM nonce + ciphertext of the wrapped DEK (hex). */
  wrapNonce: string;
  wrappedKey: string;
  /** AES-GCM nonce + ciphertext of the vault JSON under the DEK (hex). */
  nonce: string;
  ct: string;
  /** Unix seconds of the last data seal (mirrors data.updatedAt; readable without the PIN). */
  updatedAt: number;
}

function deriveKek(pin: string, saltHex: string, kdf: Kdf): Uint8Array {
  return argon2id(utf8ToBytes(pin), hexToBytes(saltHex), {
    t: kdf.t,
    m: kdf.m,
    p: kdf.p,
    dkLen: KEY_LEN,
  });
}

/** Snapshot the current on-device account state into the plaintext vault payload. */
async function collectVaultData(): Promise<VaultData> {
  const master = await getSecret(SecureKey.masterSeed);
  if (!master) throw new Error('No wallet to back up');
  const kycRaw = await getSecret(SecureKey.kycCredential);
  return {
    v: VAULT_VERSION,
    master,
    profile: await getSession(),
    kycCredential: kycRaw ? (JSON.parse(kycRaw) as unknown) : null,
    balanceMinor: await getBalanceMinor(),
    recipients: await listRecipients(),
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

/** Encrypt `data` under `dek`, reusing the box's KEK fields (wrap stays untouched). */
function encryptData(box: Omit<VaultBox, 'nonce' | 'ct' | 'updatedAt'>, dek: Uint8Array, data: VaultData): VaultBox {
  const nonce = Crypto.getRandomBytes(NONCE_LEN);
  const ct = gcm(dek, nonce).encrypt(utf8ToBytes(JSON.stringify(data)));
  return { ...box, nonce: bytesToHex(nonce), ct: bytesToHex(ct), updatedAt: data.updatedAt };
}

/**
 * Create (or re-key) the vault under `pin`: generate a fresh DEK, wrap it with the Argon2id KEK,
 * seal the current account snapshot, and store the box + DEK locally. Slow (~seconds) — used at
 * backup-enable and PIN-change, never on the hot path.
 */
export async function sealVault(pin: string): Promise<VaultBox> {
  const data = await collectVaultData();

  const saltHex = bytesToHex(Crypto.getRandomBytes(SALT_LEN));
  const kdf: Kdf = { name: 'argon2id', ...KEK_ARGON };
  const kek = deriveKek(pin, saltHex, kdf);

  const dek = Crypto.getRandomBytes(KEY_LEN);
  const wrapNonce = Crypto.getRandomBytes(NONCE_LEN);
  const wrappedKey = gcm(kek, wrapNonce).encrypt(dek);

  const box = encryptData(
    {
      v: VAULT_VERSION,
      kdf,
      salt: saltHex,
      wrapNonce: bytesToHex(wrapNonce),
      wrappedKey: bytesToHex(wrappedKey),
    },
    dek,
    data,
  );

  await setSecret(SecureKey.vaultDek, bytesToHex(dek));
  await setSecret(SecureKey.vaultBox, JSON.stringify(box));
  return box;
}

/**
 * Fast re-seal: re-encrypt the *current* account snapshot with the cached DEK (pure AES,
 * milliseconds, no PIN). Returns the updated box, or null if the vault isn't set up yet.
 * This is what background backup-sync calls after balance/KYC/recipient changes.
 */
export async function resealVault(): Promise<VaultBox | null> {
  const [dekHex, rawBox] = await Promise.all([
    getSecret(SecureKey.vaultDek),
    getSecret(SecureKey.vaultBox),
  ]);
  if (!dekHex || !rawBox) return null;

  let box: VaultBox;
  try {
    box = JSON.parse(rawBox) as VaultBox;
  } catch {
    return null;
  }

  const updated = encryptData(box, hexToBytes(dekHex), await collectVaultData());
  await setSecret(SecureKey.vaultBox, JSON.stringify(updated));
  return updated;
}

/**
 * Open any box (downloaded from the cloud, or local) with the PIN. Returns the decrypted contents
 * plus the recovered DEK, or `null` on a wrong PIN / corrupt box (GCM auth failure). Slow (~seconds
 * — one Argon2id derivation); show progress UI. Used by the Phase B restore flow.
 */
export function openVaultBox(box: VaultBox, pin: string): { data: VaultData; dekHex: string } | null {
  try {
    const kek = deriveKek(pin, box.salt, box.kdf);
    const dek = gcm(kek, hexToBytes(box.wrapNonce)).decrypt(hexToBytes(box.wrappedKey));
    const pt = gcm(dek, hexToBytes(box.nonce)).decrypt(hexToBytes(box.ct));
    return { data: JSON.parse(bytesToUtf8(pt)) as VaultData, dekHex: bytesToHex(dek) };
  } catch {
    return null; // wrong PIN (unwrap auth fails) or tampered/corrupt box
  }
}

/** Parse a box JSON string (e.g. downloaded from the cloud). Null if malformed. */
export function parseVaultBox(raw: string): VaultBox | null {
  try {
    const box = JSON.parse(raw) as VaultBox;
    if (typeof box !== 'object' || box === null) return null;
    if (typeof box.salt !== 'string' || typeof box.ct !== 'string' || typeof box.wrappedKey !== 'string') return null;
    return box;
  } catch {
    return null;
  }
}

/** The locally stored box, or null. */
export async function getLocalVaultBox(): Promise<VaultBox | null> {
  const raw = await getSecret(SecureKey.vaultBox);
  return raw ? parseVaultBox(raw) : null;
}

/** Adopt a restored box + DEK as this device's local vault (called at the end of restore). */
export async function adoptVault(box: VaultBox, dekHex: string): Promise<void> {
  await setSecret(SecureKey.vaultBox, JSON.stringify(box));
  await setSecret(SecureKey.vaultDek, dekHex);
}

/** Whether a local encrypted vault exists. */
export function hasVault(): Promise<boolean> {
  return hasSecret(SecureKey.vaultBox);
}

/** Remove the local vault + cached DEK (used on wallet reset). */
export async function clearVault(): Promise<void> {
  await deleteSecret(SecureKey.vaultBox);
  await deleteSecret(SecureKey.vaultDek);
}
