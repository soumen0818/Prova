package provider

import "errors"

// Typed outcomes every provider must map its network's failures onto.
//
// # Why typed errors rather than strings
//
// The caller's decision differs per case: retry, tell the user to re-prove, tell them it already
// worked, or page an operator. Deciding that by matching on error text means every caller
// re-implements the same judgement, and one of them gets it wrong — which is exactly how a definite
// failure once got reported to users as "still processing" because the CLI output happened to
// contain the word "network".
//
// Providers wrap these with %w and add detail. Callers use errors.Is and never read the message.
var (
	// ErrUnavailable means settlement cannot be attempted at all right now — nothing was submitted.
	// Distinct from a failure, because the user has lost nothing and a retry is reasonable.
	ErrUnavailable = errors.New("settlement provider unavailable")

	// ErrAlreadySettled means this exact settlement already happened.
	//
	// NOT a failure. It is the correct outcome of a retry whose first attempt succeeded but whose
	// answer was lost, and the honest response is to report success — the money moved, once. On
	// Stellar this surfaces as the contract rejecting an already-used nullifier.
	ErrAlreadySettled = errors.New("already settled")

	// ErrProofRejected means the value layer verified the proof and refused it.
	//
	// Terminal for this proof. Retrying the same bytes cannot help; the wallet must build a new one.
	ErrProofRejected = errors.New("proof rejected")

	// ErrRootExpired means the spend proved membership against a root the network no longer accepts.
	//
	// Actionable and recoverable: the wallet refetches its path and re-proves. The distinction from
	// ErrProofRejected matters — one means "your proof is wrong", the other "your proof is stale".
	ErrRootExpired = errors.New("merkle root no longer accepted")

	// ErrPaused means the network is deliberately halted. Withdrawals are never paused, so this only
	// affects deposits and transfers.
	ErrPaused = errors.New("settlement paused")

	// ErrNotFolded means a commitment is queued but not yet a leaf.
	//
	// Real money that cannot move yet, which a caller must never render as "not found".
	ErrNotFolded = errors.New("commitment queued but not yet folded")

	// ErrUnknownCommitment means the privacy layer has no record of this commitment at all.
	ErrUnknownCommitment = errors.New("unknown commitment")
)

// Retryable reports whether sending the same request again could plausibly succeed.
//
// Deliberately conservative: anything not known to be safe returns false. A wrong "true" here means
// resubmitting a payment, so the default has to be the one that cannot double-spend.
//
// Note ErrAlreadySettled is NOT retryable — not because retrying is dangerous (the nullifier makes
// it safe) but because there is nothing left to do. It already worked.
func Retryable(err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, ErrUnavailable):
		// Nothing was submitted, so nothing can be duplicated.
		return true
	case errors.Is(err, ErrPaused):
		// Deliberate and temporary; the request never reached the contract.
		return true
	default:
		// Includes ErrProofRejected (terminal), ErrRootExpired (needs a NEW proof, not a retry of
		// this one) and every unrecognised error. An unknown failure may have been applied before it
		// failed, so it is not safe to repeat.
		return false
	}
}
