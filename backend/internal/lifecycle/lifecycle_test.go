package lifecycle

import (
	"errors"
	"testing"

	"github.com/prova/shared/schema"
)

// Every status the schema defines. If one is added without being wired into the machine,
// TestEveryStatusIsInTheMachine fails — which is the point: an unmodelled state is one the system
// can reach and cannot reason about.
var all = []schema.TransferStatus{
	schema.StatusPending,
	schema.StatusSubmitting,
	schema.StatusSubmitted,
	schema.StatusConfirmed,
	schema.StatusPaidOut,
	schema.StatusRejected,
	schema.StatusFailed,
}

func TestEveryStatusIsInTheMachine(t *testing.T) {
	for _, s := range all {
		if !Known(s) {
			t.Errorf("status %q is defined in the schema but missing from the machine", s)
		}
	}
	if len(transitions) != len(all) {
		t.Errorf("machine has %d states, schema defines %d — they must not drift",
			len(transitions), len(all))
	}
}

// The whole point of a state machine is that illegal moves are impossible. Asserting the legal set
// exhaustively — every from × to pair — is the only way to know that, because a table is easy to
// read as correct and hard to verify by eye.
func TestExhaustiveTransitionTable(t *testing.T) {
	legal := map[schema.TransferStatus]map[schema.TransferStatus]bool{
		schema.StatusPending: {
			schema.StatusSubmitting: true,
			schema.StatusRejected:   true,
			schema.StatusFailed:     true,
		},
		schema.StatusSubmitting: {
			schema.StatusSubmitted: true,
			// Direct: the Soroban submitter returns only once the chain accepted the transaction.
			schema.StatusConfirmed: true,
			schema.StatusRejected:  true,
			schema.StatusFailed:    true,
		},
		schema.StatusSubmitted: {
			schema.StatusConfirmed: true,
			schema.StatusRejected:  true,
			schema.StatusFailed:    true,
		},
		schema.StatusConfirmed: {
			schema.StatusPaidOut: true,
		},
		schema.StatusPaidOut:  {},
		schema.StatusRejected: {},
		schema.StatusFailed:   {},
	}

	for _, from := range all {
		for _, to := range all {
			want := from == to || legal[from][to] // self-transition is always legal (redelivery)
			if got := CanTransition(from, to); got != want {
				t.Errorf("CanTransition(%q → %q) = %v, want %v", from, to, got, want)
			}
		}
	}
}

// Once the chain has recorded a transfer, no later event may say it did not happen. This is the
// single most important rule here: a screen that walks "confirmed" back to "failed" is telling
// somebody their money vanished after it had already moved.
func TestConfirmedNeverGoesBackwards(t *testing.T) {
	for _, to := range []schema.TransferStatus{
		schema.StatusPending,
		schema.StatusSubmitting,
		schema.StatusSubmitted,
		schema.StatusRejected,
		schema.StatusFailed,
	} {
		if CanTransition(schema.StatusConfirmed, to) {
			t.Errorf("confirmed must never move to %q — the money already moved", to)
		}
	}
	if !CanTransition(schema.StatusConfirmed, schema.StatusPaidOut) {
		t.Error("confirmed must be able to reach paid_out")
	}
}

// A transfer must not appear on-chain before anyone tried to submit it. `pending` means the backend
// accepted it and nothing has been sent, so reaching `confirmed` from there would claim an outcome
// for a transaction that was never made.
//
// `submitting` IS allowed to reach `confirmed`: the Soroban submitter returns only once the chain
// has accepted, so a successful submit is the confirmation.
func TestConfirmedRequiresAnAttemptToSubmit(t *testing.T) {
	if CanTransition(schema.StatusPending, schema.StatusConfirmed) {
		t.Error("pending must not reach confirmed — nothing has been submitted yet")
	}
	if !CanTransition(schema.StatusSubmitting, schema.StatusConfirmed) {
		t.Error("submitting must reach confirmed — the submitter confirms synchronously")
	}
}

// Terminal states stay terminal. Late or duplicated events are common in payments; they must not
// reopen a finished transfer.
func TestTerminalStatesAreFinal(t *testing.T) {
	for _, term := range []schema.TransferStatus{
		schema.StatusPaidOut, schema.StatusRejected, schema.StatusFailed,
	} {
		if !Terminal(term) {
			t.Errorf("%q should be terminal", term)
		}
		for _, to := range all {
			if to == term {
				continue // redelivery of the same terminal state is fine
			}
			if _, err := Transition(term, to); !errors.Is(err, ErrTerminal) {
				t.Errorf("Transition(%q → %q) should report ErrTerminal, got %v", term, to, err)
			}
		}
	}
}

