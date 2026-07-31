/**
 * Shared error codes used across backend, mobile, and contract responses.
 * Keep these stable — clients branch on them. Add, don't repurpose.
 */

export const ErrorCode = {
  // Proof / verification
  INVALID_PROOF: 'invalid_proof',
  NULLIFIER_ALREADY_USED: 'nullifier_already_used',
  AMOUNT_OUT_OF_RANGE: 'amount_out_of_range',

  // KYC / credential
  KYC_REQUIRED: 'kyc_required',
  CREDENTIAL_EXPIRED: 'credential_expired',
  CREDENTIAL_INVALID: 'credential_invalid',

  // Anchor / settlement
  ANCHOR_UNAVAILABLE: 'anchor_unavailable',
  DEPOSIT_FAILED: 'deposit_failed',
  PAYOUT_FAILED: 'payout_failed',

  // Shielded pool.
  //
  // NOTE_NOT_FOLDED is deliberately distinct from NOTE_NOT_FOUND: the note exists and is yours, it
  // is simply not a tree leaf yet, so the wallet should retry rather than treat the money as lost.
  POOL_UNAVAILABLE: 'pool_unavailable',
  NOTE_NOT_FOUND: 'note_not_found',
  NOTE_NOT_FOLDED: 'note_not_folded',

  // Generic
  BAD_REQUEST: 'bad_request',
  UNAUTHENTICATED: 'unauthenticated',
  RATE_LIMITED: 'rate_limited',
  INTERNAL: 'internal',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
