/**
 * Shield — moving money INTO the shielded pool. Mirrors shield.go.
 *
 * Shield is the one pool operation a relayer cannot perform for a user: the contract runs
 * `from.require_auth()` and then moves tokens out of *their* account. So it uses the same
 * "server prepares, phone signs, server submits" exchange as the trustline
 * (see Docs/deposit-flow.md) — the secret never leaves the device.
 *
 * Note the asymmetry with a spend: a deposit is **public** by design. The amount and the depositing
 * account are visible on-chain. Privacy begins once the value is inside the pool, not before.
 */

import type { Hex } from './proof.js';

/** The note being created, as the contract's `ShieldNote`. Every field is 32 bytes, hex. */
export interface ShieldNoteInput {
  /** Poseidon(amount, ownerPk, rho) — what goes on-chain. Reveals nothing by itself. */
  commitment: Hex;
  ownerPk: Hex;
  /** Ephemeral public key of the in-circuit note encryption. */
  epkX: Hex;
  epkY: Hex;
  /** The encrypted note payload only its owner can open. */
  encAmount: Hex;
  encRho: Hex;
}

/** Body of `POST /pool/shield/prepare`. */
export interface ShieldPrepareRequest {
  /** The depositing Stellar account (G…) — transaction source and authorising address. */
  address: string;
  /** Amount in the token's own units (stroops for a 7-decimal Stellar asset). */
  amount: number;
  note: ShieldNoteInput;
  /** Groth16 shield proof from the on-device prover. */
  proofA: Hex;
  proofB: Hex;
  proofC: Hex;
}

/**
 * Outcome of `POST /pool/shield/submit`.
 *
 * `pending` is a real, expected state — the transaction was accepted but its result was not observed
 * before the deadline. It must never be rendered as failure: the money may still arrive, and telling
 * someone their deposit failed when it did not is how they end up depositing twice.
 */
export const ShieldStatus = {
  CONFIRMED: 'confirmed',
  PENDING: 'pending',
} as const;

export type ShieldStatusValue = (typeof ShieldStatus)[keyof typeof ShieldStatus];

export interface ShieldSubmitResponse {
  /** Stellar transaction hash. Present even when pending, so the outcome can be looked up. */
  hash: string;
  status: ShieldStatusValue;
}
