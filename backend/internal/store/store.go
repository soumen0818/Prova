// Package store persists transfer records in Postgres. It never stores amounts — only the
// commitment/nullifier references, status, and timestamps.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/prova/shared/schema"
)

// ErrNotFound is returned when a transfer id does not exist.
var ErrNotFound = errors.New("transfer not found")

// Transfer is a persisted transfer record (no amounts, ever).
type Transfer struct {
	ID         string
	Status     schema.TransferStatus
	Commitment string
	Nullifier  string
	TxHash     string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// Store is the Postgres-backed transfer store.
type Store struct {
	pool *pgxpool.Pool
}

// New connects a pool to the given Postgres URL.
func New(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.pool.Close() }

// Migrate creates the schema if it does not exist. The nullifier is UNIQUE, giving DB-level
// anti-replay/idempotency for the whole transfer lifecycle.
func (s *Store) Migrate(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS transfers (
    id          UUID PRIMARY KEY,
    status      TEXT NOT NULL,
    commitment  TEXT NOT NULL,
    nullifier   TEXT NOT NULL UNIQUE,
    tx_hash     TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transfers_commitment_idx ON transfers (commitment);`)
	return err
}

// Create inserts a new transfer in the given status. If the nullifier already exists it returns
// the existing record and false (idempotent submit).
func (s *Store) Create(ctx context.Context, id, commitment, nullifier string, status schema.TransferStatus) (*Transfer, bool, error) {
	row := s.pool.QueryRow(ctx, `
INSERT INTO transfers (id, status, commitment, nullifier)
VALUES ($1, $2, $3, $4)
ON CONFLICT (nullifier) DO NOTHING
RETURNING id, status, commitment, nullifier, tx_hash, created_at, updated_at`,
		id, status, commitment, nullifier)

	t, err := scan(row)
	if errors.Is(err, pgx.ErrNoRows) {
		// Conflict — a transfer with this nullifier already exists; return it.
		existing, gerr := s.GetByNullifier(ctx, nullifier)
		if gerr != nil {
			return nil, false, gerr
		}
		return existing, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return t, true, nil
}

// SetStatus updates status (and optionally tx hash) for a transfer.
func (s *Store) SetStatus(ctx context.Context, id string, status schema.TransferStatus, txHash string) error {
	_, err := s.pool.Exec(ctx, `
UPDATE transfers SET status = $2, tx_hash = COALESCE(NULLIF($3, ''), tx_hash), updated_at = now()
WHERE id = $1`, id, status, txHash)
	return err
}

// Get fetches a transfer by id.
func (s *Store) Get(ctx context.Context, id string) (*Transfer, error) {
	row := s.pool.QueryRow(ctx, `
SELECT id, status, commitment, nullifier, tx_hash, created_at, updated_at FROM transfers WHERE id = $1`, id)
	t, err := scan(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return t, err
}

// GetByNullifier fetches a transfer by nullifier.
func (s *Store) GetByNullifier(ctx context.Context, nullifier string) (*Transfer, error) {
	row := s.pool.QueryRow(ctx, `
SELECT id, status, commitment, nullifier, tx_hash, created_at, updated_at FROM transfers WHERE nullifier = $1`, nullifier)
	t, err := scan(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return t, err
}

type scanner interface {
	Scan(dest ...any) error
}

func scan(row scanner) (*Transfer, error) {
	var t Transfer
	if err := row.Scan(&t.ID, &t.Status, &t.Commitment, &t.Nullifier, &t.TxHash, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return nil, err
	}
	return &t, nil
}

// ToRecord maps to the shared API record shape.
func (t *Transfer) ToRecord() schema.TransferRecord {
	return schema.TransferRecord{
		TransferID: t.ID,
		Status:     t.Status,
		Commitment: t.Commitment,
		Nullifier:  t.Nullifier,
		CreatedAt:  t.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:  t.UpdatedAt.UTC().Format(time.RFC3339),
		TxHash:     t.TxHash,
	}
}
