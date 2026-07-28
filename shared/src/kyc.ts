/**
 * KYC verification contract (mobile <-> Go backend). Mirrors kyc.go.
 *
 * See Docs/kyc-verification.md. This API carries **no personally identifying information** by
 * design: only the opaque `userId` (= `Poseidon(secret, domain)`), a tier, and a status. Documents
 * and personal data go straight from the device to the verification provider — never through Prova,
 * which therefore has no identity data to store or leak.
 */

import type { Hex } from './proof.js';

/** Lifecycle state of one KYC verification. */
export type VerificationStatus =
  /** No verification attempted. */
  | 'not_started'
  /** Submitted; automated provider checks are running. */
  | 'pending'
  /** Escalated to a human compliance officer. */
  | 'in_review'
  /** Verified — a credential may be issued. */
  | 'approved'
  /** Failed; see `reasonCode` for whether a retry is allowed. */
  | 'rejected'
  /** Credential window lapsed; renewal (re-screening) required. */
  | 'expired';

/** KYC tiers — the tier decides what data was collected and the limit it unlocks. */
export const Tier = {
  /** Name + DOB + nationality, screened. Low limit. */
  BASIC: 1,
  /** + government ID and liveness selfie. Standard remittance limit. */
  STANDARD: 2,
  /** + address and source of funds. Enhanced due diligence. */
  ENHANCED: 3,
} as const;

/**
 * How long an issued credential stays valid.
 *
 * A **security** parameter, not a convenience one: the credential lives on the user's phone and
 * cannot be revoked remotely (the circuit only checks expiry), so a short window bounds the exposure
 * if a user is sanctioned after approval. Re-screening happens at every renewal.
 * See Docs/kyc-verification.md §7.
 */
export const CREDENTIAL_TTL_DAYS = 90;

/** How early the app silently renews the credential before it expires. */
export const CREDENTIAL_RENEW_WINDOW_DAYS = 14;

/**
 * Per-transfer limit for a tier, in whole currency units.
 *
 * NOTE: a *product* control enforced by the app and backend policy. The circuit enforces only
 * `kycLevel >= MIN_KYC_LEVEL` and a single global `MAX_AMOUNT`; cryptographic per-tier limits need
 * circuit v3 — see Docs/kyc-verification.md §9.
 */
export function tierLimit(tier: number): number {
  if (tier >= Tier.ENHANCED) return 9999;
  if (tier === Tier.STANDARD) return 9999;
  if (tier === Tier.BASIC) return 1000;
  return 0;
}

/** Reason codes explaining a rejection or review, so the app can tell the user what to fix. */
export const ReasonCode = {
  DOCUMENT_UNREADABLE: 'document_unreadable',
  DOCUMENT_EXPIRED: 'document_expired',
  DOCUMENT_TAMPERED: 'document_tampered',
  FACE_MISMATCH: 'face_mismatch',
  LIVENESS_FAILED: 'liveness_failed',
  SANCTIONS_HIT: 'sanctions_hit',
  DUPLICATE_IDENTITY: 'duplicate_identity',
  UNDERAGE: 'underage',
  MANUAL_REVIEW: 'manual_review',
} as const;

/** Whether the user may resubmit after this rejection. Fraud/prohibition outcomes are terminal. */
export function retryableReason(code: string): boolean {
  return !(
    [
      ReasonCode.SANCTIONS_HIT,
      ReasonCode.DUPLICATE_IDENTITY,
      ReasonCode.UNDERAGE,
      ReasonCode.DOCUMENT_TAMPERED,
    ] as string[]
  ).includes(code);
}

/** Which artefacts the user captured on-device (names only — the images never leave the phone). */
export type CapturedArtifact = 'document_front' | 'document_back' | 'selfie' | 'proof_of_address';

/** Body of `POST /kyc/verifications`. Carries no PII. */
export interface StartVerificationRequest {
  /** `Poseidon(secret, domain)` — opaque; identifies a wallet without revealing it. */
  userId: Hex;
  /** Requested tier (1..3). */
  tier: number;
  /** Artefact kinds supplied on-device (for the UI and audit trail). */
  captured?: CapturedArtifact[];
}

/** Status view returned to the app. No PII. */
export interface VerificationRecord {
  verificationId: string;
  status: VerificationStatus;
  tier: number;
  /** Unix seconds of the approved credential window (absent unless approved). */
  expiry?: number;
  /** Explains a rejection/review outcome. */
  reasonCode?: string;
  /** Whether the user may resubmit after a rejection. */
  retryable?: boolean;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** Payload a verification provider posts to the webhook. */
export interface ProviderVerdict {
  providerRef: string;
  decision: 'approved' | 'rejected' | 'review';
  tier?: number;
  reasonCode?: string;
}
