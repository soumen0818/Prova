/**
 * Deterministic key derivation — one master seed, two keys (see Docs/account-recovery.md §1).
 *
 * The 32-byte `master` is the single secret we back up. Everything else is derived from it via
 * HKDF-SHA256 with a domain-separated `info` string, so the ZK secret and the Stellar key are
 * reproducible from the master alone and never need separate backup.
 *
 *   zkSecret    = HKDF(master, "prova/zk/v1")       → 32-byte hex (the prover's existing format)
 *   stellarSeed = HKDF(master, "prova/stellar/v1")  → 32-byte ed25519 seed → Stellar keypair
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';

import { encodeStellarPublicKey, encodeStellarSecretSeed } from './stellar-strkey';

/** Domain-separation labels — bump the version suffix only on a breaking derivation change. */
const INFO_ZK = 'prova/zk/v1';
const INFO_STELLAR = 'prova/stellar/v1';

export interface StellarKeypair {
  /** Public `G…` address — safe to share; this is where the anchor credits funds. */
  address: string;
  /** Secret `S…` seed — never leaves the secure enclave. */
  secret: string;
}

/** HKDF-SHA256 → `length` bytes, domain-separated by `info`. */
function derive(master: Uint8Array, info: string, length = 32): Uint8Array {
  // No salt: the master is already high-entropy CSPRNG output. `info` must be bytes.
  return hkdf(sha256, master, undefined, utf8ToBytes(info), length);
}

/** Derive the ZK secret (hex) the prover consumes, from the master seed hex. */
export function deriveZkSecret(masterHex: string): string {
  return bytesToHex(derive(hexToBytes(masterHex), INFO_ZK));
}

/** Derive the Stellar keypair (`G…` / `S…`) from the master seed hex. */
export function deriveStellarKeypair(masterHex: string): StellarKeypair {
  const seed = derive(hexToBytes(masterHex), INFO_STELLAR);
  const publicKey = ed25519.getPublicKey(seed);
  return {
    address: encodeStellarPublicKey(publicKey),
    secret: encodeStellarSecretSeed(seed),
  };
}

/**
 * Sign a Stellar transaction hash with the account's ed25519 key, from the master seed.
 *
 * Stellar signs the 32-byte transaction hash directly with ed25519 — verified byte-for-byte against
 * the Go SDK (Docs/deposit-flow). The backend builds the transaction and returns only its hash; the
 * secret never leaves the device. Returns the base64 signature the backend attaches via
 * `AddSignatureBase64`.
 */
export function signStellarHash(masterHex: string, hashHex: string): string {
  const seed = derive(hexToBytes(masterHex), INFO_STELLAR);
  const sig = ed25519.sign(hexToBytes(hashHex), seed);
  return base64.encode(sig);
}
