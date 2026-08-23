// Package store persists transfer records in Postgres. It never stores amounts — only the
// commitment/nullifier references, status, and timestamps.
package store

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/prova/backend/migrations"
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
//
// simpleProtocol disables prepared statements (pgx "simple protocol"). Set it when connecting
// through a transaction-mode connection pooler that doesn't support prepared statements — notably
// Supabase's pooled (pgBouncer) endpoint. Direct/session connections don't need it.
func New(ctx context.Context, databaseURL string, simpleProtocol bool) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	if simpleProtocol {
		cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
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

// Ping checks the Postgres connection is alive — used by the readiness probe.
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

/*
 * migrationLock is an arbitrary constant identifying the advisory lock migrations serialise on.
 *
 * Any int64 works as long as nothing else in this database picks the same one; advisory locks share
 * a single namespace per database.
 */
const migrationLock int64 = 0x50524f5641 // "PROVA"

// Migrate applies the embedded SQL migrations (backend/migrations/*.sql) in filename order. Each
// file is idempotent (IF NOT EXISTS), so re-running on every boot is safe. These are the same files
// you can run by hand against a managed database (e.g. Supabase).
//
// ---------------------------------------------------------------------------
// WHY THE LOCK
// ---------------------------------------------------------------------------
// `api` and `indexer` are separate containers that boot together, and both migrate. "IF NOT EXISTS"
// is not a substitute for serialising them: two sessions running CREATE TABLE IF NOT EXISTS at the
// same instant both find nothing, both create, and the loser fails with a duplicate-key error on
// pg_type. That failure is not cosmetic — main.go leaves the store nil when Migrate returns an
// error, and an indexer with no store starts no folder. Deposits then sit at "confirming" forever
// while the API looks perfectly healthy, because the API happened to win the race.
//
// pg_advisory_lock makes the second container wait rather than collide. It is released when the
// connection is returned, so a crash mid-migration cannot leave it held.
func (s *Store) Migrate(ctx context.Context) error {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	// One connection for the whole run: an advisory lock belongs to the session that took it, so
	// taking it on one pooled connection and migrating on another would protect nothing.
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationLock); err != nil {
		return fmt.Errorf("take migration lock: %w", err)
	}
	// Explicit unlock so the lock goes back immediately rather than whenever the pooled connection
	// happens to be recycled. Releasing the connection would also drop it.
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, migrationLock)
	}()

	for _, name := range names {
		sqlBytes, rerr := migrations.FS.ReadFile(name)
		if rerr != nil {
			return fmt.Errorf("read migration %s: %w", name, rerr)
		}
		if _, eerr := conn.Exec(ctx, string(sqlBytes)); eerr != nil {
			return fmt.Errorf("apply migration %s: %w", name, eerr)
		}
	}
	return nil
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

// UpsertConfirmed records a transfer seen on-chain by the indexer. If the nullifier is new
// (e.g. a transfer not relayed by this backend) it inserts a confirmed row; otherwise it fills the
// tx hash and promotes an in-flight status to confirmed.
func (s *Store) UpsertConfirmed(ctx context.Context, commitment, nullifier, txHash string) error {
	_, err := s.pool.Exec(ctx, `
INSERT INTO transfers (id, status, commitment, nullifier, tx_hash)
VALUES (gen_random_uuid(), 'confirmed', $1, $2, $3)
ON CONFLICT (nullifier) DO UPDATE SET
    tx_hash = COALESCE(NULLIF(EXCLUDED.tx_hash, ''), transfers.tx_hash),
    status = CASE WHEN transfers.status IN ('pending','submitting','submitted')
                  THEN 'confirmed' ELSE transfers.status END,
    updated_at = now()`,
		commitment, nullifier, txHash)
	return err
}

// List returns the most recent transfers (history).
func (s *Store) List(ctx context.Context, limit int) ([]Transfer, error) {
	rows, err := s.pool.Query(ctx, `
SELECT id, status, commitment, nullifier, tx_hash, created_at, updated_at
FROM transfers ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Transfer
	for rows.Next() {
		t, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
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
