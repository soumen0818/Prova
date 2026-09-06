package lifecycle

import (
	"testing"

	"github.com/prova/shared/schema"
)

// The exact sequences internal/transfers/service.go performs. If enforcement rejects any of these,
// the working product breaks — so they are asserted rather than assumed.
func TestRealTransferServicePathsAreLegal(t *testing.T) {
	for _, tc := range []struct {
		name string
		path []schema.TransferStatus
	}{
		{"success", []schema.TransferStatus{
			schema.StatusPending, schema.StatusSubmitting, schema.StatusConfirmed}},
		{"contract rejection", []schema.TransferStatus{
			schema.StatusPending, schema.StatusSubmitting, schema.StatusRejected}},
		{"submission failure", []schema.TransferStatus{
			schema.StatusPending, schema.StatusSubmitting, schema.StatusFailed}},
		{"async submitter", []schema.TransferStatus{
			schema.StatusPending, schema.StatusSubmitting, schema.StatusSubmitted, schema.StatusConfirmed}},
		{"payout", []schema.TransferStatus{
			schema.StatusPending, schema.StatusSubmitting, schema.StatusConfirmed, schema.StatusPaidOut}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cur := tc.path[0]
			for _, next := range tc.path[1:] {
				var err error
				if cur, err = Transition(cur, next); err != nil {
					t.Fatalf("real path %q broke at %q → %q: %v", tc.name, cur, next, err)
				}
			}
		})
	}
}
