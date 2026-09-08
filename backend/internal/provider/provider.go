// Package provider defines the boundaries between Prova's business logic and the networks
// underneath it (Docs/progress.md §0.1, Docs/v2-midnight-architecture.md §20-21).
//
// # Why these exist
//
// Prova does two separable things: it *proves* a transfer is legitimate, and it *settles* value.
// Today both happen on Stellar — the Soroban pool contract verifies a Groth16 proof and moves the
// tokens it custodies, in one transaction. That coupling is a genuine strength and it is also the
// reason nothing in the backend can currently be tested, reasoned about, or replaced independently.
//
// These interfaces name the two responsibilities so the remittance layer depends on *what* is done
// rather than *who* does it. That is worth having on its own merits — a stub settlement provider
// makes handler tests possible without a chain — and it is the precondition for evaluating a
// different privacy backend without rewriting the application.
//
// # What this is NOT
//
// This is not an abstraction over "blockchains", and it does not assume the two layers can be
// swapped independently. The privacy and settlement layers are coupled by what custodies value:
// today the same contract does both, and any future split has to answer that question explicitly
// (Docs/progress.md §1.3) rather than inheriting an answer from an interface shape.
//
// Keep these interfaces narrow. Every method here is a commitment about what a provider must do,
// and a wide interface is one that only its current implementation can satisfy.
package provider

import "context"

// SpendKind distinguishes the two things a spend can be, which differ only in whether value leaves
// the pool. Named rather than inferred from a zero amount, because "unshield of zero" and "private
// transfer" are the same numbers with different meanings.
type SpendKind int

const (
	// KindTransact is a fully private transfer: one note in, two notes out, nothing leaves.
	KindTransact SpendKind = iota
	// KindUnshield releases value to a public destination bound inside the proof.
	KindUnshield
)

func (k SpendKind) String() string {
	if k == KindUnshield {
		return "unshield"
	}
	return "transact"
}

// SettlementRequest is one movement of value, already proved legitimate by the privacy layer.
//
// Every field except IdempotencyKey is bound inside the proof, so a settlement provider cannot
// alter the amount, the outputs or the destination — it can only refuse to submit, or submit what
// it was given. That is the same trust boundary the relayer already documents, stated as a type.
type SettlementRequest struct {
	// Kind selects transfer-vs-withdrawal semantics.
	Kind SpendKind

	// ProofHex is A(96)‖B(192)‖C(96) as 768 hex characters.
	ProofHex string
	// Root is the Merkle root the spend proves membership against.
	Root string
	// Nullifier is published on-chain to burn the input note.
	Nullifier string
	// Outputs are the two notes this spend creates, with their proof-bound encrypted payloads.
	Outputs SettlementOutputs
	// CurrentTime must be the exact value bound into the proof. A drift of one second is a rejected
	// proof, because it is a public input — see the note in mobile/src/lib/pool.ts.
	CurrentTime uint64

	// Amount and Destination are set only for KindUnshield, and are bound inside the proof.
	Amount      int64
	Destination string

	// IdempotencyKey identifies this settlement attempt across retries.
	//
	// The only field NOT bound inside the proof, because it is about delivery rather than value.
	// A provider must treat two requests carrying the same key as one settlement — see
	// Docs/progress.md §0.4. Empty means the caller has opted out, which is only acceptable where
	// the underlying operation is already idempotent by construction (a nullifier makes a spend
	// self-idempotent on-chain: the second submission is rejected as already-spent).
	IdempotencyKey string
}

// SettlementOutputs are the two notes a spend creates.
type SettlementOutputs struct {
	C1, C2              string
	EpkX, EpkY          string
	Enc1Amount, Enc1Rho string
	Enc2Amount, Enc2Rho string
}

// SettlementResult is what came back from the value layer.
type SettlementResult struct {
	// TxHash identifies the settlement on its network. Empty is possible on a success whose hash
	// could not be parsed, which is why Settled is separate rather than inferred from this.
	TxHash string
	// Settled is true when the value layer accepted and applied the movement.
	Settled bool
}

// SettlementProvider moves value that the privacy layer has already authorised.
//
// Implementations must map their network's failure modes onto the typed errors in errors.go, so
// callers can distinguish "this will never work" from "try again" without reading strings. A
// provider that returns raw network errors forces every caller to re-implement that judgement, and
// they will not all do it the same way.
type SettlementProvider interface {
	// Name identifies the implementation in logs and operational output.
	Name() string

	// Settle submits one authorised movement of value.
	//
	// Must be idempotent on req.IdempotencyKey where the underlying network does not already provide
	// it. Returning ErrAlreadySettled for a repeated key is correct and expected; it is not a
	// failure.
	Settle(ctx context.Context, req SettlementRequest) (*SettlementResult, error)

	// Available reports whether settlement can currently be attempted at all.
	//
	// Separate from Settle returning an error so a caller can say "temporarily unavailable" before
	// taking a user through a flow that cannot complete.
	Available() bool
}

// PrivacyProvider answers what the privacy layer knows about state a wallet cannot see for itself.
//
// A wallet holds its own note secrets but has no view of the tree, so it needs the membership path
// to build a spend proof, and the spent set to know what it still owns. Everything here is already
// public on the underlying network — this interface exposes no secret and takes none.
type PrivacyProvider interface {
	// Name identifies the implementation in logs and operational output.
	Name() string

	// MerklePath returns the membership path for a commitment, so a wallet can prove it owns a note
	// that is in the tree.
	//
	// Returns ErrNotFolded when the commitment is queued but not yet a leaf: real money that cannot
	// move yet, which a caller must distinguish from ErrUnknownCommitment ("we have never seen
	// this"). Conflating them tells a user their money is lost when it is one fold away.
	MerklePath(ctx context.Context, commitment string) (*MerklePath, error)

	// SpentNullifiers filters the given nullifiers down to those the chain has seen spent.
	//
	// Takes a batch because a wallet checks all its notes at once, and because asking per-note would
	// leak which notes belong together.
	SpentNullifiers(ctx context.Context, nullifiers []string) ([]string, error)

	// State reports the privacy layer's current public state, for operators and for wallets deciding
	// whether their view is current.
	State(ctx context.Context) (*PrivacyState, error)
}

// MerklePath is a note's membership proof: the leaf's position, its sibling hashes, and the root
// they hash up to.
type MerklePath struct {
	LeafIndex int64
	Siblings  []string
	Root      string
}

// PrivacyState is the public state of the privacy layer.
type PrivacyState struct {
	// Root is the current Merkle root.
	Root string
	// TreeSize is the number of leaves folded into the tree.
	TreeSize int64
	// QueueDepth is commitments accepted but not yet folded.
	//
	// The number to alert on: a queue that climbs and stays up means new notes are not becoming
	// spendable, while every other signal still looks healthy.
	QueueDepth int64
}
