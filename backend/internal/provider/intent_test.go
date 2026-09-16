package provider

import (
	"context"
	"errors"
	"testing"
)

func validRequest() SettlementRequest {
	return SettlementRequest{
		Kind:      KindTransact,
		ProofHex:  "ab12",
		Root:      "root",
		Nullifier: "nullifier-1",
	}
}

// The common path during migration: a client that knows nothing about Midnight still produces a
// valid, honestly-labelled intent. If this were awkward, callers would reach for a shortcut and the
// label would start lying.
func TestIntentWithoutComplianceIsValid(t *testing.T) {
	i := NewIntent(validRequest())

	if err := i.Validate(); err != nil {
		t.Fatalf("a plain intent must validate: %v", err)
	}
	if i.Compliance != ComplianceNotAttempted {
		t.Errorf("got %q, want not_attempted", i.Compliance)
	}
	if i.AuthorisedBy() != "soroban proof" {
		t.Errorf("authorisation should name the Soroban proof, got %q", i.AuthorisedBy())
	}
}

// "No proof was offered" and "a proof was offered and failed" are opposite facts. A boolean would
// collapse them, and the difference matters most exactly when something is wrong: the first is an
// old client, the second is a bug or an attack.
func TestComplianceStatesAreDistinguishable(t *testing.T) {
	none := NewIntent(validRequest())
	ok := NewIntent(validRequest()).WithCompliance(ComplianceVerified, "commit-abc", "")
	bad := NewIntent(validRequest()).WithCompliance(ComplianceFailed, "", "expired credential")

	for _, i := range []SettlementIntent{none, ok, bad} {
		if err := i.Validate(); err != nil {
			t.Fatalf("%q should validate: %v", i.Compliance, err)
		}
	}
	if none.Compliance == bad.Compliance {
		t.Error("not_attempted and failed must not be the same state")
	}
	if ok.EligibilityCommitment == "" {
		t.Error("a verified intent must carry its commitment, or it cannot be audited")
	}
}

// A boundary type that silently repairs its own contradictions is one nobody can reason about.
// Each case here is a caller that has lost track of what it actually did.
func TestContradictoryEvidenceIsRefused(t *testing.T) {
	for _, tc := range []struct {
		name   string
		intent SettlementIntent
	}{
		{
			"verified without a commitment — unauditable, so indistinguishable from unverified",
			NewIntent(validRequest()).WithCompliance(ComplianceVerified, "", ""),
		},
		{
			"verified but carrying an error — which is it?",
			NewIntent(validRequest()).WithCompliance(ComplianceVerified, "commit", "something failed"),
		},
		{
			"failed without a reason — the least useful moment to be vague",
			NewIntent(validRequest()).WithCompliance(ComplianceFailed, "", ""),
		},
		{
			"not attempted, yet evidence is attached",
			NewIntent(validRequest()).WithCompliance(ComplianceNotAttempted, "commit", ""),
		},
		{
			"a status nobody defined",
			NewIntent(validRequest()).WithCompliance(ComplianceStatus("maybe"), "", ""),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.intent.Validate(); !errors.Is(err, ErrComplianceMismatch) {
				t.Errorf("got %v, want ErrComplianceMismatch", err)
			}
		})
	}
}

// An intent that cannot settle must be refused at construction rather than at the chain.
func TestIncompleteIntentIsRefused(t *testing.T) {
	noNullifier := NewIntent(SettlementRequest{Kind: KindTransact, ProofHex: "ab"})
	if err := noNullifier.Validate(); !errors.Is(err, ErrIntentIncomplete) {
		t.Errorf("missing nullifier: got %v, want ErrIntentIncomplete", err)
	}

	noProof := NewIntent(SettlementRequest{Kind: KindTransact, Nullifier: "n"})
	if err := noProof.Validate(); !errors.Is(err, ErrIntentIncomplete) {
		t.Errorf("missing proof: got %v, want ErrIntentIncomplete", err)
	}
}

