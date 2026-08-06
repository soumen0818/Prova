package schema

// Shield — moving money INTO the shielded pool. Mirrors shield.ts.
//
// Shield is the one pool operation a relayer cannot perform for a user: the contract runs
// `from.require_auth()` and then moves tokens out of *their* account. So it uses the same
// "server prepares, phone signs, server submits" exchange as the trustline — the user's secret
// never reaches the backend.
//
// A deposit is public by design: the amount and the depositing account are visible on-chain.
// Privacy begins once the value is inside the pool, not before.

// ShieldNoteInput is the note being created, matching the contract's ShieldNote. Every field is a
// 32-byte hex string.
type ShieldNoteInput struct {
	// Commitment is Poseidon(amount, ownerPk, rho) — what goes on-chain.
	Commitment string `json:"commitment"`
	OwnerPk    string `json:"ownerPk"`
	// EpkX/EpkY are the ephemeral public key of the in-circuit note encryption.
	EpkX string `json:"epkX"`
	EpkY string `json:"epkY"`
	// EncAmount/EncRho are the encrypted payload only the note's owner can open.
	EncAmount string `json:"encAmount"`
	EncRho    string `json:"encRho"`
}

// ShieldPrepareRequest is the body of POST /pool/shield/prepare.
type ShieldPrepareRequest struct {
	// Address is the depositing Stellar account (G…) — transaction source and authorising address.
	Address string `json:"address"`
	// Amount is in the token's own units (stroops for a 7-decimal Stellar asset).
	Amount int64           `json:"amount"`
	Note   ShieldNoteInput `json:"note"`
	// Groth16 shield proof from the on-device prover.
	ProofA string `json:"proofA"`
	ProofB string `json:"proofB"`
	ProofC string `json:"proofC"`
}

// Shield submission outcomes.
const (
	// ShieldConfirmed means the transaction succeeded on-chain.
	ShieldConfirmed = "confirmed"
	// ShieldPending means it was accepted but its result was not observed before the deadline. This
	// is NOT failure — the money may still arrive, and reporting failure is how a user deposits
	// twice.
	ShieldPending = "pending"
)

// ShieldSubmitResponse is the outcome of POST /pool/shield/submit.
type ShieldSubmitResponse struct {
	// Hash is the Stellar transaction hash, present even when pending so the outcome is lookupable.
	Hash   string `json:"hash"`
	Status string `json:"status"`
}
