package kyc

// The KYC verification state machine (Docs/kyc-verification.md §4–§7).
//
// Responsibilities:
//   - drive submissions through pending → in_review → approved/rejected/expired
//   - write every transition to the append-only audit log
//   - GATE credential issuance on a stored `approved` record — never on the caller's request
//   - keep credentials short-lived (90d) and renewable, since an on-phone credential cannot be
//     revoked remotely
//
// It never sees personal data: only the opaque userId.

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/prova/backend/internal/store"
	"github.com/prova/shared/schema"
)

// newUUID returns a random RFC 4122 v4 UUID for verification ids.
func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Errors the handlers translate into API responses.
var (
	// ErrNotApproved means no approved verification exists — credential issuance is refused.
	ErrNotApproved = errors.New("verification not approved")
	// ErrNotRetryable means the previous rejection is terminal (e.g. sanctions) — no resubmission.
	ErrNotRetryable = errors.New("verification cannot be retried")
	// ErrNotFound means the user has no verification record.
	ErrNotFound = errors.New("verification not found")
)

// Service runs the verification lifecycle.
type Service struct {
	store    *store.Store
	provider Provider
	issuer   Issuer
	logger   *slog.Logger
	now      func() time.Time
}

// NewService wires the state machine. `issuer` signs credentials (the anchor's key).
func NewService(st *store.Store, p Provider, issuer Issuer, logger *slog.Logger) *Service {
	return &Service{store: st, provider: p, issuer: issuer, logger: logger, now: time.Now}
}

// Start begins (or restarts) a verification for a wallet.
//
// Refuses to restart when the previous rejection was terminal, so a sanctioned or duplicate identity
// cannot simply resubmit.
func (s *Service) Start(ctx context.Context, userID string, tier int) (*store.Verification, error) {
	if tier < schema.TierBasic {
		tier = schema.TierStandard
	}
	if prev, err := s.store.GetVerification(ctx, userID); err == nil {
		if prev.Status == schema.VerificationRejected && !schema.RetryableReason(prev.ReasonCode) {
			return nil, ErrNotRetryable
		}
	} else if !errors.Is(err, store.ErrVerificationNotFound) {
		return nil, err
	}

	ref, err := s.provider.Start(ctx, userID, tier)
	if err != nil {
		return nil, fmt.Errorf("provider start: %w", err)
	}

	v, err := s.store.StartVerification(ctx, newUUID(), userID, tier, ref)
	if err != nil {
		return nil, err
	}
	s.audit(ctx, store.AuditEntry{
		VerificationID: v.ID, UserID: userID, Event: store.AuditSubmitted,
		ToStatus: schema.VerificationPending, Tier: tier, Actor: "provider:" + s.provider.Name(),
	})
	return v, nil
}

