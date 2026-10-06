package kyc

import (
	"context"
	"errors"
	"testing"
)

func TestDemoCredentialCannotRenewWithoutReview(t *testing.T) {
	// Even a service with no store or issuer must reject renewal before it can
	// reach a signer. A new request and operator decision are required instead.
	var service Service
	credential, err := service.Renew(context.Background(), "test-user")
	if !errors.Is(err, ErrReviewRequired) {
		t.Fatalf("expected review-required error, got %v", err)
	}
	if credential.Expiry != 0 {
		t.Fatalf("renewal returned a credential with expiry %d", credential.Expiry)
	}
}
