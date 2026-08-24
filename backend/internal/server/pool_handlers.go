package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/prova/backend/internal/pool"
	"github.com/prova/backend/internal/store"
	"github.com/prova/shared/schema"
)

// Shielded-pool endpoints (Docs/shielded-pool.md §10.7).
//
// A wallet holds its own note secrets but has no view of the Merkle tree, because the contract keeps
// only a root. These three routes are what let it spend at all: find my note, prove my note, and see
// what arrived. Everything served here is already public on-chain — no endpoint reveals an amount, a
// sender or a recipient.

// maxPoolBody caps the nullifier-reconciliation request body.
const maxPoolBody = 1 << 20

// poolUnavailable reports 503 when the indexer is not configured (no Postgres, or no pool contract).
//
// Called *after* request validation: a malformed request is the caller's bug whatever the server's
// state, and answering 503 would hide that from them.
func (h *handler) poolUnavailable(w http.ResponseWriter) bool {
	if h.pool == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrPoolUnavailable,
			"the shielded pool indexer is not configured")
		return true
	}
	return false
}

// GET /pool/notes?after=<queueIndex>&limit=<n>
//
// The scan feed. Returns notes from `after` onward for the wallet to trial-decrypt. Deliberately
// unfiltered: filtering by recipient would tell this backend who is being paid.
func (h *handler) poolNotes(w http.ResponseWriter, r *http.Request) {
	after, err := queryInt64(r, "after", 0)
	if err != nil || after < 0 {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "after must be a non-negative integer")
		return
	}
	limit, err := queryInt64(r, "limit", schema.PoolScanMaxLimit)
	if err != nil || limit < 0 {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "limit must be a non-negative integer")
		return
	}
	if h.poolUnavailable(w) {
		return
	}
	if !h.allowPoolRead(w, r) {
		return
	}

	notes, err := h.pool.Scan(r.Context(), after, int(limit))
	if err != nil {
		h.logger.Error("pool scan failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not read notes")
		return
	}

	// `next` is where the wallet resumes. Echoing `after` on an empty page keeps the cursor stable
	// so a caller that polls at the tip does not rewind.
	next := after
	if len(notes) > 0 {
		next = notes[len(notes)-1].QueueIndex + 1
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": notes, "next": next})
}

// GET /pool/path/{commitment}
//
// The membership path for one note — the private witness of its spend proof.
func (h *handler) poolPath(w http.ResponseWriter, r *http.Request) {
	commitment := strings.ToLower(strings.TrimSpace(r.PathValue("commitment")))
	if !isHex32(commitment) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest,
			"commitment must be 32-byte hex")
		return
	}
	if h.poolUnavailable(w) {
		return
	}
	// Rebuilds the Merkle tree per call: cheap to ask for, expensive to serve.
	if !h.allowPoolRead(w, r) {
		return
	}

	path, err := h.pool.MerklePathFor(r.Context(), commitment)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, schema.ErrNoteNotFound, "unknown commitment")
		return
	case errors.Is(err, pool.ErrNotFolded):
		// Not an error the user can act on beyond waiting: the note exists and is theirs, it is
		// simply not a tree leaf yet. 409 rather than 404 so wallets can retry rather than give up.
		writeError(w, http.StatusConflict, schema.ErrNoteNotFolded,
			"note is queued but not yet folded into the tree; retry shortly")
		return
	case err != nil:
		h.logger.Error("pool path failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not build path")
		return
	}

	siblings := make([]schema.Hex, 0, len(path.Siblings))
	for _, s := range path.Siblings {
		siblings = append(siblings, schema.Hex(s))
	}
	writeJSON(w, http.StatusOK, schema.PoolMerklePath{
		LeafIndex: path.LeafIndex,
		Siblings:  siblings,
		Root:      schema.Hex(path.Root),
	})
}

// GET /pool/status
//
// Tree size, current root, and queue depth. Queue depth is the number to alert on: a rising queue
// means the folder has stalled and new notes are not becoming spendable.
// shortReason trims an internal error down to something safe to hand back to a caller.
//
// Long enough to name the cause, short enough that a stack trace or a stray path cannot ride along.
func shortReason(err error) string {
	const max = 200
	// Collapse whitespace: CLI output is multi-line and a message is rendered as one string.
	msg := strings.Join(strings.Fields(err.Error()), " ")
	if len(msg) > max {
		msg = msg[:max] + "…"
	}
	return msg
}

