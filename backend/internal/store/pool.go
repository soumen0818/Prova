package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Pool-state accessors for the shielded pool (Docs/shielded-pool.md §10.7).
//
// The contract holds only a Merkle root — it cannot hash, so it cannot hold the tree. This is the
// off-chain mirror a wallet needs in order to spend at all: no membership path, no spend proof.
// That makes it load-bearing rather than an analytics convenience.
//
// Everything stored here is already public on-chain and is a pure cache: it can be dropped and
// rebuilt by replaying events from ledger zero.

// PoolNote is one commitment the contract emitted, with the encrypted payload its owner can open.
type PoolNote struct {
	QueueIndex int64
	Commitment string
	// LeafIndex is the tree position, valid only once Folded is true. A note is not spendable
	// before that: a membership proof needs a leaf that exists.
	LeafIndex int64
	Folded    bool
	EpkX      string
	EpkY      string
	EncAmount string
	EncRho    string
	Slot      int16
	Ledger    int64
	TxHash    string
}

// PoolRoot is one Merkle root the contract published.
type PoolRoot struct {
	NextIndex int64
	Root      string
	Count     int
	Ledger    int64
	TxHash    string
}

// InsertPoolNote records a queued commitment. Idempotent on queue_index, because event polling can
// legitimately re-deliver a range after a restart or a cursor reset — and double-inserting would
// corrupt leaf ordering, which silently makes every later note unspendable.
func (s *Store) InsertPoolNote(ctx context.Context, n PoolNote) error {
	_, err := s.pool.Exec(ctx, `
INSERT INTO pool_notes (queue_index, commitment, epk_x, epk_y, enc_amount, enc_rho, slot, ledger, tx_hash)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (queue_index) DO NOTHING`,
		n.QueueIndex, n.Commitment, n.EpkX, n.EpkY, n.EncAmount, n.EncRho, n.Slot, n.Ledger, n.TxHash)
	return err
}

