package kyc

// Verification providers — the seam between Prova and whoever actually checks identity.
//
// Stage A ships `MockProvider`. Stage C swaps in a vendor sandbox (Sumsub/Onfido/Persona) and
// Phase 5 the licensed anchor's own flow, without touching the service or handlers.
// See Docs/kyc-verification.md §8.
//
// NOTE the shape of this interface: **no personal data crosses it**. Documents and PII travel
// directly from the device to the provider; Prova only starts a session and later receives a
// verdict. That is what keeps the backend PII-free by construction, not by policy.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/prova/shared/schema"
)

// Decision is a provider's outcome for one verification.
type Decision string

const (
	DecisionApproved Decision = "approved"
	DecisionRejected Decision = "rejected"
	DecisionReview   Decision = "review" // escalate to a human compliance officer
)

// Verdict is a provider's result, normalised.
type Verdict struct {
	ProviderRef string
	Decision    Decision
	Tier        int
	ReasonCode  string
}

// Provider performs (or brokers) the identity check.
type Provider interface {
	// Name identifies the provider in the audit trail.
	Name() string
	// Start opens a verification session and returns the provider's reference. No PII is passed.
	Start(ctx context.Context, userID string, tier int) (providerRef string, err error)
	// Parse normalises a provider webhook payload into a Verdict.
	Parse(payload []byte) (Verdict, error)
}

// VerdictSink receives verdicts a provider produces asynchronously (the mock's internal timer).
type VerdictSink func(ctx context.Context, v Verdict)

// MockProvider simulates the real pipeline so every path is testable without a vendor account.
//
// It models the three-way decision from Docs/kyc-verification.md §5: most submissions auto-approve
// after a short delay, some escalate to review, some hard-fail. Which outcome a submission gets is
// **deterministic** per userID (so a given test wallet always behaves the same), and can be forced
// outright via ForceDecision for scripted testing.
type MockProvider struct {
	// Delay before the simulated automated checks return (real vendors take seconds to minutes).
	Delay time.Duration
	// ForceDecision, when set, overrides the deterministic outcome (dev/testing).
	ForceDecision Decision
	// OnVerdict is invoked when the simulated checks complete.
	OnVerdict VerdictSink

	mu      sync.Mutex
	pending map[string]string // providerRef -> userID
}

// NewMockProvider builds a mock provider with a sensible simulated latency.
func NewMockProvider(delay time.Duration) *MockProvider {
	if delay <= 0 {
		delay = 4 * time.Second
	}
	return &MockProvider{Delay: delay, pending: map[string]string{}}
}

// Name implements Provider.
func (m *MockProvider) Name() string { return "mock" }

// Start registers a simulated session and schedules its verdict.
func (m *MockProvider) Start(ctx context.Context, userID string, tier int) (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("provider ref: %w", err)
	}
	ref := "mock_" + hex.EncodeToString(b[:])

	m.mu.Lock()
	m.pending[ref] = userID
	m.mu.Unlock()

	verdict := Verdict{ProviderRef: ref, Decision: m.decisionFor(userID), Tier: tier}
	switch verdict.Decision {
	case DecisionReview:
		verdict.ReasonCode = schema.ReasonManualReview
	case DecisionRejected:
		verdict.ReasonCode = schema.ReasonFaceMismatch
	}

	// Simulate asynchronous provider checks. Detached from the request context on purpose: the
	// verdict must still land if the caller's HTTP request has already returned.
	if m.OnVerdict != nil {
		go func() {
			time.Sleep(m.Delay)
			bg, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			m.OnVerdict(bg, verdict)
		}()
	}
	return ref, nil
}

// Parse implements Provider for webhook payloads (used when a real provider posts to us).
func (m *MockProvider) Parse(payload []byte) (Verdict, error) {
	var pv schema.ProviderVerdict
	if err := json.Unmarshal(payload, &pv); err != nil {
		return Verdict{}, fmt.Errorf("decode verdict: %w", err)
	}
	if pv.ProviderRef == "" {
		return Verdict{}, fmt.Errorf("providerRef is required")
	}
	switch Decision(pv.Decision) {
	case DecisionApproved, DecisionRejected, DecisionReview:
	default:
		return Verdict{}, fmt.Errorf("unknown decision %q", pv.Decision)
	}
	return Verdict{
		ProviderRef: pv.ProviderRef,
		Decision:    Decision(pv.Decision),
		Tier:        pv.Tier,
		ReasonCode:  pv.ReasonCode,
	}, nil
}

// decisionFor picks a deterministic outcome so a given wallet always behaves the same way in tests.
// Roughly mirrors production rates: most approve, a few review, rarely a hard fail.
func (m *MockProvider) decisionFor(userID string) Decision {
	if m.ForceDecision != "" {
		return m.ForceDecision
	}
	if userID == "" {
		return DecisionReview
	}
	switch userID[len(userID)-1] {
	case '0':
		return DecisionReview // ~6% → exercises the human-review queue
	case '1':
		return DecisionRejected // ~6% → exercises the rejection/resubmit path
	default:
		return DecisionApproved
	}
}
