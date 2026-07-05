/**
 * Anchor-attested KYC credential — FROZEN for Phase 3.
 *
 * The anchor signs `(userId, kycLevel, expiry)` with a Poseidon-challenge Schnorr/EdDSA over
 * **Jubjub** (the curve whose base field is BLS12-381's scalar field), so the signature is verified
 * *inside* the Groth16 circuit. Identity data never touches the chain — only `userId`
 * (`= Poseidon(secret, domain)`), which reveals nothing.
 *
 * All field elements are 32-byte big-endian hex (`Hex`), matching the prover CLI's
 * `issue-credential` output and Soroban's scalar encoding.
 */

import type { Hex } from './proof.js';

/** Frozen credential/signature scheme identifier. */
export const CREDENTIAL_FORMAT = 'jubjub-eddsa-poseidon-v1';

/** Minimum KYC level the circuit accepts (must match the circuit constant). */
export const MIN_KYC_LEVEL = 1;

/** An anchor's Jubjub public key (affine coordinates, each 32-byte big-endian). */
export interface AnchorPublicKey {
  x: Hex;
  y: Hex;
}

/** Schnorr/EdDSA signature over Jubjub: nonce point `R = (rX, rY)` and response scalar `s`. */
export interface CredentialSignature {
  rX: Hex;
  rY: Hex;
  s: Hex;
}

/**
 * The credential the anchor returns after KYC. Stored only in the user's wallet (secure enclave) —
 * never on a server, never on-chain.
 */
export interface KycCredential {
  /** userId = Poseidon(secret, domain) — binds the credential to the wallet's transfer secret. */
  userId: Hex;
  kycLevel: number;
  /** Unix seconds; the circuit enforces `expiry >= currentTime`. */
  expiry: number;
  signature: CredentialSignature;
  /** The anchor public key that signed this credential (must be in the trusted set). */
  anchor: AnchorPublicKey;
}
