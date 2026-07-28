/**
 * Shielded pool contract — FROZEN as v3 (Docs/shielded-pool.md). Mirrors pool.go.
 *
 * This is the single source of truth for the note format, the Merkle tree parameters, the circuit's
 * public-input order and the on-chain event shape. The circuit, the Soroban contract, the backend
 * indexer and the wallet must all agree **bit-for-bit** — a mismatch here silently breaks value
 * conservation or makes notes unspendable, so nothing below may change without a version bump and a
 * coordinated redeploy (new trusted setup + new verification key + contract upgrade).
 *
 * Field elements are BLS12-381 scalars, encoded as 32-byte big-endian hex (Soroban's `Fr`).
 */

import type { Hex } from './proof.js';

/** Frozen pool/circuit version. Bump only on a breaking change to anything in this file. */
export const POOL_FORMAT = 'prova-shielded-pool-v3';

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * A note is a unit of private value — think of a banknote in your wallet.
 *
 *   commitment = Poseidon(amount, ownerPk, rho)   → published on-chain; reveals nothing
 *   nullifier  = Poseidon(ownerSk, rho)           → published when spent; prevents double-spend
 *
 * `rho` is a fresh random field element per note. It makes two notes with the same amount and owner
 * produce different commitments (unlinkability), and it makes the nullifier unique per note.
 */
export interface Note {
  /** Value in minor units (e.g. fils/paise), as a decimal string — u64 range. */
  amount: string;
  /** Owner's pool public key — the "address" that receives notes. */
  ownerPk: Hex;
  /** Per-note random nonce. */
  rho: Hex;
}

/** A note plus everything needed to spend it (position in the tree). */
export interface OwnedNote extends Note {
  /** Commitment, cached so the wallet doesn't recompute. */
  commitment: Hex;
  /** Leaf index in the Merkle tree — needed to build the membership path. */
  leafIndex: number;
  /** Nullifier, once known; its presence on-chain means the note is spent. */
  nullifier?: Hex;
}

/**
 * Domain separators for key derivation. Distinct constants stop one derived value being reused as
 * another (e.g. an owner key masquerading as a nullifier input).
 */
export const PoolDomain = {
  /** ownerPk = Poseidon(ownerSk, OWNER) */
  OWNER: '1',
  /** HKDF label for the pool spending key, from the wallet master seed. */
  SPEND_KEY_INFO: 'prova/pool/spend/v1',
  /** HKDF label for the note-encryption keypair (X25519), from the wallet master seed. */
  ENC_KEY_INFO: 'prova/pool/enc/v1',
} as const;

/** Amounts are u64 minor units; the circuit range-checks every amount to this width. */
export const AMOUNT_BITS = 64;

// ---------------------------------------------------------------------------
// Merkle tree
// ---------------------------------------------------------------------------

/**
 * Tree of every commitment ever created. A spend proves membership *somewhere* in this tree, so the
 * anonymity set is every note that has ever existed.
 */
export const MerkleParams = {
  /** Depth 20 → 2^20 ≈ 1.05M notes. Each level costs one Poseidon hash in-circuit and on-chain. */
  DEPTH: 20,
  /** Value of an empty leaf. Zero-subtree hashes are derived from this. */
  EMPTY_LEAF: '0',
  /**
   * How many recent roots the contract accepts.
   *
   * A proof is built against the root the wallet last saw; by the time it lands, other transactions
   * may have advanced the root. Without a history window every concurrent transfer would fail, so
   * the contract accepts any root in this rolling set.
   */
  ROOT_HISTORY: 32,
} as const;

/** A Merkle membership path: sibling hashes bottom-up, plus the leaf index that fixes left/right. */
export interface MerklePath {
  leafIndex: number;
  /** Exactly `MerkleParams.DEPTH` siblings, from leaf level upward. */
  siblings: Hex[];
  /** The root these siblings hash to — the proof's public input. */
  root: Hex;
}

// ---------------------------------------------------------------------------
// Circuit v3 I/O
// ---------------------------------------------------------------------------

/**
 * Public inputs, **in verification order**. The contract's verifying key IC layout and the prover's
 * `public_inputs()` must match this exactly, or every proof fails.
 *
 * `publicAmount` is what makes one circuit serve two operations:
 *   - `0`  → a fully private transfer (value stays in the pool)
 *   - `>0` → an unshield (that much leaves the pool to a public destination)
 */
export const POOL_PUBLIC_INPUTS = [
  'merkleRoot',
  'nullifier',
  'outCommitment1',
  'outCommitment2',
  'publicAmount',
  'anchorPkX',
  'anchorPkY',
  'currentTime',
] as const;

export type PoolPublicInput = (typeof POOL_PUBLIC_INPUTS)[number];

/** Number of public inputs; the verifying key has this many + 1 IC entries. */
export const POOL_PUBLIC_INPUT_COUNT = POOL_PUBLIC_INPUTS.length; // 8

/**
 * Proof blob size: `A(96) ‖ B(192) ‖ C(96) ‖ publicInputs(8 × 32)` = 640 bytes.
 * (v2 was 544 bytes with 5 public inputs.)
 */
export const POOL_PROOF_BLOB_BYTES = 96 + 192 + 96 + POOL_PUBLIC_INPUT_COUNT * 32;

/** The statement a spend proves. Everything not listed here stays a private witness. */
export interface PoolPublicSignals {
  /** Root the membership proof was built against — must be in the contract's history window. */
  merkleRoot: Hex;
  /** Nullifier of the note being spent. */
  nullifier: Hex;
  /** New note for the recipient. */
  outCommitment1: Hex;
  /** New note for change back to the sender. */
  outCommitment2: Hex;
  /** Amount leaving the pool publicly (decimal string); "0" for a private transfer. */
  publicAmount: string;
  /** Anchor key that signed the KYC credential (carried over from v2). */
  anchorPkX: Hex;
  anchorPkY: Hex;
  /** Time the expiry check was made against. */
  currentTime: string;
}

// ---------------------------------------------------------------------------
// Note encryption (discovery)
// ---------------------------------------------------------------------------

/**
 * Each output note is encrypted to its recipient and emitted with the transaction, so the owner can
 * find money sent to them. Wallets scan new events and trial-decrypt; what opens is theirs. The
 * chain only ever sees ciphertext.
 *
 * Scheme: X25519 ECDH to the recipient's `encPk` → ChaCha20-Poly1305.
 */
export interface EncryptedNote {
  /** Ephemeral X25519 public key for this payload (32-byte hex). */
  ephemeralPk: Hex;
  /** AEAD nonce (12-byte hex). */
  nonce: Hex;
  /** Ciphertext of the JSON `Note`, including the Poly1305 tag. */
  ciphertext: Hex;
}

/** One `commitment` event: the leaf that was appended, plus the payload its owner can decrypt. */
export interface NoteEvent {
  /** Commitment appended to the tree. */
  commitment: Hex;
  /** Its index in the tree — the wallet needs this to build a spend path. */
  leafIndex: number;
  /** Encrypted note for the owner. */
  encrypted: EncryptedNote;
  /** Ledger sequence the event was emitted at (scan cursor). */
  ledger: number;
}

// ---------------------------------------------------------------------------
// Contract operations
// ---------------------------------------------------------------------------

/** The three pool operations (Docs/shielded-pool.md §1). */
export type PoolOperation =
  /** Public: tokens move into the pool, one note is created. */
  | 'shield'
  /** Private: spend a note → recipient note + change note. */
  | 'transact'
  /** Spend a note → tokens leave the pool to a public destination (+ change note). */
  | 'unshield';
