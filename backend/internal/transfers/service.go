// Package transfers is the Phase 2 relay service: it accepts a proof from a client, persists a
// transfer record, submits it to the verifier contract, and tracks the lifecycle. It never sees
// or stores amounts.
package transfers

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/prova/backend/internal/chain"
	"github.com/prova/backend/internal/store"
	"github.com/prova/shared/schema"
)

// ErrInvalidRequest is returned when the submitted proof is missing required fields.
var ErrInvalidRequest = errors.New("invalid transfer request")

// Service relays transfers to the contract and tracks their status.
type Service struct {
	store     *store.Store
	submitter chain.Submitter
	redis     *redis.Client
	logger    *slog.Logger
}

// New builds the transfer service.
func New(st *store.Store, sub chain.Submitter, rdb *redis.Client, logger *slog.Logger) *Service {
	return &Service{store: st, submitter: sub, redis: rdb, logger: logger}
}

// Submit accepts a proof, records it, and relays it to the contract. It is idempotent by nullifier:
// resubmitting the same transfer returns the existing record rather than double-spending.
func (s *Service) Submit(ctx context.Context, req schema.SubmitTransferRequest) (schema.SubmitTransferResponse, error) {
	p := req.TransferProof
	commitment := p.PublicSignals.Commitment
	nullifier := p.PublicSignals.Nullifier
	if p.Proof.A == "" || p.Proof.B == "" || p.Proof.C == "" || commitment == "" || nullifier == "" {
		return schema.SubmitTransferResponse{}, ErrInvalidRequest
	}

	// Redis idempotency lock — stops two concurrent submits of the same nullifier from both
	// hitting the chain. The DB UNIQUE(nullifier) is the durable backstop.
	lockKey := "prova:submit:" + nullifier
	if s.redis != nil {
		locked, err := s.redis.SetNX(ctx, lockKey, "1", 60*time.Second).Result()
		if err == nil && !locked {
			// Another submit is in flight (or already done) — return current state.
			if existing, gerr := s.store.GetByNullifier(ctx, nullifier); gerr == nil {
				return respFromTransfer(existing), nil
			}
		}
		defer s.redis.Del(context.Background(), lockKey)
	}

	id := newUUID()
	rec, created, err := s.store.Create(ctx, id, commitment, nullifier, schema.StatusPending)
	if err != nil {
		return schema.SubmitTransferResponse{}, fmt.Errorf("persist transfer: %w", err)
	}
	if !created {
		// Idempotent: a transfer with this nullifier already exists.
		return respFromTransfer(rec), nil
	}

	// Relay to the contract, tracking the lifecycle.
	_ = s.store.SetStatus(ctx, id, schema.StatusSubmitting, "")
	txHash, serr := s.submitWithRetry(ctx, chain.Proof{
		A: p.Proof.A, B: p.Proof.B, C: p.Proof.C, Commitment: commitment, Nullifier: nullifier,
	})

	var status schema.TransferStatus
	switch {
	case serr == nil:
		status = schema.StatusConfirmed
	case errors.Is(serr, chain.ErrReplay), errors.Is(serr, chain.ErrInvalidProof):
		status = schema.StatusRejected
		s.logger.Warn("transfer rejected by contract", "id", id, "err", serr)
	default:
		status = schema.StatusFailed
		s.logger.Error("transfer submission failed", "id", id, "err", serr)
	}
	if uerr := s.store.SetStatus(ctx, id, status, txHash); uerr != nil {
		s.logger.Error("status update failed", "id", id, "err", uerr)
	}

	rec.Status = status
	rec.TxHash = txHash
	return respFromTransfer(rec), nil
}

// Get returns the current record for a transfer id.
func (s *Service) Get(ctx context.Context, id string) (schema.TransferRecord, error) {
	t, err := s.store.Get(ctx, id)
	if err != nil {
		return schema.TransferRecord{}, err
	}
	return t.ToRecord(), nil
}

// submitWithRetry retries only on transient (untyped) errors; contract rejections are final.
func (s *Service) submitWithRetry(ctx context.Context, p chain.Proof) (string, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		txHash, err := s.submitter.Submit(ctx, p)
		if err == nil {
			return txHash, nil
		}
		if errors.Is(err, chain.ErrReplay) || errors.Is(err, chain.ErrInvalidProof) {
			return "", err // final — don't retry
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(time.Duration(attempt+1) * time.Second):
		}
	}
	return "", lastErr
}

func respFromTransfer(t *store.Transfer) schema.SubmitTransferResponse {
	return schema.SubmitTransferResponse{TransferID: t.ID, Status: t.Status, TxHash: t.TxHash}
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
