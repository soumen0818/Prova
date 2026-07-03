/**
 * Backend API request/response contracts (mobile <-> Go backend).
 * Phase 0 placeholders — expand as endpoints land in Phases 2–5.
 */

import type { SealedTravelRuleEnvelope } from './ivms101.js';
import type { TransferProof } from './proof.js';

export type StellarNetwork = 'testnet' | 'mainnet';

/** POST /transfers — submit a private transfer (proof relayed to Soroban). */
export interface SubmitTransferRequest {
  transferProof: TransferProof;
  travelRuleEnvelope: SealedTravelRuleEnvelope;
}

export interface SubmitTransferResponse {
  transferId: string;
  status: TransferStatus;
  /** Soroban transaction hash, once submitted. */
  txHash?: string;
}

export type TransferStatus =
  | 'pending'
  | 'proof_submitted'
  | 'confirmed'
  | 'paid_out'
  | 'rejected'
  | 'failed';

/** GET /transfers — one row of a user's history (never contains amounts). */
export interface TransferRecord {
  transferId: string;
  status: TransferStatus;
  commitment: string;
  createdAt: string; // ISO 8601
  txHash?: string;
}

/** Standard error envelope returned by the API. */
export interface ApiError {
  code: string; // see errors.ts
  message: string;
}