func (h *handler) poolStatus(w http.ResponseWriter, r *http.Request) {
	if h.poolUnavailable(w) {
		return
	}
	st, err := h.pool.Status(r.Context())
	if err != nil {
		h.logger.Error("pool status failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not read status")
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// POST /pool/spent  {"nullifiers": ["<hex>", ...]}
//
// Which of these are already spent. Lets a wallet restored from seed reconcile against the chain
// instead of trusting local state — otherwise it would show spent notes as available balance.
func (h *handler) poolSpent(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Nullifiers []string `json:"nullifiers"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPoolBody)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "invalid JSON body")
		return
	}
	for _, n := range body.Nullifiers {
		if !isHex32(strings.ToLower(n)) {
			writeError(w, http.StatusBadRequest, schema.ErrBadRequest,
				"every nullifier must be 32-byte hex")
			return
		}
	}
	if h.poolUnavailable(w) {
		return
	}

	spent, err := h.pool.SpentNullifiers(r.Context(), body.Nullifiers)
	if err != nil {
		h.logger.Error("pool spent lookup failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not check nullifiers")
		return
	}
	if spent == nil {
		spent = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"spent": spent})
}

// --- small helpers ---

func queryInt64(r *http.Request, key string, def int64) (int64, error) {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return def, nil
	}
	return strconv.ParseInt(raw, 10, 64)
}

// isHex32 checks for exactly 64 lowercase hex characters (a 32-byte field element).
func isHex32(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// POST /pool/spend
//
// Relays a private transfer or an unshield, so the user's own Stellar account never appears next to
// their spend. Without this the cryptography would still hold — the amount and parties stay hidden —
// but the chain would record which account submitted it, and the privacy would be gone in practice.
//
// The relayer cannot steal or alter anything: the amount, both output notes, the payout destination
// and the encrypted payloads are all bound inside the proof. Its only powers are to refuse (the
// contract is permissionless, so a user can always submit themselves) and to see the request.
func (h *handler) poolSpend(w http.ResponseWriter, r *http.Request) {
	var req schema.PoolSpendRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPoolBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "invalid JSON body")
		return
	}
	// A(96) ‖ B(192) ‖ C(96) = 768 hex chars. Checked here so a malformed blob is a clear 400
	// rather than surfacing later as an opaque "proof rejected".
	if len(req.Proof) != 768 {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest,
			"proof must be 768 hex characters (A‖B‖C)")
		return
	}
	if !isHex32(strings.ToLower(string(req.Root))) || !isHex32(strings.ToLower(string(req.Nullifier))) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest,
			"root and nullifier must be 32-byte hex")
		return
	}
	if h.poolUnavailable(w) {
		return
	}

	txHash, err := h.pool.Relay(r.Context(), req)
	switch {
	case errors.Is(err, pool.ErrRelayUnavailable):
		writeError(w, http.StatusServiceUnavailable, schema.ErrPoolUnavailable,
			"no relayer configured; submit the transaction yourself")
		return
	case errors.Is(err, pool.ErrNoteAlreadySpent):
		// Also the shape of an honest retry of something that already landed, so it is a 409 rather
		// than an accusation.
		writeError(w, http.StatusConflict, schema.ErrNullifierAlreadyUsed, "this note is already spent")
		return
	case errors.Is(err, pool.ErrRootExpired):
		// Actionable: the wallet should refetch its path and re-prove, not retry as-is.
		writeError(w, http.StatusConflict, schema.ErrNoteNotFolded,
			"the merkle root is no longer accepted; refetch the path and re-prove")
		return
	case errors.Is(err, pool.ErrSpendRejected):
		writeError(w, http.StatusBadRequest, schema.ErrInvalidProof, "the proof was rejected")
		return
	case errors.Is(err, pool.ErrPoolPaused):
		writeError(w, http.StatusServiceUnavailable, schema.ErrPoolUnavailable,
			"deposits and transfers are paused; withdrawals are unaffected")
		return
	case err != nil:
		h.logger.Error("pool relay failed", "err", err)
		/*
		 * Return the reason, not just the fact.
		 *
		 * Everything above this point is a known contract error with its own message. Reaching here
		 * means something unforeseen — and "could not relay the spend" tells the person whose money
		 * it is nothing, and gives whoever they report it to nothing either. The relayer already
		 * captures the last few lines of CLI output for exactly this; discarding them left the only
		 * copy in a log behind a security group.
		 *
		 * Bounded, because it is CLI output and this is a public response.
		 */
		writeError(w, http.StatusInternalServerError, schema.ErrInternal,
			"could not relay the spend: "+shortReason(err))
		return
	}
	writeJSON(w, http.StatusOK, schema.PoolSpendResponse{TxHash: txHash})
}
