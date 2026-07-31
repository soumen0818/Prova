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
  /** HKDF label for the note-encryption keypair (Jubjub), from the wallet master seed. */
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
  /** Depth 20 → 2^20 ≈ 1.05M notes. Each level costs one Poseidon hash in-circuit. */
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
  /**
   * Commitments folded into the tree per `update_root` call.
   *
   * The contract **cannot hash** — one on-chain Poseidon permutation measured 10,967,507 CPU against
   * a 100M budget, so a depth-20 append cannot even complete (Docs/shielded-pool.md §10.1). New
   * commitments are therefore queued and folded in by a proof. Each folded leaf is a Groth16 public
   * input costing ~1.49M CPU in the verifier's MSM, which is what caps the batch: 8 leaves ≈ 60M,
   * 16 ≈ 71M, 32 ≈ 95M (no room left). A fold may carry *fewer* than this so a quiet period never
   * strands a note.
   */
  BATCH: 8,
} as const;

/**
 * A note's lifecycle. Value is never at risk in either state, but a note cannot be *spent* until it
 * has been folded into the tree — a membership proof needs it to be a leaf. Wallets must show
 * `queued` notes as confirming rather than spendable, or a user will try to send money that has no
 * Merkle path yet.
 */
export type NoteStatus = 'queued' | 'folded' | 'spent';

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
  'destination',
  'anchorPkX',
  'anchorPkY',
  'currentTime',
  // The encrypted notes. Public inputs rather than attachments — see `EncryptedNote`.
  'epkX',
  'epkY',
  'enc1Amount',
  'enc1Rho',
  'enc2Amount',
  'enc2Rho',
] as const;

export type PoolPublicInput = (typeof POOL_PUBLIC_INPUTS)[number];

/** Number of public inputs; the verifying key has this many + 1 IC entries. */
export const POOL_PUBLIC_INPUT_COUNT = POOL_PUBLIC_INPUTS.length; // 15

/** Proof blob size: `A(96) ‖ B(192) ‖ C(96) ‖ publicInputs(15 × 32)` = 864 bytes. */
export const POOL_PROOF_BLOB_BYTES = 96 + 192 + 96 + POOL_PUBLIC_INPUT_COUNT * 32;

/**
 * Shield proof — public inputs in verification order.
 *
 * `shield` is the only way a commitment enters the pool without a spend proof behind it, and the
 * contract cannot compute Poseidon to check it. Without this proof a user could transfer 100 tokens
 * while committing to 1,000,000 and then unshield the pool dry. The contract checks `amount` against
 * the tokens actually transferred, which is what closes that hole.
 */
export const SHIELD_PUBLIC_INPUTS = [
  'commitment',
  'amount',
  'ownerPk',
  'epkX',
  'epkY',
  'encAmount',
  'encRho',
] as const;
export const SHIELD_PUBLIC_INPUT_COUNT = SHIELD_PUBLIC_INPUTS.length; // 7

/**
 * Fold proof — public inputs in verification order.
 *
 * Proves that appending `leaf0..leaf7` (the first `count` of them) at `startIndex` takes the tree
 * from `oldRoot` to `newRoot`. The leaves are public inputs precisely so the contract can pass the
 * commitments *it* queued: that is what stops a folder inserting notes of its own invention.
 */
export const FOLD_PUBLIC_INPUTS = [
  'oldRoot',
  'newRoot',
  'startIndex',
  'count',
  ...Array.from({ length: MerkleParams.BATCH }, (_, i) => `leaf${i}` as const),
] as const;
export const FOLD_PUBLIC_INPUT_COUNT = 4 + MerkleParams.BATCH; // 12

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
  /**
   * Where an unshield pays out, bound into the proof; `"0"` for a private transfer.
   *
   * Without this binding an unshield proof is valid for *any* destination, so anyone watching the
   * mempool could resubmit it with their own address and take the payout. It is a fund-theft hole,
   * and it is why this field was added after the V0 freeze.
   */
  destination: Hex;
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
 * **Scheme: Jubjub ECDH + a Poseidon one-time pad, computed *inside* the spend circuit.**
 *
 * ```text
 * epk     = esk·G                        S = esk·encPk = encSk·epk
 * k       = Poseidon(S.x, S.y, slot)
 * cAmount = amount + Poseidon(k, 1)      cRho = rho + Poseidon(k, 2)
 * ```
 *
 * This is deliberately *not* an off-circuit AEAD. A payload that merely travels beside the proof can
 * be corrupted by whoever submits the transaction: the money stays on-chain and stays the
 * recipient's, but their wallet can never find it — indistinguishable from losing it. Because these
 * fields are Groth16 **public inputs** produced by the circuit, corrupting one invalidates the proof
 * and the transaction is rejected instead.
 *
 * Binding an off-circuit ciphertext with SHA-256 was measured and rejected: ~42,000 constraints per
 * 64-byte block against 240 for a Poseidon hash.
 *
 * `slot` (0 or 1) is domain-separated into `k`, so two notes sent to the *same* recipient in one
 * transfer cannot share a mask — otherwise subtracting the two public ciphertexts would reveal the
 * difference of their amounts.
 */
export interface EncryptedNote {
  /** Ephemeral Jubjub public key for this transfer, shared by both output notes. */
  epkX: Hex;
  epkY: Hex;
  /** Masked `amount` and `rho`. */
  encAmount: Hex;
  encRho: Hex;
  /** Output index (0 or 1); folded into the key derivation, so the wallet must record it. */
  slot: 0 | 1;
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

/** The pool operations (Docs/shielded-pool.md §1, §10.4). */
export type PoolOperation =
  /** Public: tokens move into the pool, one note is created. */
  | 'shield'
  /** Private: spend a note → recipient note + change note. */
  | 'transact'
  /** Spend a note → tokens leave the pool to a public destination (+ change note). */
  | 'unshield'
  /**
   * Maintenance: fold queued commitments into the Merkle tree and advance the root.
   *
   * Permissionless — the proof enforces correctness, so a folder can neither mint nor steal; its
   * only power is to stop, which delays new notes becoming spendable. In practice the V3 relayer
   * runs it on a timer.
   */
  | 'updateRoot';
