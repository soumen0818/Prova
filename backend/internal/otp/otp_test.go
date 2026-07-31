package otp

import (
	"context"
	"strings"
	"testing"
)

// Runs against the in-process fallback, which is the path that must work when Redis is down.

func TestGenerateProducesSixRandomDigits(t *testing.T) {
	seen := map[string]int{}
	for i := 0; i < 200; i++ {
		code, err := Generate()
		if err != nil {
			t.Fatalf("generate: %v", err)
		}
		if len(code) != Digits {
			t.Fatalf("code %q has %d digits, want %d", code, len(code), Digits)
		}
		if strings.Trim(code, "0123456789") != "" {
			t.Fatalf("code %q is not all digits", code)
		}
		seen[code]++
	}
	// Not a statistical test — a smoke check that this is not effectively a constant, which is
	// exactly the failure mode of a time-seeded math/rand.
	if len(seen) < 150 {
		t.Errorf("only %d distinct codes in 200 draws — randomness looks broken", len(seen))
	}
}

func TestIssueThenVerifySucceedsOnce(t *testing.T) {
	s := New(nil)
	ctx := context.Background()

	code, err := s.Issue(ctx, "user@example.com")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if err := s.Verify(ctx, "user@example.com", code); err != nil {
		t.Fatalf("verify: %v", err)
	}
	// Single-use: a code seen in transit must not be replayable.
	if err := s.Verify(ctx, "user@example.com", code); err != ErrNoCode {
		t.Errorf("replay → %v, want ErrNoCode", err)
	}
}

// A code issued for one address must not work for another, even if both happen to be the same six
// digits — which is why the digest is bound to the identifier.
func TestCodeIsBoundToItsIdentifier(t *testing.T) {
	s := New(nil)
	ctx := context.Background()

	code, _ := s.Issue(ctx, "a@example.com")
	_, _ = s.Issue(ctx, "b@example.com")

	if err := s.Verify(ctx, "b@example.com", code); err == nil {
		t.Fatal("a code must not verify against a different identifier")
	}
}

// This is what actually stops guessing: the target ceases to exist. Rate limiting only slows it.
func TestCodeIsDestroyedAfterTooManyWrongGuesses(t *testing.T) {
	s := New(nil)
	ctx := context.Background()
	code, _ := s.Issue(ctx, "victim@example.com")

	wrong := "000000"
	if wrong == code {
		wrong = "111111"
	}

	for i := 1; i < MaxAttempts; i++ {
		if err := s.Verify(ctx, "victim@example.com", wrong); err != ErrIncorrect {
			t.Fatalf("attempt %d → %v, want ErrIncorrect", i, err)
		}
	}
	if err := s.Verify(ctx, "victim@example.com", wrong); err != ErrTooManyAttempts {
		t.Fatalf("final attempt → %v, want ErrTooManyAttempts", err)
	}
	// Even the CORRECT code is now useless — the record is gone.
	if err := s.Verify(ctx, "victim@example.com", code); err != ErrNoCode {
		t.Errorf("after burnout the real code → %v, want ErrNoCode", err)
	}
}

// Wrong guesses must consume an attempt, or the cap means nothing.
func TestWrongGuessesConsumeAttempts(t *testing.T) {
	s := New(nil)
	ctx := context.Background()
	_, _ = s.Issue(ctx, "k")

	before := s.AttemptsRemaining(ctx, "k")
	_ = s.Verify(ctx, "k", "000000")
	after := s.AttemptsRemaining(ctx, "k")

	if after >= before {
		t.Errorf("attempts went %d → %d; a wrong guess must consume one", before, after)
	}
}

// "Resend" must replace the previous code, not leave two valid — which would double an attacker's
// chances for free.
func TestReissueInvalidatesThePreviousCode(t *testing.T) {
	s := New(nil)
	ctx := context.Background()

	first, _ := s.Issue(ctx, "user@example.com")
	second, _ := s.Issue(ctx, "user@example.com")
	if first == second {
		t.Skip("the same code was drawn twice; nothing to distinguish")
	}

	if err := s.Verify(ctx, "user@example.com", first); err == nil {
		t.Error("the superseded code must no longer verify")
	}
}

func TestVerifyWithNoIssuedCode(t *testing.T) {
	s := New(nil)
	if err := s.Verify(context.Background(), "nobody@example.com", "123456"); err != ErrNoCode {
		t.Errorf("→ %v, want ErrNoCode", err)
	}
}
