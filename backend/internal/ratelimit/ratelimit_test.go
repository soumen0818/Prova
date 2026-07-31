package ratelimit

import (
	"context"
	"testing"
	"time"
)

// Runs against the in-process fallback (nil Redis), which is exactly the path that must work when
// Redis is down — the case where failing open would quietly drain an SMS budget.

func TestQuotaAllowsUpToTheLimitThenBlocks(t *testing.T) {
	l := New(nil)
	ctx := context.Background()
	rule := Rule{Limit: 3, Window: time.Minute}

	for i := 1; i <= 3; i++ {
		d := l.Allow(ctx, "user@example.com", rule)
		if !d.Allowed {
			t.Fatalf("request %d should be allowed", i)
		}
		if want := 3 - i; d.Remaining != want {
			t.Errorf("request %d: remaining = %d, want %d", i, d.Remaining, want)
		}
	}

	d := l.Allow(ctx, "user@example.com", rule)
	if d.Allowed {
		t.Fatal("the 4th request must be blocked")
	}
	if d.Remaining != 0 {
		t.Errorf("remaining = %d, want 0", d.Remaining)
	}
	// Clients need this to back off intelligently rather than hammer.
	if d.RetryAfter <= 0 {
		t.Error("a blocked request must report how long to wait")
	}
}

// Keys are independent, or one busy user would lock out everyone else.
func TestQuotaIsPerKey(t *testing.T) {
	l := New(nil)
	ctx := context.Background()
	rule := Rule{Limit: 1, Window: time.Minute}

	if !l.Allow(ctx, "a@example.com", rule).Allowed {
		t.Fatal("first key should be allowed")
	}
	if l.Allow(ctx, "a@example.com", rule).Allowed {
		t.Fatal("first key should now be blocked")
	}
	if !l.Allow(ctx, "b@example.com", rule).Allowed {
		t.Fatal("a different key must be unaffected")
	}
}

func TestQuotaResetsAfterTheWindow(t *testing.T) {
	l := New(nil)
	ctx := context.Background()
	rule := Rule{Limit: 1, Window: 40 * time.Millisecond}

	if !l.Allow(ctx, "k", rule).Allowed {
		t.Fatal("first request should be allowed")
	}
	if l.Allow(ctx, "k", rule).Allowed {
		t.Fatal("second request should be blocked")
	}

	time.Sleep(60 * time.Millisecond)
	if !l.Allow(ctx, "k", rule).Allowed {
		t.Fatal("the window should have reset")
	}
}

// The cooldown is what actually makes guessing a six-digit code impractical: a quota alone still
// permits its whole allowance back-to-back.
func TestCooldownBlocksRapidRepeats(t *testing.T) {
	l := New(nil)
	ctx := context.Background()

	if wait := l.Cooldown(ctx, "user@example.com", 50*time.Millisecond); wait != 0 {
		t.Fatalf("first attempt should pass, got wait %v", wait)
	}
	wait := l.Cooldown(ctx, "user@example.com", 50*time.Millisecond)
	if wait <= 0 {
		t.Fatal("an immediate repeat must be told to wait")
	}
	if wait > 50*time.Millisecond {
		t.Errorf("wait %v exceeds the interval", wait)
	}

	time.Sleep(70 * time.Millisecond)
	if wait := l.Cooldown(ctx, "user@example.com", 50*time.Millisecond); wait != 0 {
		t.Fatalf("should pass after the interval, got %v", wait)
	}
}

func TestCooldownIsPerKey(t *testing.T) {
	l := New(nil)
	ctx := context.Background()

	_ = l.Cooldown(ctx, "a", time.Minute)
	if wait := l.Cooldown(ctx, "b", time.Minute); wait != 0 {
		t.Fatal("a different key must have its own cooldown")
	}
}

// A long-lived process must not accumulate one entry per address it has ever seen — that is a slow
// leak an attacker could drive on purpose.
func TestExpiredEntriesAreCollected(t *testing.T) {
	l := New(nil)
	ctx := context.Background()
	rule := Rule{Limit: 1, Window: time.Millisecond}

	for i := 0; i < 100; i++ {
		l.Allow(ctx, string(rune(i))+"@example.com", rule)
	}
	l.mem.mu.Lock()
	before := len(l.mem.items)
	// Force the next gc to run rather than waiting a minute.
	l.mem.lastGC = time.Now().Add(-2 * time.Minute)
	l.mem.mu.Unlock()

	time.Sleep(10 * time.Millisecond)
	l.Allow(ctx, "trigger@example.com", rule)

	l.mem.mu.Lock()
	after := len(l.mem.items)
	l.mem.mu.Unlock()

	if after >= before {
		t.Errorf("expired entries were not collected: %d → %d", before, after)
	}
}
