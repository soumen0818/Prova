package schema

// ErrorCode is a stable, client-facing error identifier. Mirrors errors.ts.
// Keep these stable — clients branch on them. Add, don't repurpose.
type ErrorCode string

const (
	// Proof / verification.
	ErrInvalidProof         ErrorCode = "invalid_proof"
	ErrNullifierAlreadyUsed ErrorCode = "nullifier_already_used"
	ErrAmountOutOfRange     ErrorCode = "amount_out_of_range"

	// KYC / credential.
	ErrKYCRequired       ErrorCode = "kyc_required"
	ErrCredentialExpired ErrorCode = "credential_expired"
	ErrCredentialInvalid ErrorCode = "credential_invalid"

	// Anchor / settlement.
	ErrAnchorUnavailable ErrorCode = "anchor_unavailable"
	ErrDepositFailed     ErrorCode = "deposit_failed"
	ErrPayoutFailed      ErrorCode = "payout_failed"

	// Generic.
	ErrUnauthenticated ErrorCode = "unauthenticated"
	ErrRateLimited     ErrorCode = "rate_limited"
	ErrInternal        ErrorCode = "internal"
)
