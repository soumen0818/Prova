package main

import (
	"testing"
	"time"

	"github.com/prova/backend/internal/kyc"
)

func TestDemoProviderCannotAutoApprove(t *testing.T) {
	provider := newDemoProvider(time.Second)
	if provider.ForceDecision != kyc.DecisionReview {
		t.Fatalf("mock provider must require an operator decision, got %q", provider.ForceDecision)
	}
}
