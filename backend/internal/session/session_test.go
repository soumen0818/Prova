package session

import (
	"context"
	"testing"
)

func TestIssueAndResolve(t *testing.T) {
	s := New(nil)
	ctx := context.Background()

	token, err := s.Issue(ctx, "ravi@example.com")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if token == "" {
		t.Fatal("Issue returned an empty token")
	}

	email, err := s.Resolve(ctx, token)
	if err != nil || email != "ravi@example.com" {
		t.Fatalf("Resolve = %q, %v; want ravi@example.com", email, err)
	}
}

// A bearer token is the whole credential, so anything that is not exactly a live one must fail.
func TestResolveRejectsAnythingElse(t *testing.T) {
	s := New(nil)
	ctx := context.Background()
	good, _ := s.Issue(ctx, "ravi@example.com")

	for name, token := range map[string]string{
		"empty":     "",
		"garbage":   "not-a-token",
		"truncated": good[:len(good)-1],
		"extended":  good + "A",
	} {
		if _, err := s.Resolve(ctx, token); err == nil {
			t.Errorf("%s token resolved but should not have", name)
		}
	}
}

func TestRevokeEndsTheSession(t *testing.T) {
	s := New(nil)
	ctx := context.Background()
	token, _ := s.Issue(ctx, "ravi@example.com")

	s.Revoke(ctx, token)
	if _, err := s.Resolve(ctx, token); err == nil {
		t.Fatal("a revoked token still resolves")
	}
}

// Two sign-ins must not collide, or one user could be handed another's session.
func TestTokensAreUnique(t *testing.T) {
	s := New(nil)
	ctx := context.Background()
	seen := make(map[string]bool)
	for i := 0; i < 200; i++ {
		token, _ := s.Issue(ctx, "ravi@example.com")
		if seen[token] {
			t.Fatal("Issue produced a duplicate token")
		}
		seen[token] = true
	}
}

// The raw token must never be what is stored — a dump of the store would otherwise be a list of
// live credentials.
func TestStoredFormIsNotTheToken(t *testing.T) {
	s := New(nil)
	ctx := context.Background()
	token, _ := s.Issue(ctx, "ravi@example.com")

	s.mem.mu.Lock()
	defer s.mem.mu.Unlock()
	for k := range s.mem.m {
		if k == token || k == "session:"+token {
			t.Fatal("the token itself is stored as the key")
		}
	}
}

func TestBearerToken(t *testing.T) {
	for header, want := range map[string]string{
		"Bearer abc123": "abc123",
		"bearer abc123": "abc123", // the scheme is case-insensitive
		"BEARER abc123": "abc123",
		"Bearer  abc  ": "abc",
		"abc123":        "", // no scheme
		"Basic abc123":  "", // wrong scheme
		"Bearer":        "",
		"":              "",
	} {
		if got := BearerToken(header); got != want {
			t.Errorf("BearerToken(%q) = %q, want %q", header, got, want)
		}
	}
}
