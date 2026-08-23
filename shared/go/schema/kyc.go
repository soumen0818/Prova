package schema

// KYC verification contract (mobile <-> Go backend). Mirrors kyc.ts.
// See Docs/kyc-verification.md — this API carries NO personally identifying information by design:
// only the opaque userId (= Poseidon(secret, domain)), a tier, and a status.

// VerificationStatus is the lifecycle state of one KYC verification.
type VerificationStatus string

const (
	// VerificationNotStarted means no verification has been attempted.
	VerificationNotStarted VerificationStatus = "not_started"
	// VerificationPending means submitted; automated provider checks are running.
	VerificationPending VerificationStatus = "pending"
	// VerificationInReview means escalated to a human compliance officer.
	VerificationInReview VerificationStatus = "in_review"
	// VerificationApproved means verified — a credential may be issued.
	VerificationApproved VerificationStatus = "approved"
	// VerificationRejected means the check failed; see ReasonCode for whether a retry is allowed.
	VerificationRejected VerificationStatus = "rejected"
	// VerificationExpired means the credential window lapsed; renewal (re-screening) is required.
	VerificationExpired VerificationStatus = "expired"
)

// KYC tiers. The tier decides how much data was collected and the transfer limit it unlocks.
const (
	// TierBasic (level 1): name + DOB + nationality, screened. Low limit.
	TierBasic = 1
	// TierStandard (level 2): + government ID and liveness selfie. Standard remittance limit.
	TierStandard = 2
	// TierEnhanced (level 3): + address and source of funds. Enhanced due diligence.
	TierEnhanced = 3
)

// CredentialTTLDays is how long an issued credential stays valid.
//
// This is a SECURITY parameter, not a convenience one: a credential lives on the user's phone and
// cannot be revoked remotely (the circuit only checks expiry). A short window bounds the exposure
// if a user is sanctioned after approval — re-screening happens at every renewal.
// See Docs/kyc-verification.md §7.
const CredentialTTLDays = 90

// CredentialRenewWindowDays is how early the app should silently renew before expiry.
const CredentialRenewWindowDays = 14

// TierLimit returns the per-transfer limit for a tier, in whole currency units.
//
// NOTE: this is a *product* control enforced by the app and backend policy. The circuit enforces
// only `kycLevel >= MinKycLevel` and a single global `MAX_AMOUNT`. Cryptographic per-tier limits
// need circuit v3 — see Docs/kyc-verification.md §9.
func TierLimit(tier int) int64 {
	switch {
	case tier >= TierEnhanced:
		return 9999
	case tier == TierStandard:
		return 9999
	case tier == TierBasic:
		return 1000
	default:
		return 0
	}
}

// Reason codes explaining a rejection or review, so the app can tell the user what to fix.
const (
	ReasonDocumentUnreadable = "document_unreadable"
	ReasonDocumentExpired    = "document_expired"
	ReasonDocumentTampered   = "document_tampered"
	ReasonFaceMismatch       = "face_mismatch"
	ReasonLivenessFailed     = "liveness_failed"
	ReasonSanctionsHit       = "sanctions_hit"
	ReasonDuplicateIdentity  = "duplicate_identity"
	ReasonUnderage           = "underage"
	ReasonManualReview       = "manual_review"
)

// RetryableReason reports whether the user may resubmit after this rejection.
// Fraud/prohibition outcomes are terminal — a sanctioned user must not be able to retry.
func RetryableReason(code string) bool {
	switch code {
	case ReasonSanctionsHit, ReasonDuplicateIdentity, ReasonUnderage, ReasonDocumentTampered:
		return false
	default:
		return true
	}
}

// StartVerificationRequest is the body of POST /kyc/verifications.
//
// Deliberately carries NO PII: documents and personal data go straight from the device to the
// verification provider, never through Prova. `Captured` records only which artefacts the user
// supplied, so the UI and audit trail can show what was submitted.
type StartVerificationRequest struct {
	// UserID = Poseidon(secret, domain) — opaque; identifies a wallet without revealing it.
	UserID Hex `json:"userId"`
	// Tier requested (1..3).
	Tier int `json:"tier"`
	// Captured lists the artefact kinds supplied on-device, e.g. ["document_front","selfie"].
	Captured []string `json:"captured,omitempty"`
	// Email the submission belongs to, so a reviewer sees a person rather than a hash.
	//
	// UNTRUSTED and display-only. These routes have no session to check it against, so it is a
	// label on the queue row: no decision reads it and nothing is granted because of it. Optional —
	// omitting it leaves the row identified by UserID alone, exactly as before.
	Email string `json:"email,omitempty"`
}

// VerificationRecord is the status view returned to the app. No PII.
type VerificationRecord struct {
	VerificationID string             `json:"verificationId"`
	Status         VerificationStatus `json:"status"`
	Tier           int                `json:"tier"`
	// Expiry is unix seconds of the approved credential window (0 unless approved).
	Expiry int64 `json:"expiry,omitempty"`
	// ReasonCode explains a rejection/review outcome.
	ReasonCode string `json:"reasonCode,omitempty"`
	// Retryable reports whether the user may resubmit after a rejection.
	Retryable bool   `json:"retryable,omitempty"`
	CreatedAt string `json:"createdAt"` // ISO 8601
	UpdatedAt string `json:"updatedAt"` // ISO 8601
}

// QueuedVerification is one row of the compliance review queue.
//
// It is a VerificationRecord plus the userId. The app-facing record omits the id because the app
// already knows its own; a reviewer needs it to act, and it is an opaque hash rather than a name.
type QueuedVerification struct {
	UserID string `json:"userId"`
	// Email of the account that submitted, when the app supplied one.
	//
	// Present only on this ops-facing type, never on the app-facing VerificationRecord. It is a
	// label for the reviewer: no decision reads it, and it is not proof of anything, because these
	// routes have no session to have checked it against.
	Email string `json:"email,omitempty"`
	VerificationRecord
}

// IsValidVerificationStatus reports whether s is one of the defined lifecycle states.
//
// Used to reject unknown filter values rather than silently returning everything — a queue that
// quietly ignores its filter shows a reviewer the wrong work.
func IsValidVerificationStatus(s string) bool {
	switch VerificationStatus(s) {
	case VerificationNotStarted, VerificationPending, VerificationInReview,
		VerificationApproved, VerificationRejected, VerificationExpired:
		return true
	default:
		return false
	}
}

// ProviderVerdict is the payload a verification provider posts to the webhook.
type ProviderVerdict struct {
	ProviderRef string `json:"providerRef"`
	// Decision is "approved", "rejected" or "review".
	Decision   string `json:"decision"`
	Tier       int    `json:"tier,omitempty"`
	ReasonCode string `json:"reasonCode,omitempty"`
}

// DecideRequest is the body of the manual (compliance) decision endpoint.
type DecideRequest struct {
	// Decision is "approved" or "rejected".
	Decision   string `json:"decision"`
	ReasonCode string `json:"reasonCode,omitempty"`
	// Reviewer identifies the compliance officer for the audit trail.
	Reviewer string `json:"reviewer,omitempty"`
}
