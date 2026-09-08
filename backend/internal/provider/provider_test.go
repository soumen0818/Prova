package provider

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/prova/backend/internal/pool"
)

// The point of these interfaces is that business logic can be exercised without a chain. If a stub
// cannot satisfy SettlementProvider, the abstraction has failed at the only job it has.
type stubSettlement struct {
	calls     int
	settled   map[string]string // idempotency key -> tx hash
	failWith  error
	available bool
}

func newStub() *stubSettlement {
	return &stubSettlement{settled: map[string]string{}, available: true}
}

func (s *stubSettlement) Name() string    { return "stub" }
func (s *stubSettlement) Available() bool { return s.available }

func (s *stubSettlement) Settle(_ context.Context, req SettlementRequest) (*SettlementResult, error) {
	s.calls++
	if s.failWith != nil {
		return nil, s.failWith
	}
	// Model the nullifier-as-idempotency-key guarantee the real contract provides.
	if hash, ok := s.settled[req.Nullifier]; ok {
		return nil, fmt.Errorf("%w: tx %s", ErrAlreadySettled, hash)
	}
	hash := "tx-" + req.Nullifier
	s.settled[req.Nullifier] = hash
	return &SettlementResult{TxHash: hash, Settled: true}, nil
}

// Compile-time proof that both implementations satisfy their interfaces. Cheap, and it catches a
// signature drift at build time rather than at the call site.
var (
	_ SettlementProvider = (*stubSettlement)(nil)
	_ SettlementProvider = (*StellarSettlement)(nil)
	_ PrivacyProvider    = (*StellarPrivacy)(nil)
)

// 0.1's exit test, as an actual test: settlement can be swapped for a stub, so anything built on
// this interface is testable without a chain, a relayer binary, or network access.
func TestSettlementProviderIsSubstitutable(t *testing.T) {
	var sp SettlementProvider = newStub()

	res, err := sp.Settle(context.Background(), SettlementRequest{
		Kind:      KindTransact,
		Nullifier: "abc123",
	})
	if err != nil {
		t.Fatalf("stub settle: %v", err)
	}
	if !res.Settled || res.TxHash == "" {
		t.Errorf("expected a settled result with a hash, got %+v", res)
	}
}

// A repeated settlement must never move value twice.
//
// This is the property the whole idempotency requirement exists for (Docs/progress.md §0.4), and on
// Stellar it is enforced by the nullifier rather than by bookkeeping: the contract rejects a
// nullifier it has already seen. The stub models that, and the assertion is that a duplicate is
// reported as ErrAlreadySettled — a *success* that already happened, not a new payment.
func TestRepeatedSettlementDoesNotPayTwice(t *testing.T) {
	stub := newStub()
	req := SettlementRequest{Kind: KindTransact, Nullifier: "same-note"}

	first, err := stub.Settle(context.Background(), req)
	if err != nil {
		t.Fatalf("first settle: %v", err)
	}

	_, err = stub.Settle(context.Background(), req)
	if !errors.Is(err, ErrAlreadySettled) {
		t.Fatalf("a repeated settlement must report ErrAlreadySettled, got %v", err)
	}
	if len(stub.settled) != 1 {
		t.Errorf("value moved %d times, want exactly 1", len(stub.settled))
	}
	if first.TxHash == "" {
		t.Error("the first settlement should still report its hash")
	}
}

