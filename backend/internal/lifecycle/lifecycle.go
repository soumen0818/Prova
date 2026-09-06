// Package lifecycle enforces the transfer state machine (Docs/progress.md §0.2).
//
// # Why this exists
//
// The states already existed — `schema.TransferStatus` names all seven — but only as a comment
// describing the intended order. Nothing checked it. Any code holding a transfer could set any
// status, so "confirmed" could follow "failed", a terminal transfer could quietly reopen, and the
// only description of the real rules lived in a doc comment that no test could disagree with.
//
// For a payments system that matters more than it looks. The status is what tells a person whether
// their money moved. A state machine nobody enforces is a state machine that is wrong somewhere, and
// the place it goes wrong is the place somebody is owed an answer.
//
// # What this does NOT do
//
// It does not store anything and it does not decide *when* to transition — callers own that. It
// answers one question: given where a transfer is, is this move legal? Keeping it a pure function
// means it is exhaustively testable, which is the only way to trust a table like this.
package lifecycle

import (
	"fmt"

	"github.com/prova/shared/schema"
)

// transitions is the whole state machine: which states may follow which.
//
// Read it as "from → the complete set of legal nexts". Anything absent is illegal, which makes the
// default deny rather than allow — the right way round for money.
var transitions = map[schema.TransferStatus][]schema.TransferStatus{
	// Accepted by the backend, nothing on-chain yet. May start submitting, or fail before it ever
	// gets there (no relayer, a rejected precondition).
	schema.StatusPending: {
		schema.StatusSubmitting,
		schema.StatusRejected,
		schema.StatusFailed,
	},

	// The relayer is submitting.
	//
	// `confirmed` is reachable directly, which looks like a skipped step and is not. The Soroban
	// submitter returns only once the chain has accepted the transaction, so a successful submit IS
	// the confirmation — there is no interval during which it is sent-but-unknown. `submitted`
	// remains in the machine for a submitter that does not have that property (a fire-and-forget
	// path, or a network where inclusion is asynchronous), and both routes converge on `confirmed`.
	//
	// This was originally written to force submitting → submitted → confirmed, which would have
	// rejected every transfer the working relayer makes. The table follows the system; the system
	// does not get bent to fit a tidier table.
	schema.StatusSubmitting: {
		schema.StatusSubmitted,
		schema.StatusConfirmed,
		schema.StatusRejected,
		schema.StatusFailed,
	},

	// The transaction was sent and is awaiting confirmation.
	//
	// This is the genuinely ambiguous state — the one where the money may or may not have moved —
	// so every outcome remains reachable from here, and nothing may skip it on the way to confirmed.
	schema.StatusSubmitted: {
		schema.StatusConfirmed,
		schema.StatusRejected,
		schema.StatusFailed,
	},

	// On-chain: commitment and nullifier recorded. The value has moved inside the pool.
	//
	// The only forward move is payout. Notably NOT to failed or rejected: once the chain has
	// recorded it, no later disappointment can un-move the money, and saying otherwise on a screen
	// would be a lie about somebody's balance.
	schema.StatusConfirmed: {
		schema.StatusPaidOut,
	},

	// Terminal. Listed explicitly with empty sets rather than omitted, so that "terminal" is a fact
	// in the table rather than an accident of a missing key.
	schema.StatusPaidOut:  {},
	schema.StatusRejected: {},
	schema.StatusFailed:   {},
}

// Terminal reports whether a status admits no further transitions.
func Terminal(s schema.TransferStatus) bool {
	next, known := transitions[s]
	return known && len(next) == 0
}

// Known reports whether a status is part of the machine at all.
//
// Worth checking separately: a status read back from a database written by an older or newer
// version is not a transition problem, it is an unrecognised value, and the two deserve different
// handling.
func Known(s schema.TransferStatus) bool {
	_, ok := transitions[s]
	return ok
}

// CanTransition reports whether from → to is legal.
//
// A no-op transition (from == to) is legal by design. Redelivery is normal — a retried webhook, a
// duplicated queue message — and treating "still submitted" as an error would make every at-least-
// once delivery path fight the state machine.
func CanTransition(from, to schema.TransferStatus) bool {
	if from == to {
		return Known(from)
	}
	for _, allowed := range transitions[from] {
		if allowed == to {
			return true
		}
	}
	return false
}

// Transition validates a move and returns the new status, or an error explaining the refusal.
//
// The error names both states, because the useful question when this fires is not "was it illegal"
// but "what did the code think was happening?".
func Transition(from, to schema.TransferStatus) (schema.TransferStatus, error) {
	if !Known(from) {
		return from, fmt.Errorf("%w: %q", ErrUnknownStatus, from)
	}
	if !Known(to) {
		return from, fmt.Errorf("%w: %q", ErrUnknownStatus, to)
	}
	if from == to {
		return to, nil
	}
	if Terminal(from) {
		return from, fmt.Errorf("%w: %q is terminal, cannot move to %q", ErrTerminal, from, to)
	}
	if !CanTransition(from, to) {
		return from, fmt.Errorf("%w: %q → %q", ErrIllegalTransition, from, to)
	}
	return to, nil
}

// Next returns the legal successors of a status, for callers that want to offer or validate options
// rather than test one. The returned slice is a copy; the table must not be mutable from outside.
func Next(s schema.TransferStatus) []schema.TransferStatus {
	src := transitions[s]
	out := make([]schema.TransferStatus, len(src))
	copy(out, src)
	return out
}

// Settled reports whether the money has provably moved.
//
// Deliberately narrower than Terminal: `rejected` and `failed` are terminal but nothing moved, and
// answering "is this finished?" when somebody asked "did my money arrive?" is exactly the confusion
// this package exists to prevent.
func Settled(s schema.TransferStatus) bool {
	return s == schema.StatusConfirmed || s == schema.StatusPaidOut
}

// InFlight reports whether an outcome is still pending — the states where a user should be told to
// wait rather than to retry, because retrying could pay twice.
func InFlight(s schema.TransferStatus) bool {
	switch s {
	case schema.StatusPending, schema.StatusSubmitting, schema.StatusSubmitted:
		return true
	default:
		return false
	}
}