// Redelivery must not be an error. At-least-once delivery is normal, and a state machine that
// rejects a repeated event makes every queue consumer fight it.
func TestSelfTransitionIsAllowed(t *testing.T) {
	for _, s := range all {
		got, err := Transition(s, s)
		if err != nil {
			t.Errorf("Transition(%q → %q) must be a no-op, got %v", s, s, err)
		}
		if got != s {
			t.Errorf("self-transition changed the status: %q → %q", s, got)
		}
	}
}

func TestUnknownStatusIsRejected(t *testing.T) {
	bogus := schema.TransferStatus("in_review")

	if Known(bogus) {
		t.Fatal("a bogus status must not be Known")
	}
	if _, err := Transition(bogus, schema.StatusConfirmed); !errors.Is(err, ErrUnknownStatus) {
		t.Errorf("from an unknown status: got %v, want ErrUnknownStatus", err)
	}
	if _, err := Transition(schema.StatusPending, bogus); !errors.Is(err, ErrUnknownStatus) {
		t.Errorf("to an unknown status: got %v, want ErrUnknownStatus", err)
	}
}

// Transition must not advance the status when it refuses. A caller that ignores the error and
// stores the returned value would otherwise silently perform the very move that was rejected.
func TestRefusedTransitionReturnsTheOriginalStatus(t *testing.T) {
	got, err := Transition(schema.StatusPending, schema.StatusConfirmed)
	if err == nil {
		t.Fatal("pending → confirmed should be refused")
	}
	if got != schema.StatusPending {
		t.Errorf("a refused transition returned %q, want the original %q", got, schema.StatusPending)
	}
}

// "Finished" and "the money moved" are different questions, and answering one when asked the other
// is exactly the confusion that made a failed payment look like a completed one.
func TestSettledIsNarrowerThanTerminal(t *testing.T) {
	for _, s := range []schema.TransferStatus{schema.StatusConfirmed, schema.StatusPaidOut} {
		if !Settled(s) {
			t.Errorf("%q should count as settled", s)
		}
	}
	for _, s := range []schema.TransferStatus{schema.StatusRejected, schema.StatusFailed} {
		if Settled(s) {
			t.Errorf("%q is terminal but nothing moved — it must not count as settled", s)
		}
		if !Terminal(s) {
			t.Errorf("%q should still be terminal", s)
		}
	}
}

// InFlight marks the states where a user must be told to wait rather than retry — retrying an
// in-flight payment is how somebody pays twice.
func TestInFlightCoversExactlyTheUnresolvedStates(t *testing.T) {
	want := map[schema.TransferStatus]bool{
		schema.StatusPending:    true,
		schema.StatusSubmitting: true,
		schema.StatusSubmitted:  true,
	}
	for _, s := range all {
		if got := InFlight(s); got != want[s] {
			t.Errorf("InFlight(%q) = %v, want %v", s, got, want[s])
		}
	}
}

// Next must hand out a copy. If it returned the live slice, a caller could append to it and rewrite
// the machine for the whole process.
func TestNextDoesNotExposeTheTable(t *testing.T) {
	got := Next(schema.StatusPending)
	if len(got) == 0 {
		t.Fatal("pending should have successors")
	}
	got[0] = schema.StatusPaidOut

	if CanTransition(schema.StatusPending, schema.StatusPaidOut) {
		t.Error("mutating the slice returned by Next corrupted the transition table")
	}
}

// The happy path, start to finish, as a single readable assertion.
func TestHappyPathWalksEndToEnd(t *testing.T) {
	path := []schema.TransferStatus{
		schema.StatusPending,
		schema.StatusSubmitting,
		schema.StatusSubmitted,
		schema.StatusConfirmed,
		schema.StatusPaidOut,
	}
	cur := path[0]
	for _, next := range path[1:] {
		var err error
		if cur, err = Transition(cur, next); err != nil {
			t.Fatalf("happy path broke at %q → %q: %v", cur, next, err)
		}
	}
	if !Terminal(cur) || !Settled(cur) {
		t.Errorf("the happy path should end terminal and settled, ended %q", cur)
	}
}
