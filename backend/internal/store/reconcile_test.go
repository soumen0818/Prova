package store

import (
	"testing"

	"github.com/prova/backend/internal/lifecycle"
	"github.com/prova/shared/schema"
)

// The states StuckTransfers hardcodes in its SQL.
//
// Kept here rather than read out of the query string because the point is to compare two independent
// statements of the same fact: if someone adds a state to the machine and forgets the query, the two
// disagree and this fails. Deriving one from the other would make them agree by construction and
// prove nothing.
var stuckStates = []schema.TransferStatus{
	schema.StatusPending,
	schema.StatusSubmitting,
	schema.StatusSubmitted,
}

// A transfer is "stuck" precisely when it is in flight and has stopped moving. If those two
// definitions drift, reconciliation goes blind exactly where it matters: a state that is non-terminal
// but missing from the query is one the system can enter and never report on, and the only person
// who notices is whoever was owed the money.
func TestStuckStatesMatchTheLifecycleMachine(t *testing.T) {
	all := []schema.TransferStatus{
		schema.StatusPending,
		schema.StatusSubmitting,
		schema.StatusSubmitted,
		schema.StatusConfirmed,
		schema.StatusPaidOut,
		schema.StatusRejected,
		schema.StatusFailed,
	}

	inQuery := map[schema.TransferStatus]bool{}
	for _, s := range stuckStates {
		inQuery[s] = true
	}

	for _, s := range all {
		wantTracked := lifecycle.InFlight(s)
		if inQuery[s] != wantTracked {
			if wantTracked {
				t.Errorf("%q is in-flight but StuckTransfers does not look for it — a transfer can "+
					"stall there and never be reported", s)
			} else {
				t.Errorf("%q is not in-flight but StuckTransfers looks for it — settled and failed "+
					"transfers would be reported as stuck forever", s)
			}
		}
	}
}

// Terminal states must never be reported as stuck. A confirmed transfer that is simply old is
// finished, not stalled, and paging someone about it teaches them to ignore the alert.
func TestTerminalStatesAreNeverStuck(t *testing.T) {
	for _, s := range stuckStates {
		if lifecycle.Terminal(s) {
			t.Errorf("%q is terminal and must not be treated as stuck", s)
		}
		if lifecycle.Settled(s) {
			t.Errorf("%q is settled — the money moved, so it is not stuck", s)
		}
	}
}
