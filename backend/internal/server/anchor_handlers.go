package server

import (
	"net/http"

	"github.com/prova/shared/schema"
)

// sep10Auth runs SEP-10 against the anchor with the backend's dev key and returns a JWT.
func (h *handler) sep10Auth(w http.ResponseWriter, r *http.Request) {
	if h.anchor == nil || h.sep10Key == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrAnchorUnavailable, "anchor not configured")
		return
	}
	token, err := h.anchor.Authenticate(r.Context(), h.sep10Key)
	if err != nil {
		h.logger.Error("sep10 auth failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrAnchorUnavailable, "sep10 authentication failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"account": h.sep10Key.Address(),
		"token":   token,
	})
}

// sep24Deposit authenticates then starts a SEP-24 interactive deposit, returning the popup URL.
func (h *handler) sep24Deposit(w http.ResponseWriter, r *http.Request) {
	if h.anchor == nil || h.sep10Key == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrAnchorUnavailable, "anchor not configured")
		return
	}
	token, err := h.anchor.Authenticate(r.Context(), h.sep10Key)
	if err != nil {
		h.logger.Error("sep10 auth failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrAnchorUnavailable, "sep10 authentication failed")
		return
	}
	depositURL, id, err := h.anchor.DepositInteractive(r.Context(), token, h.cfg.AnchorAsset, h.sep10Key.Address())
	if err != nil {
		h.logger.Error("sep24 deposit failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrAnchorUnavailable, "sep24 deposit initiation failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"account": h.sep10Key.Address(),
		"url":     depositURL,
		"id":      id,
	})
}