// Get returns the current verification, applying lazy expiry so a lapsed credential reads as
// `expired` even if nothing has touched the record since.
func (s *Service) Get(ctx context.Context, userID string) (*store.Verification, error) {
	v, err := s.store.GetVerification(ctx, userID)
	if errors.Is(err, store.ErrVerificationNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if v.Status == schema.VerificationApproved && v.Expiry > 0 && s.now().Unix() >= v.Expiry {
		expired, uerr := s.store.SetVerificationOutcome(
			ctx, v.ID, schema.VerificationExpired, v.Tier, v.Expiry, "")
		if uerr != nil {
			return v, nil // report the stale record rather than fail the read
		}
		s.audit(ctx, store.AuditEntry{
			VerificationID: v.ID, UserID: userID, Event: store.AuditExpired,
			FromStatus: schema.VerificationApproved, ToStatus: schema.VerificationExpired,
			Tier: v.Tier, Actor: "system",
		})
		return expired, nil
	}
	return v, nil
}

// ApplyVerdict records a provider outcome. Idempotent: a replayed or late webhook for an already
// settled (or superseded) submission is ignored rather than re-applied.
func (s *Service) ApplyVerdict(ctx context.Context, v Verdict) error {
	rec, err := s.store.GetVerificationByProviderRef(ctx, v.ProviderRef)
	if errors.Is(err, store.ErrVerificationNotFound) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	// Only a submission still awaiting an outcome may be settled by a verdict.
	if rec.Status != schema.VerificationPending && rec.Status != schema.VerificationInReview {
		s.logger.Info("ignoring verdict for settled verification",
			"verificationId", rec.ID, "status", rec.Status)
		return nil
	}

	status, expiry, tier := s.outcome(v, rec.Tier)
	updated, err := s.store.SetVerificationOutcome(ctx, rec.ID, status, tier, expiry, v.ReasonCode)
	if err != nil {
		return err
	}
	s.audit(ctx, store.AuditEntry{
		VerificationID: updated.ID, UserID: updated.UserID, Event: store.AuditVerdict,
		FromStatus: rec.Status, ToStatus: status, Tier: tier, ReasonCode: v.ReasonCode,
		Actor: "provider:" + s.provider.Name(),
	})
	return nil
}

// Decide records a human compliance decision on a review-queue item.
func (s *Service) Decide(ctx context.Context, userID string, approve bool, reasonCode, reviewer string) (*store.Verification, error) {
	rec, err := s.store.GetVerification(ctx, userID)
	if errors.Is(err, store.ErrVerificationNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	status := schema.VerificationRejected
	var expiry int64
	if approve {
		status = schema.VerificationApproved
		expiry = s.credentialExpiry()
		reasonCode = ""
	}
	updated, err := s.store.SetVerificationOutcome(ctx, rec.ID, status, rec.Tier, expiry, reasonCode)
	if err != nil {
		return nil, err
	}
	if reviewer == "" {
		reviewer = "compliance"
	}
	s.audit(ctx, store.AuditEntry{
		VerificationID: updated.ID, UserID: userID, Event: store.AuditDecided,
		FromStatus: rec.Status, ToStatus: status, Tier: rec.Tier, ReasonCode: reasonCode, Actor: reviewer,
	})
	return updated, nil
}

// IssueCredential signs a credential — but ONLY against a stored `approved` record.
//
// This is the gate that closes the "anyone who calls the endpoint gets a credential" hole: the
// caller cannot assert its own approval, and the level/expiry come from the record, never the
// request.
func (s *Service) IssueCredential(ctx context.Context, userID string) (schema.KycCredential, error) {
	v, err := s.Get(ctx, userID)
	if err != nil {
		return schema.KycCredential{}, err
	}
	if v.Status != schema.VerificationApproved {
		return schema.KycCredential{}, ErrNotApproved
	}

	// Renew the window on issue so the app's silent pre-expiry renewal re-arms the credential.
	expiry := v.Expiry
	if expiry <= s.now().Unix() {
		expiry = s.credentialExpiry()
		if _, uerr := s.store.SetVerificationOutcome(
			ctx, v.ID, schema.VerificationApproved, v.Tier, expiry, ""); uerr != nil {
			return schema.KycCredential{}, uerr
		}
	}

	cred, err := s.issuer.Issue(ctx, userID, v.Tier, expiry)
	if err != nil {
		return schema.KycCredential{}, err
	}
	s.audit(ctx, store.AuditEntry{
		VerificationID: v.ID, UserID: userID, Event: store.AuditIssued,
		FromStatus: v.Status, ToStatus: v.Status, Tier: v.Tier, Actor: "system",
	})
	return cred, nil
}

// Renew re-screens and re-issues before expiry. Re-screening at renewal is what bounds sanctions
// exposure to the credential window (an on-phone credential cannot be revoked remotely).
func (s *Service) Renew(ctx context.Context, userID string) (schema.KycCredential, error) {
	v, err := s.Get(ctx, userID)
	if err != nil {
		return schema.KycCredential{}, err
	}
	if v.Status != schema.VerificationApproved {
		return schema.KycCredential{}, ErrNotApproved
	}
	expiry := s.credentialExpiry()
	if _, err := s.store.SetVerificationOutcome(
		ctx, v.ID, schema.VerificationApproved, v.Tier, expiry, ""); err != nil {
		return schema.KycCredential{}, err
	}
	cred, err := s.issuer.Issue(ctx, userID, v.Tier, expiry)
	if err != nil {
		return schema.KycCredential{}, err
	}
	s.audit(ctx, store.AuditEntry{
		VerificationID: v.ID, UserID: userID, Event: store.AuditIssued,
		FromStatus: v.Status, ToStatus: v.Status, Tier: v.Tier, Actor: "system:renew",
	})
	return cred, nil
}

// outcome maps a provider decision onto our state machine.
func (s *Service) outcome(v Verdict, currentTier int) (schema.VerificationStatus, int64, int) {
	tier := v.Tier
	if tier < schema.TierBasic {
		tier = currentTier
	}
	switch v.Decision {
	case DecisionApproved:
		return schema.VerificationApproved, s.credentialExpiry(), tier
	case DecisionReview:
		return schema.VerificationInReview, 0, tier
	default:
		return schema.VerificationRejected, 0, tier
	}
}

func (s *Service) credentialExpiry() int64 {
	return s.now().Add(time.Duration(schema.CredentialTTLDays) * 24 * time.Hour).Unix()
}

// audit never fails the caller — a lost audit row must not break a user's verification, but it is
// logged loudly because the trail is a regulatory requirement.
func (s *Service) audit(ctx context.Context, e store.AuditEntry) {
	if err := s.store.AppendAudit(ctx, e); err != nil {
		s.logger.Error("kyc audit write failed", "verificationId", e.VerificationID, "event", e.Event, "err", err)
	}
}
