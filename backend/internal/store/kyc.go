package store

// KYC verification persistence. PII-free by design (Docs/kyc-verification.md §3): the only user
// identifier stored is the opaque `userId` = Poseidon(secret, domain). Every state change is also
// written to an append-only audit log, because regulators require proof of why each decision was
// made and by whom.

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/prova/shared/schema"
)

// ErrVerificationNotFound is returned when no verification exists for a user or reference.
var ErrVerificationNotFound = errors.New("verification not found")

// Verification is a persisted KYC verification record (no PII, ever).
type Verification struct {
	ID          string
	UserID      string
	Status      schema.VerificationStatus
	Tier        int
	Expiry      int64
	ReasonCode  string
	ProviderRef string
	// Email is the account this submission belongs to, for the reviewer's benefit only.
	//
	// Empty for rows written before accounts existed, and by any client that does not send it.
	// Nothing about the decision depends on it — it is shown, never checked.
	Email     string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Audit event names (append-only log).
const (
	AuditSubmitted = "submitted"
	AuditVerdict   = "verdict"
	AuditDecided   = "decided"
	AuditIssued    = "issued"
	AuditExpired   = "expired"
	AuditRevoked   = "revoked"
)

// AuditEntry is one immutable row of the decision trail.
type AuditEntry struct {
	VerificationID string
	UserID         string
	Event          string
	FromStatus     schema.VerificationStatus
	ToStatus       schema.VerificationStatus
	Tier           int
	ReasonCode     string
	Actor          string
}

const verificationCols = `id, user_id, status, tier, expiry, reason_code, provider_ref, COALESCE(email, ''), created_at, updated_at`

// StartVerification creates (or replaces) the active verification for a user and returns it.
//
// A user has exactly one active verification: resubmitting overwrites the previous attempt's state
// while the audit log preserves every attempt. Callers must check `Retryable` before allowing a
// resubmit — a terminal rejection (e.g. sanctions) must never be retried.
func (s *Store) StartVerification(ctx context.Context, id, userID string, tier int, providerRef, email string) (*Verification, error) {
	row := s.pool.QueryRow(ctx, `
INSERT INTO kyc_verifications (id, user_id, status, tier, provider_ref, email)
VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''))
ON CONFLICT (user_id) DO UPDATE SET
    id = EXCLUDED.id,
    status = EXCLUDED.status,
    tier = EXCLUDED.tier,
    provider_ref = EXCLUDED.provider_ref,
    -- Keep whatever we already knew if this submission omits it, rather than blanking the reviewer's
    -- only handle on the person.
    email = COALESCE(EXCLUDED.email, kyc_verifications.email),
    expiry = 0,
    reason_code = '',
    updated_at = now()
RETURNING `+verificationCols,
		id, userID, schema.VerificationPending, tier, providerRef, email)
	return scanVerification(row)
}

// GetVerification fetches the active verification for a user.
func (s *Store) GetVerification(ctx context.Context, userID string) (*Verification, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+verificationCols+` FROM kyc_verifications WHERE user_id = $1`, userID)
	v, err := scanVerification(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrVerificationNotFound
	}
	return v, err
}

// GetVerificationByProviderRef fetches a verification by the provider's reference (webhook path).
func (s *Store) GetVerificationByProviderRef(ctx context.Context, ref string) (*Verification, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+verificationCols+` FROM kyc_verifications WHERE provider_ref = $1`, ref)
	v, err := scanVerification(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrVerificationNotFound
	}
	return v, err
}

// ListVerifications returns verifications for the compliance console, newest submission first.
//
// `status` empty means every status. The queue an operator actually works is `in_review`, but the
// console also needs to look back at what was decided — a review tool that can only show you the
// undecided items gives you no way to check your own past decisions.
func (s *Store) ListVerifications(ctx context.Context, status string, limit int) ([]Verification, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `SELECT `+verificationCols+`
FROM kyc_verifications
WHERE ($1 = '' OR status = $1)
ORDER BY updated_at DESC
LIMIT $2`, status, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Non-nil: an empty queue must marshal as [] rather than null.
	out := []Verification{}
	for rows.Next() {
		// Deliberately the shared scanner rather than an inline Scan. This used to list its columns
		// by hand, so adding one to `verificationCols` left the two out of step and every call
		// failed — the review queue returned 500 and the console said only "could not reach the
		// backend". One scanner means the column list cannot drift from the scan again.
		v, err := scanVerification(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *v)
	}
	return out, rows.Err()
}

// SetVerificationOutcome records a terminal or intermediate outcome for a verification.
//
// Guarded by `id` so a late/duplicate webhook for a superseded submission cannot overwrite a newer
// one, which combined with the caller's status check gives idempotent webhook handling.
func (s *Store) SetVerificationOutcome(
	ctx context.Context, id string, status schema.VerificationStatus, tier int, expiry int64, reasonCode string,
) (*Verification, error) {
	row := s.pool.QueryRow(ctx, `
UPDATE kyc_verifications
SET status = $2, tier = $3, expiry = $4, reason_code = $5, updated_at = now()
WHERE id = $1
RETURNING `+verificationCols,
		id, status, tier, expiry, reasonCode)
	v, err := scanVerification(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrVerificationNotFound
	}
	return v, err
}

// AppendAudit writes one immutable decision-trail entry. Never updated, never deleted.
func (s *Store) AppendAudit(ctx context.Context, e AuditEntry) error {
	_, err := s.pool.Exec(ctx, `
INSERT INTO kyc_audit_log (verification_id, user_id, event, from_status, to_status, tier, reason_code, actor)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		e.VerificationID, e.UserID, e.Event, e.FromStatus, e.ToStatus, e.Tier, e.ReasonCode, e.Actor)
	return err
}

func scanVerification(row scanner) (*Verification, error) {
	var v Verification
	if err := row.Scan(
		&v.ID, &v.UserID, &v.Status, &v.Tier, &v.Expiry, &v.ReasonCode, &v.ProviderRef, &v.Email,
		&v.CreatedAt, &v.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return &v, nil
}

// ToRecord maps to the shared API shape returned to the app.
func (v *Verification) ToRecord() schema.VerificationRecord {
	rec := schema.VerificationRecord{
		VerificationID: v.ID,
		Status:         v.Status,
		Tier:           v.Tier,
		Expiry:         v.Expiry,
		ReasonCode:     v.ReasonCode,
		CreatedAt:      v.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:      v.UpdatedAt.UTC().Format(time.RFC3339),
	}
	if v.Status == schema.VerificationRejected {
		rec.Retryable = schema.RetryableReason(v.ReasonCode)
	}
	return rec
}
