/**
 * The proof contract shared by circuits, contracts, mobile, and backend — FROZEN as v1.
 *
 * Prova uses **BLS12-381 Groth16** (arkworks prover, Soroban `pairing_check` verifier). The curve is
 * BLS12-381 — NOT BN254 — because Soroban only exposes BLS12-381 host functions. See
 * Docs/phase1-findings.md.
 *
 * Points use Soroban's **uncompressed, big-endian** encoding: `G1 = x‖y` (96 bytes),
 * `G2 = x‖y` (192 bytes) where each `Fp2` limb is ordered `c1‖c0`. Scalars are 32-byte big-endian.
 */

/** The frozen proof/VK wire format identifier. Bump only on a breaking change to the layout below. */
export const PROOF_FORMAT = 'bls12-381-groth16-v1';

/** Hex-encoded byte string (no `0x` prefix) in Soroban's big-endian encoding. */
export type Hex = string;

/** Byte lengths of the BLS12-381 encodings Soroban expects. */
export const ByteLen = {
  /** G1 affine point, uncompressed: x(48) ‖ y(48). */
  G1: 96,
  /** G2 affine point, uncompressed: x(96) ‖ y(96), each Fp2 as c1(48) ‖ c0(48). */
  G2: 192,
  /** Scalar field element (Fr), big-endian. */
  SCALAR: 32,
} as const;

/** A Groth16 proof over BLS12-381 (A,C in G1; B in G2). */
export interface Groth16Proof {
  /** G1 point, 96-byte hex. */
  a: Hex;
  /** G2 point, 192-byte hex. */
  b: Hex;
  /** G1 point, 96-byte hex. */
  c: Hex;
}

/**
 * Public inputs the circuit exposes and the contract verifies, in order. They leak nothing about
 * the amount or identity — only that the rules passed. Each is a 32-byte big-endian scalar.
 */
export interface PublicSignals {
  /** commitment = Poseidon(amount, secret) — stored on-chain instead of the amount. */
  commitment: Hex;
  /** nullifier = Poseidon(secret, transferId) — anti-replay, unlinkable. */
  nullifier: Hex;
}

/** The full payload submitted for verification of one private transfer. */
export interface TransferProof {
  proof: Groth16Proof;
  publicSignals: PublicSignals;
}

/**
 * The Groth16 verifying key, in the exact blob the Soroban verifier embeds:
 * `alpha(G1) ‖ negBeta(G2) ‖ negGamma(G2) ‖ negDelta(G2) ‖ ic[](G1 each)`.
 * beta/gamma/delta are **pre-negated** so verification is a single `pairing_check`.
 * `ic` has `publicInputs + 1` entries (here 3: constant, commitment, nullifier).
 */
export interface VerificationKey {
  curve: 'bls12-381';
  protocol: 'groth16';
  format: typeof PROOF_FORMAT;
  alpha: Hex;
  negBeta: Hex;
  negGamma: Hex;
  negDelta: Hex;
  ic: Hex[];
}
