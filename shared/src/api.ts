/**
 * Backend API request/response contracts (mobile <-> Go backend).
 *
 * FROZEN for Phase 2: the transfer-submission shape (`SubmitTransferRequest`), the lifecycle
 * (`TransferStatus`), and the history row (`TransferRecord`). The Soroban event the indexer reads
 * is frozen in `events.ts`.
 */

import type { SealedTravelRuleEnvelope } from './ivms101.js';
import type { Hex, TransferProof } from './proof.js';

export type StellarNetwork = 'testnet' | 'mainnet';

/**
 * POST /transfers — submit a private transfer. The device sends the raw proof blob produced by the
 * on-device prover (544-byte Soroban encoding: `A‖B‖C‖commitment‖nullifier‖anchorPk.x‖anchorPk.y‖
 * currentTime`); the backend parses it and relays it to the Soroban `submit`. The amount never
 * leaves the device, so it is never in this request.
 */
export interface SubmitTransferRequest {
  /** Raw proof blob (hex) from the on-device prover — the Phase 4 path. */
  proofBlob?: Hex;
  /** Structured proof (legacy/testing). One of `proofBlob` or `transferProof` must be present. */
  transferProof?: TransferProof;
  /** Travel-Rule envelope — optional in Phase 2, required for the real corridor in Phase 5. */
  travelRuleEnvelope?: SealedTravelRuleEnvelope;
}

export interface SubmitTransferResponse {
  transferId: string;
  status: TransferStatus;
  /** Soroban transaction hash, once submitted. */
  txHash?: string;
}

/**
 * Transfer lifecycle, tracked by the backend (never with amounts):
 *   pending → submitting → submitted → confirmed → (paid_out) | rejected | failed
 */
export type TransferStatus =
  | 'pending' // accepted by the backend, not yet on chain
  | 'submitting' // relayer is submitting to the contract
  | 'submitted' // tx sent, awaiting confirmation
  | 'confirmed' // recorded on-chain (commitment + nullifier stored)
  | 'paid_out' // beneficiary side settled (Phase 5)
  | 'rejected' // contract rejected (invalid proof / replayed nullifier)
  | 'failed'; // submission error after retries

/** GET /transfers/{id} — one row of a user's history (never contains amounts). */
export interface TransferRecord {
  transferId: string;
  status: TransferStatus;
  commitment: string;
  nullifier: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  txHash?: string;
}

/** Standard error envelope returned by the API. */
export interface ApiError {
  code: string; // see errors.ts
  message: string;
}
