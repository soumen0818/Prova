package store

import (
	"testing"
	"time"

	"github.com/prova/shared/schema"
)

func TestVerificationRecordLabelsDemoMode(t *testing.T) {
	now := time.Now()
	record := (&Verification{
		ID: "verification-1", Status: schema.VerificationInReview,
		Tier: schema.TierStandard, CreatedAt: now, UpdatedAt: now,
	}).ToRecord()
	if record.Mode != schema.VerificationModeDemo {
		t.Fatalf("expected demo mode, got %q", record.Mode)
	}
}
