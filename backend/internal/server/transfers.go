package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/prova/backend/internal/store"
	"github.com/prova/backend/internal/transfers"
	"github.com/prova/shared/schema"
)

// submitTransfer accepts a proof, relays it to the contract, and returns the transfer record.
func (h *handler) submitTransfer(w http.ResponseWriter, r *http.Request) {
	if h.transfers == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "transfer service unavailable")
		return
	}
	var req schema.SubmitTransferRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "invalid JSON body")
		return
	}
	resp, err := h.transfers.Submit(r.Context(), req)
	switch {
	case errors.Is(err, transfers.ErrInvalidRequest):
		writeError(w, http.StatusBadRequest, schema.ErrInvalidProof, "proof is missing required fields")
		return
	case err != nil:
		h.logger.Error("submit transfer failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not submit transfer")
		return
	}
	writeJSON(w, http.StatusCreated, resp)
}

// getTransfer returns the current lifecycle record for a transfer id.
func (h *handler) getTransfer(w http.ResponseWriter, r *http.Request) {
	if h.transfers == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "transfer service unavailable")
		return
	}
	rec, err := h.transfers.Get(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, schema.ErrInternal, "transfer not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not fetch transfer")
		return
	}
	writeJSON(w, http.StatusOK, rec)
}