// This boundary joins two systems that will not always be deployed together. An unversioned
// structure forces a guess about what an old peer meant, and the guess is wrong exactly when it
// matters.
func TestVersionMismatchIsRefused(t *testing.T) {
	i := NewIntent(validRequest())
	i.Version = IntentVersion + 1

	if err := i.Validate(); !errors.Is(err, ErrIntentVersion) {
		t.Errorf("got %v, want ErrIntentVersion", err)
	}
}

// Recording an intent must not be able to change it afterwards, or the audit trail and the decision
// can disagree about the same transfer.
func TestWithComplianceDoesNotMutate(t *testing.T) {
	original := NewIntent(validRequest())
	_ = original.WithCompliance(ComplianceVerified, "commit", "")

	if original.Compliance != ComplianceNotAttempted {
		t.Error("WithCompliance mutated the original instead of returning a copy")
	}
}

// 3.3's exit test: one verified transfer produces exactly one settlement, and a duplicate never
// produces a second payment.
//
// The key is the NULLIFIER, not a generated id. That is the whole trick — the contract refuses a
// nullifier it has seen, so the guarantee holds on-chain across every replica rather than in one
// process's memory. A generated key would be weaker while looking stronger.
func TestDuplicateIntentCannotPayTwice(t *testing.T) {
	stub := newStub()
	intent := NewIntent(validRequest()).WithCompliance(ComplianceVerified, "commit-abc", "")

	if err := intent.Validate(); err != nil {
		t.Fatalf("intent should be valid: %v", err)
	}

	req := intent.Settlement
	req.IdempotencyKey = intent.IdempotencyKey()

	first, err := stub.Settle(context.Background(), req)
	if err != nil {
		t.Fatalf("first settlement: %v", err)
	}
	if !first.Settled {
		t.Fatal("the first settlement should succeed")
	}

	// The same intent, submitted again — a retry after a lost reply, or a replay.
	_, err = stub.Settle(context.Background(), req)
	if !errors.Is(err, ErrAlreadySettled) {
		t.Fatalf("a duplicate must report ErrAlreadySettled, got %v", err)
	}
	if len(stub.settled) != 1 {
		t.Errorf("value moved %d times, want exactly 1", len(stub.settled))
	}
}

// Two different transfers must settle independently — the idempotency key must not be so broad that
// it swallows unrelated payments.
func TestDistinctIntentsBothSettle(t *testing.T) {
	stub := newStub()

	a := validRequest()
	a.IdempotencyKey = a.Nullifier
	b := validRequest()
	b.Nullifier = "nullifier-2"
	b.IdempotencyKey = b.Nullifier

	for _, r := range []SettlementRequest{a, b} {
		if _, err := stub.Settle(context.Background(), r); err != nil {
			t.Fatalf("settling %s: %v", r.Nullifier, err)
		}
	}
	if len(stub.settled) != 2 {
		t.Errorf("two distinct transfers settled %d times, want 2", len(stub.settled))
	}
}

// The trust model must be legible at the point of use, not only in a document.
//
// Under Option C the answer is always the Soroban proof — the Midnight proof is evidence, never
// authority. When that changes, this test changes with it, deliberately.
func TestAuthorisationNeverClaimsMidnightEnforces(t *testing.T) {
	verified := NewIntent(validRequest()).WithCompliance(ComplianceVerified, "commit", "")
	plain := NewIntent(validRequest())

	for _, i := range []SettlementIntent{verified, plain} {
		got := i.AuthorisedBy()
		if got[:13] != "soroban proof" {
			t.Errorf("authorisation must lead with the Soroban proof, got %q", got)
		}
	}

	// A verified compliance proof may be mentioned, but only as advisory.
	if a := verified.AuthorisedBy(); a == plain.AuthorisedBy() {
		t.Error("a verified intent should record that compliance was checked")
	}
}
