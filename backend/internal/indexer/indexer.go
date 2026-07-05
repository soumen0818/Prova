// Package indexer polls Soroban `transfer` events and reconciles them into the transfer store, so
// history reflects what actually landed on-chain (including transfers not relayed by this backend).
package indexer

import (
	"context"
	"log/slog"
	"time"

	"github.com/prova/backend/internal/chain"
	"github.com/prova/backend/internal/store"
)

// Indexer periodically pulls contract events and upserts them as confirmed transfers.
type Indexer struct {
	events   *chain.EventsClient
	store    *store.Store
	logger   *slog.Logger
	interval time.Duration
	lookback uint32
}

// New builds an indexer. `lookback` is how many ledgers back to start scanning on boot.
func New(events *chain.EventsClient, st *store.Store, logger *slog.Logger, interval time.Duration, lookback uint32) *Indexer {
	return &Indexer{events: events, store: st, logger: logger, interval: interval, lookback: lookback}
}

// Run polls until the context is cancelled. Intended to run in its own goroutine.
func (i *Indexer) Run(ctx context.Context) {
	var start uint32
	if latest, err := i.events.GetLatestLedger(ctx); err == nil && latest > i.lookback {
		start = latest - i.lookback
	}
	cursor := ""
	ticker := time.NewTicker(i.interval)
	defer ticker.Stop()

	for {
		events, next, _, err := i.events.GetTransferEvents(ctx, start, cursor)
		if err != nil {
			i.logger.Warn("indexer poll failed", "err", err)
		} else {
			for _, e := range events {
				if uerr := i.store.UpsertConfirmed(ctx, e.Commitment, e.Nullifier, e.TxHash); uerr != nil {
					i.logger.Error("indexer upsert failed", "err", uerr)
				}
			}
			if len(events) > 0 {
				i.logger.Info("indexer ingested events", "count", len(events))
			}
			if next != "" {
				cursor = next // subsequent polls page forward from the cursor
				start = 0
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
