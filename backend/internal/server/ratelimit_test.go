package server

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prova/backend/internal/config"
	"github.com/prova/shared/schema"
)

// Every endpoint is unauthenticated, so these limits are the only thing between a script and the SMS
// bill or the code space. Tests run against the in-process fallback (no Redis) — which is exactly
// the path that must keep working when Redis is down, since failing open there is how budgets get
// drained without anyone noticing.

func rlHandler() http.Handler {
	return New(slog.Default(), config.Load(), Deps{})
}

// postFrom sends from a specific source address, so per-IP limits can be exercised independently.
func postFrom(t *testing.T, h http.Handler, ip, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.RemoteAddr = ip + ":12345"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// A code request must not be repeatable instantly: "resend" should not be a hammer, and the first
// code needs time to arrive.
func TestOTPRequestHasACooldown(t *testing.T) {
	h := rlHandler()
	body := `{"email":"cooldown@example.com"}`

	if rec := postFrom(t, h, "10.0.0.1", "/auth/otp/request", body); rec.Code != http.StatusOK {
		t.Fatalf("first request → %d, want 200", rec.Code)
	}

	rec := postFrom(t, h, "10.0.0.1", "/auth/otp/request", body)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("immediate repeat → %d, want 429", rec.Code)
	}
	// Clients need this to back off intelligently rather than retry blindly.
	if rec.Header().Get("Retry-After") == "" {
		t.Error("a 429 must carry Retry-After")
	}
	if code := decodeErr(t, rec).Code; code != schema.ErrRateLimited {
		t.Errorf("error code = %q, want %q", code, schema.ErrRateLimited)
	}
}

// Rotating IPs must not defeat the limit: the quota is keyed on the address being messaged, because
// that is what costs money and annoys a real person.
func TestOTPRequestIsLimitedPerIdentifierAcrossIPs(t *testing.T) {
	h := rlHandler()
	body := `{"email":"target@example.com"}`

	blocked := false
	for i := 0; i < 8; i++ {
		rec := postFrom(t, h, fmt.Sprintf("10.1.%d.%d", i, i), "/auth/otp/request", body)
		if rec.Code == http.StatusTooManyRequests {
			blocked = true
			break
		}
	}
	if !blocked {
		t.Fatal("one address must not be spammable by rotating source IPs")
	}
}

// Different users must not throttle each other.
func TestOTPRequestLimitIsPerIdentifier(t *testing.T) {
	h := rlHandler()

	if rec := postFrom(t, h, "10.2.0.1", "/auth/otp/request", `{"email":"a@example.com"}`); rec.Code != http.StatusOK {
		t.Fatalf("first identifier → %d", rec.Code)
	}
	// A second, different address from the same source should still pass: it has its own cooldown.
	if rec := postFrom(t, h, "10.2.0.1", "/auth/otp/request", `{"email":"b@example.com"}`); rec.Code != http.StatusOK {
		t.Fatalf("second identifier → %d, want 200", rec.Code)
	}
}

// A six-digit code is a million possibilities. Without a gap between guesses that is minutes of work.
func TestOTPVerifyThrottlesGuessing(t *testing.T) {
	h := rlHandler()
	body := `{"email":"guess@example.com","code":"111111"}`

	first := postFrom(t, h, "10.3.0.1", "/auth/otp/verify", body)
	if first.Code == http.StatusTooManyRequests {
		t.Fatal("the first attempt should not be throttled")
	}

	second := postFrom(t, h, "10.3.0.1", "/auth/otp/verify", body)
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("an immediate second guess → %d, want 429", second.Code)
	}
}

// Malformed input must be rejected before it consumes anyone's quota, or an attacker could exhaust a
// victim's allowance with junk and lock them out.
func TestInvalidInputDoesNotConsumeQuota(t *testing.T) {
	h := rlHandler()

	for i := 0; i < 5; i++ {
		rec := postFrom(t, h, "10.4.0.1", "/auth/otp/request", `{"email":"not-an-email"}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("malformed request %d → %d, want 400", i, rec.Code)
		}
	}
	// The valid address should still have its full allowance.
	if rec := postFrom(t, h, "10.4.0.1", "/auth/otp/request", `{"email":"fresh@example.com"}`); rec.Code != http.StatusOK {
		t.Fatalf("a valid request after junk → %d, want 200", rec.Code)
	}
}

// Load balancers poll these constantly; throttling a liveness probe is how a healthy service gets
// pulled out of rotation.
func TestHealthChecksAreExemptFromRateLimiting(t *testing.T) {
	h := rlHandler()
	for i := 0; i < 400; i++ {
		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		req.RemoteAddr = "10.5.0.1:1"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code == http.StatusTooManyRequests {
			t.Fatalf("health check throttled after %d probes", i)
		}
	}
}

// Well-behaved clients back off before being blocked, which they can only do if told their budget.
func TestResponsesAdvertiseTheRateLimit(t *testing.T) {
	h := rlHandler()
	req := httptest.NewRequest(http.MethodGet, "/countries", nil)
	req.RemoteAddr = "10.6.0.1:1"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	for _, header := range []string{"RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"} {
		if rec.Header().Get(header) == "" {
			t.Errorf("missing %s", header)
		}
	}
}

// Trusting X-Forwarded-For unconditionally is the standard way IP rate limiting is defeated: one
// header per request and every limit evaporates. It must be off unless explicitly enabled.
func TestForwardedHeadersAreIgnoredUnlessTrustIsEnabled(t *testing.T) {
	cfg := config.Load()
	if cfg.TrustProxyHeaders {
		t.Fatal("TRUST_PROXY_HEADERS must default to false")
	}

	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "203.0.113.9:5555"
	r.Header.Set("X-Forwarded-For", "1.2.3.4")

	if got := clientIP(r, false); got != "203.0.113.9" {
		t.Errorf("untrusted: got %q, want the real peer address", got)
	}
	if got := clientIP(r, true); got != "1.2.3.4" {
		t.Errorf("trusted: got %q, want the forwarded address", got)
	}
	// Multiple proxies: the left-most entry is the original client.
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 5.6.7.8")
	if got := clientIP(r, true); got != "1.2.3.4" {
		t.Errorf("chained: got %q, want the left-most entry", got)
	}
}
