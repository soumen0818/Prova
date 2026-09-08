package server

import (
	"net/http"
	"time"

	"github.com/prova/backend/internal/lifecycle"
	"github.com/prova/shared/schema"
)

/*
 * Reconciliation (Docs/progress.md §0.4).
 *
 * The system must always be able to answer "where is this transfer?" — and, more usefully, "is
 * anything stuck?". Every other health signal is healthy-by-default: the API answers, the folder
 * folds, the queue drains. A transfer stalled between submitting and any outcome appears in none of
 * them. It is one row that nothing will move again, and without this the only person who finds out
 * is whoever was owed the money.
 */

// defaultStuckAfter is how long a transfer may sit in flight before it counts as stalled.
//
// Ten minutes is far longer than any legitimate path: the Soroban submitter confirms synchronously,
// so a transfer reaches a terminal state within seconds or not at all. Generous on purpose — the
// cost of a false alarm is an operator learning to ignore this, which is worse than finding a stuck
// transfer late.
const defaultStuckAfter = 10 * time.Minute

// maxStuckWindow bounds the caller-supplied window so a stray parameter cannot turn this into a full
// table scan of everything ever submitted.
const maxStuckWindow = 30 * 24 * time.Hour

// GET /ops/reconcile
//
// Transfers that entered a non-terminal state and stopped moving. Empty is the healthy answer.
//
// Behind COMPLIANCE_TOKEN like every other /ops route: it lists transfer ids, commitments and
// nullifiers, which is operational data rather than public state.
func (h *handler) opsReconcile(w http.ResponseWriter, r *http.Request) {
	if !h.validComplianceToken(r.Header.Get("Authorization")) {
		writeError(w, http.StatusUnauthorized, schema.ErrInternal, "missing or invalid compliance token")
		return
	}
	if h.store == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "store unavailable")
		return
	}

	window := defaultStuckAfter
	if raw := r.URL.Query().Get("olderThan"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			writeError(w, http.StatusBadRequest, schema.ErrBadRequest,
				`olderThan must be a positive duration, e.g. "10m" or "2h"`)
			return
		}
		if d > maxStuckWindow {
			d = maxStuckWindow
		}
		window = d
	}

	limit, err := queryInt64(r, "limit", 100)
	if err != nil || limit <= 0 || limit > 1000 {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "limit must be between 1 and 1000")
		return
	}

	stuck, err := h.store.StuckTransfers(r.Context(), window, int(limit))
	if err != nil {
		h.logger.Error("reconcile query failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not read transfers")
		return
	}

	out := make([]schema.StuckTransfer, 0, len(stuck))
	for _, t := range stuck {
		out = append(out, schema.StuckTransfer{
			TransferID: t.ID,
			Status:     t.Status,
			Commitment: t.Commitment,
			Nullifier:  t.Nullifier,
			TxHash:     t.TxHash,
			CreatedAt:  t.CreatedAt.UTC().Format(time.RFC3339),
			UpdatedAt:  t.UpdatedAt.UTC().Format(time.RFC3339),
			StuckFor:   time.Since(t.UpdatedAt).Round(time.Second).String(),
			// What an operator actually needs: whether the money moved. `submitted` means a
			// transaction exists and its outcome is unknown; `pending` and `submitting` mean it very
			// likely never left. Those need different responses, and the status alone does not say so
			// to somebody reading an alert at 3am.
			Settled: lifecycle.Settled(t.Status),
		})
	}

	writeJSON(w, http.StatusOK, schema.ReconcileReport{
		StuckAfter: window.String(),
		Count:      len(out),
		Transfers:  out,
	})
}