// RecordPoolRoot records a fold and assigns leaf indices to the commitments it carried.
//
// The contract folds strictly in queue order, so the `count` notes starting at queue position
// `nextIndex` become leaves `nextIndex … nextIndex+count-1`. Done in one transaction: a root
// recorded without its leaf assignments (or vice versa) would leave the mirror disagreeing with the
// chain, and every path served from it would be wrong.
func (s *Store) RecordPoolRoot(ctx context.Context, r PoolRoot) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// `next_index` on the event is the tree size AFTER the fold, so this batch started earlier.
	start := r.NextIndex - int64(r.Count)
	if start < 0 {
		return fmt.Errorf("pool root %d has impossible count %d", r.NextIndex, r.Count)
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO pool_roots (next_index, root, count, ledger, tx_hash)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (next_index) DO NOTHING`,
		r.NextIndex, r.Root, r.Count, r.Ledger, r.TxHash); err != nil {
		return err
	}

	// Leaf index == queue index, because the contract never reorders or skips. Asserting that
	// equality here (rather than assuming it) is what catches an indexer that has drifted.
	if _, err := tx.Exec(ctx, `
UPDATE pool_notes SET leaf_index = queue_index
WHERE queue_index >= $1 AND queue_index < $2 AND leaf_index IS NULL`,
		start, r.NextIndex); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// InsertPoolNullifier records a spend seen on-chain.
func (s *Store) InsertPoolNullifier(ctx context.Context, nullifier string, ledger int64, txHash string) error {
	_, err := s.pool.Exec(ctx, `
INSERT INTO pool_nullifiers (nullifier, ledger, tx_hash) VALUES ($1, $2, $3)
ON CONFLICT (nullifier) DO NOTHING`, nullifier, ledger, txHash)
	return err
}

// FoldedLeaves returns every folded commitment in leaf order — the input the prover CLI needs to
// rebuild the tree for a membership path or a fold proof.
//
// Deliberately returns the whole tree. Fine at MVP volumes and trivially correct; the first thing to
// make incremental if path latency ever becomes a problem.
func (s *Store) FoldedLeaves(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
SELECT commitment FROM pool_notes WHERE leaf_index IS NOT NULL ORDER BY leaf_index ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// PendingLeaves returns up to `limit` queued-but-unfolded commitments, oldest first — exactly the
// batch the folder should submit next, in the order the contract will consume it.
func (s *Store) PendingLeaves(ctx context.Context, limit int) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
SELECT commitment FROM pool_notes WHERE leaf_index IS NULL ORDER BY queue_index ASC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// LeafIndexOf returns the tree position of a commitment, or ErrNotFound if it is unknown or still
// queued. A wallet uses this to turn "my note" into "the leaf to prove against".
func (s *Store) LeafIndexOf(ctx context.Context, commitment string) (int64, error) {
	var idx *int64
	err := s.pool.QueryRow(ctx,
		`SELECT leaf_index FROM pool_notes WHERE commitment = $1`, commitment).Scan(&idx)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if idx == nil {
		// Known but not yet folded. Distinct from "unknown": the wallet should wait, not error.
		return 0, ErrNotFolded
	}
	return *idx, nil
}

// ErrNotFolded means the commitment is queued but not yet in the tree, so it cannot be spent yet.
var ErrNotFolded = errors.New("commitment is queued but not yet folded into the tree")

// ScanPoolNotes returns notes with queue_index >= after, oldest first — the wallet's scan feed.
//
// Wallets trial-decrypt every entry; what opens is theirs. The feed is deliberately undiscriminating:
// filtering server-side by recipient would tell the backend who is being paid, which is exactly the
// privacy the pool exists to protect.
func (s *Store) ScanPoolNotes(ctx context.Context, after int64, limit int) ([]PoolNote, error) {
	rows, err := s.pool.Query(ctx, `
SELECT queue_index, commitment, COALESCE(leaf_index, -1), leaf_index IS NOT NULL,
       epk_x, epk_y, enc_amount, enc_rho, slot, ledger, tx_hash
FROM pool_notes WHERE queue_index >= $1 ORDER BY queue_index ASC LIMIT $2`, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []PoolNote
	for rows.Next() {
		var n PoolNote
		if err := rows.Scan(&n.QueueIndex, &n.Commitment, &n.LeafIndex, &n.Folded,
			&n.EpkX, &n.EpkY, &n.EncAmount, &n.EncRho, &n.Slot, &n.Ledger, &n.TxHash); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// SpentNullifiers reports which of the given nullifiers are already spent, so a wallet can reconcile
// its own notes against the chain rather than trusting local state.
func (s *Store) SpentNullifiers(ctx context.Context, nullifiers []string) ([]string, error) {
	if len(nullifiers) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx,
		`SELECT nullifier FROM pool_nullifiers WHERE nullifier = ANY($1)`, nullifiers)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// LatestPoolRoot returns the newest root, or ErrNotFound if nothing has been folded yet.
func (s *Store) LatestPoolRoot(ctx context.Context) (*PoolRoot, error) {
	var r PoolRoot
	err := s.pool.QueryRow(ctx, `
SELECT next_index, root, count, ledger, tx_hash FROM pool_roots ORDER BY next_index DESC LIMIT 1`).
		Scan(&r.NextIndex, &r.Root, &r.Count, &r.Ledger, &r.TxHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &r, err
}

// RecentPoolRoots returns the newest `limit` roots, newest first.
//
// Called with MerkleRootHistory to answer "is the root this wallet built against still accepted?" —
// a proof against an evicted root is rejected on-chain, and catching that here saves a user a
// failed transaction and a wasted proof.
func (s *Store) RecentPoolRoots(ctx context.Context, limit int) ([]PoolRoot, error) {
	rows, err := s.pool.Query(ctx, `
SELECT next_index, root, count, ledger, tx_hash FROM pool_roots ORDER BY next_index DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []PoolRoot
	for rows.Next() {
		var r PoolRoot
		if err := rows.Scan(&r.NextIndex, &r.Root, &r.Count, &r.Ledger, &r.TxHash); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// QueueDepth is how many commitments are waiting to be folded — the metric to alert on. A rising
// queue means the folder has stalled and new notes are not becoming spendable.
func (s *Store) QueueDepth(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM pool_notes WHERE leaf_index IS NULL`).Scan(&n)
	return n, err
}

// PoolCursor reads the indexer's saved position.
func (s *Store) PoolCursor(ctx context.Context) (cursor string, lastLedger int64, err error) {
	err = s.pool.QueryRow(ctx, `SELECT cursor, last_ledger FROM pool_cursor WHERE id = TRUE`).
		Scan(&cursor, &lastLedger)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", 0, nil // never polled; caller starts from its configured lookback
	}
	return cursor, lastLedger, err
}

// SavePoolCursor persists the indexer's position, so a restart resumes rather than rescanning — and,
// more importantly, cannot silently skip ledgers and lose notes.
func (s *Store) SavePoolCursor(ctx context.Context, cursor string, lastLedger int64) error {
	_, err := s.pool.Exec(ctx, `
INSERT INTO pool_cursor (id, cursor, last_ledger) VALUES (TRUE, $1, $2)
ON CONFLICT (id) DO UPDATE SET cursor = EXCLUDED.cursor, last_ledger = EXCLUDED.last_ledger, updated_at = now()`,
		cursor, lastLedger)
	return err
}
