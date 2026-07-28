package kyc

import (
	"encoding/json"
	"testing"

	"github.com/prova/shared/schema"
)

// The mock must be deterministic per wallet so a given test user always takes the same path.
func TestMockDecisionIsDeterministicPerUser(t *testing.T) {
	m := NewMockProvider(0)
	for _, tc := range []struct {
		userID string
		want   Decision
	}{
		{"aaaa0", DecisionReview},
		{"aaaa1", DecisionRejected},
		{"aaaa2", DecisionApproved},
		{"beef", DecisionApproved},
	} {
		if got := m.decisionFor(tc.userID); got != tc.want {
			t.Errorf("decisionFor(%q) = %q, want %q", tc.userID, got, tc.want)
		}
		if again := m.decisionFor(tc.userID); again != tc.want {
			t.Errorf("decisionFor(%q) not deterministic", tc.userID)
		}
	}
}

func TestMockForceDecisionOverrides(t *testing.T) {
	m := NewMockProvider(0)
	m.ForceDecision = DecisionRejected
	if got := m.decisionFor("aaaa2"); got != DecisionRejected {
		t.Errorf("ForceDecision ignored: got %q", got)
	}
}

// A verdict payload must be rejected unless it is well-formed — a malformed webhook must never be
// coerced into an approval.
func TestParseRejectsBadPayloads(t *testing.T) {
	m := NewMockProvider(0)
	for _, payload := range []string{
		`not json`,
		`{"decision":"approved"}`, // missing providerRef
		`{"providerRef":"r","decision":"yes-please"}`, // unknown decision
		`{"providerRef":"r"}`,                         // missing decision
	} {
		if _, err := m.Parse([]byte(payload)); err == nil {
			t.Errorf("Parse(%q) succeeded, want error", payload)
		}
	}
}

func TestParseAcceptsValidVerdict(t *testing.T) {
	m := NewMockProvider(0)
	body, _ := json.Marshal(schema.ProviderVerdict{
		ProviderRef: "mock_abc",
		Decision:    "approved",
		Tier:        schema.TierStandard,
	})
	v, err := m.Parse(body)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if v.Decision != DecisionApproved || v.ProviderRef != "mock_abc" || v.Tier != schema.TierStandard {
		t.Errorf("unexpected verdict: %+v", v)
	}
}

// Terminal rejection reasons must never be retryable — a sanctioned identity cannot resubmit.
func TestTerminalReasonsAreNotRetryable(t *testing.T) {
	terminal := []string{
		schema.ReasonSanctionsHit,
		schema.ReasonDuplicateIdentity,
		schema.ReasonUnderage,
		schema.ReasonDocumentTampered,
	}
	for _, code := range terminal {
		if schema.RetryableReason(code) {
			t.Errorf("reason %q must not be retryable", code)
		}
	}
	retryable := []string{
		schema.ReasonDocumentUnreadable,
		schema.ReasonFaceMismatch,
		schema.ReasonLivenessFailed,
		schema.ReasonManualReview,
	}
	for _, code := range retryable {
		if !schema.RetryableReason(code) {
			t.Errorf("reason %q should be retryable", code)
		}
	}
}

// Tier limits must be monotonic and zero for an unverified user.
func TestTierLimits(t *testing.T) {
	if schema.TierLimit(0) != 0 {
		t.Error("unverified users must have no limit allowance")
	}
	if schema.TierLimit(schema.TierBasic) >= schema.TierLimit(schema.TierStandard) {
		t.Error("basic tier must be more restricted than standard")
	}
}
