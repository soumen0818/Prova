package schema

// Backend API request/response contracts (mobile <-> Go backend). Mirrors api.ts.

// StellarNetwork identifies which Stellar network a component targets.
type StellarNetwork string

const (
	NetworkTestnet StellarNetwork = "testnet"
	NetworkMainnet StellarNetwork = "mainnet"
)

// TransferStatus is the lifecycle state of a private transfer (tracked without amounts):
// pending → submitting → submitted → confirmed → (paid_out) | rejected | failed.
type TransferStatus string

const (
	StatusPending    TransferStatus = "pending"    // accepted by the backend, not yet on chain
	StatusSubmitting TransferStatus = "submitting" // relayer is submitting to the contract
	StatusSubmitted  TransferStatus = "submitted"  // tx sent, awaiting confirmation
	StatusConfirmed  TransferStatus = "confirmed"  // recorded on-chain (commitment + nullifier)
	StatusPaidOut    TransferStatus = "paid_out"   // beneficiary side settled (Phase 5)
	StatusRejected   TransferStatus = "rejected"   // invalid proof / replayed nullifier
	StatusFailed     TransferStatus = "failed"     // submission error after retries
)

// SubmitTransferRequest is the body of POST /transfers. The amount never leaves the device, so it
// is never in this request.
type SubmitTransferRequest struct {
	TransferProof TransferProof `json:"transferProof"`
	// TravelRuleEnvelope is optional in Phase 2, required for the real corridor in Phase 5.
	TravelRuleEnvelope *SealedTravelRuleEnvelope `json:"travelRuleEnvelope,omitempty"`
}

// SubmitTransferResponse is the response to POST /transfers.
type SubmitTransferResponse struct {
	TransferID string         `json:"transferId"`
	Status     TransferStatus `json:"status"`
	// TxHash is the Soroban transaction hash, once submitted.
	TxHash string `json:"txHash,omitempty"`
}

// TransferRecord is one row of a user's history (never contains amounts).
type TransferRecord struct {
	TransferID string         `json:"transferId"`
	Status     TransferStatus `json:"status"`
	Commitment string         `json:"commitment"`
	Nullifier  string         `json:"nullifier"`
	CreatedAt  string         `json:"createdAt"` // ISO 8601
	UpdatedAt  string         `json:"updatedAt"` // ISO 8601
	TxHash     string         `json:"txHash,omitempty"`
}

// APIError is the standard error envelope returned by the API.
type APIError struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
}