// Retryable decides whether a caller may resubmit. A wrong "true" resubmits a payment, so the
// defaults matter more than the individual cases.
func TestRetryableIsConservative(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"nil is not a retry", nil, false},
		{"unavailable: nothing was submitted", ErrUnavailable, true},
		{"paused: never reached the contract", ErrPaused, true},
		{"rejected proof is terminal", ErrProofRejected, false},
		{"expired root needs a NEW proof, not a retry", ErrRootExpired, false},
		{"already settled: nothing left to do", ErrAlreadySettled, false},
		{"unknown errors default to unsafe", errors.New("something odd"), false},
		{"wrapped errors are still matched", fmt.Errorf("ctx: %w", ErrUnavailable), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := Retryable(tc.err); got != tc.want {
				t.Errorf("Retryable(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// Every relayer error must land in a known category, because callers branch on these and an
// unmapped one silently falls through to "unknown" — which is how a recoverable failure gets
// reported as a permanent one.
func TestRelayErrorsMapToProviderErrors(t *testing.T) {
	for _, tc := range []struct {
		in   error
		want error
	}{
		{pool.ErrNoteAlreadySpent, ErrAlreadySettled},
		{pool.ErrSpendRejected, ErrProofRejected},
		{pool.ErrRootExpired, ErrRootExpired},
		{pool.ErrPoolPaused, ErrPaused},
	} {
		got := translateRelayError(tc.in)
		if !errors.Is(got, tc.want) {
			t.Errorf("translateRelayError(%v) = %v, want it to match %v", tc.in, got, tc.want)
		}
		// The relayer's own detail must survive: it is the only copy of the CLI's words, and an
		// operator reading /pool/status needs it to tell #4 from a serialisation mismatch.
		if !errors.Is(got, tc.in) {
			t.Errorf("translateRelayError(%v) dropped the underlying error", tc.in)
		}
	}
}

// An unrecognised error must pass through unchanged rather than being forced into a category.
func TestUnknownRelayErrorIsNotMiscategorised(t *testing.T) {
	odd := errors.New("libdbus-1.so.3: cannot open shared object file")
	got := translateRelayError(odd)

	if !errors.Is(got, odd) {
		t.Fatal("an unknown error must pass through")
	}
	for _, known := range []error{ErrAlreadySettled, ErrProofRejected, ErrRootExpired, ErrPaused} {
		if errors.Is(got, known) {
			t.Errorf("an unknown error was miscategorised as %v", known)
		}
	}
}

// A nil relayer is a supported configuration, not a crash. Deployments without a relayer still
// serve every read route; users submit their own transactions.
func TestNilRelayerIsUnavailableNotPanic(t *testing.T) {
	sp := NewStellarSettlement(nil)

	if sp.Available() {
		t.Error("a provider with no relayer must report itself unavailable")
	}
	_, err := sp.Settle(context.Background(), SettlementRequest{})
	if !errors.Is(err, ErrUnavailable) {
		t.Errorf("got %v, want ErrUnavailable", err)
	}
}

// Same for the privacy side: no indexer must not panic a request.
func TestNilPrivacyServiceIsUnavailableNotPanic(t *testing.T) {
	pp := NewStellarPrivacy(nil)
	ctx := context.Background()

	if _, err := pp.MerklePath(ctx, "abc"); !errors.Is(err, ErrUnavailable) {
		t.Errorf("MerklePath: got %v, want ErrUnavailable", err)
	}
	if _, err := pp.SpentNullifiers(ctx, nil); !errors.Is(err, ErrUnavailable) {
		t.Errorf("SpentNullifiers: got %v, want ErrUnavailable", err)
	}
	if _, err := pp.State(ctx); !errors.Is(err, ErrUnavailable) {
		t.Errorf("State: got %v, want ErrUnavailable", err)
	}
}

// "Queued but not folded" and "never seen" are different answers to somebody asking where their
// money is. Collapsing them tells a user their money is lost when it is one fold away.
func TestNotFoldedIsDistinctFromUnknown(t *testing.T) {
	if errors.Is(ErrNotFolded, ErrUnknownCommitment) {
		t.Error("ErrNotFolded must not match ErrUnknownCommitment")
	}
	if errors.Is(ErrUnknownCommitment, ErrNotFolded) {
		t.Error("ErrUnknownCommitment must not match ErrNotFolded")
	}
}

func TestSpendKindNaming(t *testing.T) {
	if KindTransact.String() != "transact" || KindUnshield.String() != "unshield" {
		t.Errorf("kind names wrong: %q / %q", KindTransact, KindUnshield)
	}
}
