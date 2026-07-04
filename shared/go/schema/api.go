package schema

// Backend API request/response contracts (mobile <-> Go backend). Mirrors api.ts.

// StellarNetwork identifies which Stellar network a component targets.
type StellarNetwork string

const (
	NetworkTestnet StellarNetwork = "testnet"
	NetworkMainnet StellarNetwork = "mainnet"
)

// TransferStatus is the lifecycle state of a private transfer.
type TransferStatus string

const (
	StatusPending        TransferStatus = "pending"
	StatusProofSubmitted TransferStatus = "proof_submitted"
	StatusConfirmed      TransferStatus = "confirmed"
	StatusPaidOut        TransferStatus = "paid_out"
	StatusRejected       TransferStatus = "rejected"
	StatusFailed         TransferStatus = "failed"
)

// SubmitTransferRequest is the body of POST /transfers.
type SubmitTransferRequest struct {
	TransferProof      TransferProof            `json:"transferProof"`
	TravelRuleEnvelope SealedTravelRuleEnvelope `json:"travelRuleEnvelope"`
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
	CreatedAt  string         `json:"createdAt"` // ISO 8601
	TxHash     string         `json:"txHash,omitempty"`
}

// APIError is the standard error envelope returned by the API.
type APIError struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
}
