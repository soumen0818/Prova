/**
 * The proof contract shared by circuits, contracts, mobile, and backend.
 *
 * This is the spine of the polyrepo: the Circom circuit produces these public signals, the Soroban
 * verifier consumes them, the mobile app builds them, and the backend relays them. Any change here
 * is a versioned, cross-cutting change — bump `SCHEMA_VERSION`.
 *
 * NOTE: Phase 0 placeholders. Frozen to v1 in Phase 1 (see Docs/implementation-guide.md).
 */

/** Hex-encoded byte string (e.g. "0x...") for on-chain/portable values. */
export type Hex = string;

/** A Groth16 proof over BN254 (the ~200-byte certificate). */
export interface Groth16Proof {
  a: [Hex, Hex];
  b: [[Hex, Hex], [Hex, Hex]];
  c: [Hex, Hex];
}

/**
 * Public signals the circuit outputs and the contract verifies.
 * These leak nothing about the amount or identity — only that the rules passed.
 */
export interface PublicSignals {
  /** commitment = hash(amount + secret_key) — stored on-chain instead of the amount. */
  commitment: Hex;
  /** nullifier = Poseidon(secret_key, unique_transfer_id) — anti-replay, unlinkable. */
  nullifier: Hex;
  /** True when range + KYC-signature + nullifier checks all passed. */
  rulesPassed: boolean;
}

/** The full payload submitted on-chain for one private transfer. */
export interface TransferProof {
  proof: Groth16Proof;
  publicSignals: PublicSignals;
}

/** Groth16 verification key (output of the trusted setup / ceremony). */
export interface VerificationKey {
  protocol: 'groth16';
  curve: 'bn254';
  nPublic: number;
  vkAlpha1: Hex[];
  vkBeta2: Hex[][];
  vkGamma2: Hex[][];
  vkDelta2: Hex[][];
  ic: Hex[][];
}
