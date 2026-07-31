package pool

import (
	"context"
	"log/slog"
	"time"

	"github.com/prova/backend/internal/chain"
	"github.com/prova/backend/internal/store"
)

// Indexer replays pool events into the off-chain mirror wallets depend on.
//
// This is not analytics. The contract keeps only a Merkle root — it cannot hash, so it cannot hold
// the tree (§10.1) — and a wallet cannot build a spend proof without a membership path. If this
// stops, deposits still work and funds stay safe, but **nobody can spend**. Treat it as a critical
// path service.
//
// Ordering is what makes it correct: a commitment's leaf index is its queue index, assigned by the
// contract when a fold lands. So notes must be recorded before the fold that promotes them, which
// is why each page is applied notes-then-roots rather than in raw event order.
type Indexer struct {
	events   *chain.PoolEventsClient
	store    *store.Store
	logger   *slog.Logger
	interval time.Duration
	lookback uint32
}

// NewIndexer builds a pool indexer. `lookback` is how many ledgers back a *fresh* scan starts from;
// once a cursor is saved it resumes from there instead.
func NewIndexer(
	events *chain.PoolEventsClient,
	st *store.Store,
	logger *slog.Logger,
	interval time.Duration,
	lookback uint32,
) *Indexer {
	return &Indexer{events: events, store: st, logger: logger, interval: interval, lookback: lookback}
}

// Run polls until the context is cancelled. Intended to run in its own goroutine.
func (i *Indexer) Run(ctx context.Context) {
	cursor, lastLedger, err := i.store.PoolCursor(ctx)
	if err != nil {
		i.logger.Error("pool indexer: cannot read cursor, starting fresh", "err", err)
	}

	// Only choose a start ledger when there is no saved cursor. Resuming from the cursor is what
	// stops a restart re-reading (or worse, skipping) ledgers.
	var start uint32
	if cursor == "" {
		if latest, lerr := i.events.GetLatestPoolLedger(ctx); lerr == nil && latest > i.lookback {
			start = latest - i.lookback
		}
		i.logger.Info("pool indexer: fresh scan", "start_ledger", start)
	} else {
		i.logger.Info("pool indexer: resuming", "last_ledger", lastLedger)
	}

	ticker := time.NewTicker(i.interval)
	defer ticker.Stop()

	for {
		if err := i.poll(ctx, &start, &cursor); err != nil {
			// Deliberately do not advance the cursor on failure: re-reading a page is harmless
			// (every write is idempotent), whereas skipping one loses notes permanently.
			i.logger.Warn("pool indexer poll failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// poll fetches and applies one page.
func (i *Indexer) poll(ctx context.Context, start *uint32, cursor *string) error {
	page, err := i.events.GetPoolEvents(ctx, *start, *cursor)
	if err != nil {
		return err
	}

	// 1. Notes first. A fold promotes commitments that must already be recorded, so applying roots
	//    first would leave leaf indices unassigned and every path built from them wrong.
	for _, n := range page.Notes {
		if err := i.store.InsertPoolNote(ctx, store.PoolNote{
			QueueIndex: n.QueueIndex,
			Commitment: n.Commitment,
			EpkX:       n.EpkX,
			EpkY:       n.EpkY,
			EncAmount:  n.EncAmount,
			EncRho:     n.EncRho,
			Slot:       n.Slot,
			Ledger:     n.Ledger,
			TxHash:     n.TxHash,
		}); err != nil {
			return err
		}
	}

	// 2. Roots, which assign leaf indices and make those notes spendable.
	for _, r := range page.Roots {
		if err := i.store.RecordPoolRoot(ctx, store.PoolRoot{
			NextIndex: r.NextIndex,
			Root:      r.Root,
			Count:     r.Count,
			Ledger:    r.Ledger,
			TxHash:    r.TxHash,
		}); err != nil {
			return err
		}
	}

	// 3. Nullifiers, so wallets can reconcile spent notes against the chain.
	for _, s := range page.Spends {
		if err := i.store.InsertPoolNullifier(ctx, s.Nullifier, s.Ledger, s.TxHash); err != nil {
			return err
		}
	}

	if total := len(page.Notes) + len(page.Roots) + len(page.Spends); total > 0 {
		i.logger.Info("pool indexer ingested",
			"notes", len(page.Notes), "roots", len(page.Roots), "spends", len(page.Spends))
	}

	// Persist the cursor only after every write in the page has succeeded, so a crash mid-page
	// replays it rather than losing it.
	if page.Cursor != "" {
		*cursor = page.Cursor
		*start = 0 // subsequent polls page forward from the cursor
		if err := i.store.SavePoolCursor(ctx, page.Cursor, int64(page.LatestLedger)); err != nil {
			return err
		}
	}
	return nil
}
