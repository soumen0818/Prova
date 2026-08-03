package server

import (
	"log/slog"
	"testing"

	"github.com/prova/backend/internal/config"
)

// The manual KYC decision endpoint must not be reachable without the configured bearer token —
// see decideVerification's doc comment. This guards against that check silently regressing.
func TestValidComplianceToken(t *testing.T) {
	cfg := config.Config{ComplianceToken: "s3cret"}
	h := &handler{logger: slog.Default(), cfg: cfg}

	cases := []struct {
		name   string
		header string
		want   bool
	}{
		{"correct token", "Bearer s3cret", true},
		{"wrong token", "Bearer nope", false},
		{"missing Bearer prefix", "s3cret", false},
		{"empty header", "", false},
		{"wrong scheme", "Basic s3cret", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := h.validComplianceToken(tc.header); got != tc.want {
				t.Errorf("validComplianceToken(%q) = %v, want %v", tc.header, got, tc.want)
			}
		})
	}
}

// Empty ComplianceToken means "no token configured" — dev-only, and must never be the case when a
// real token IS set but the header is merely missing (that must still fail closed).
func TestValidComplianceTokenSkippedWhenUnset(t *testing.T) {
	h := &handler{logger: slog.Default(), cfg: config.Config{ComplianceToken: ""}}
	if !h.validComplianceToken("") {
		t.Error("expected the check to be skipped when ComplianceToken is unset (dev mode)")
	}
}
