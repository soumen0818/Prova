package server

// On-chain wallet endpoints for the real (testnet) deposit flow.
//
// The user's Stellar secret never reaches the backend. Trustline setup follows "server prepares,
// phone signs, server submits" (option A): /wallet/trustline/prepare returns an unsigned tx hash,
// the phone signs it, and /wallet/trustline/submit attaches the signature and broadcasts.

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/prova/shared/schema"
)

const maxWalletBody = 1 << 16

type addressBody struct {
	Address string `json:"address"`
}

// walletState returns the account's on-chain existence + balances (GET /wallet/{address}).
func (h *handler) walletState(w http.ResponseWriter, r *http.Request) {
	if h.wallet == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "on-chain wallet unavailable")
		return
	}
	address := r.PathValue("address")
	if address == "" {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "address is required")
		return
	}
	state, err := h.wallet.Load(r.Context(), address)
	if err != nil {
		h.logger.Error("wallet load failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrInternal, "could not read account")
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// walletFund activates a new testnet account via Friendbot (POST /wallet/fund).
func (h *handler) walletFund(w http.ResponseWriter, r *http.Request) {
	if h.wallet == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "on-chain wallet unavailable")
		return
	}
	var req addressBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxWalletBody)).Decode(&req); err != nil || req.Address == "" {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "address is required")
		return
	}
	if err := h.wallet.Fund(r.Context(), req.Address); err != nil {
		h.logger.Error("wallet fund failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrInternal, "could not fund account")
		return
	}
	state, _ := h.wallet.Load(r.Context(), req.Address)
	writeJSON(w, http.StatusOK, state)
}

// prepareTrustline builds an unsigned ChangeTrust tx for the anchor asset (POST /wallet/trustline/prepare).
func (h *handler) prepareTrustline(w http.ResponseWriter, r *http.Request) {
	if h.wallet == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "on-chain wallet unavailable")
		return
	}
	var req addressBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxWalletBody)).Decode(&req); err != nil || req.Address == "" {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "address is required")
		return
	}
	issuer, err := h.anchorAssetIssuer(r.Context())
	if err != nil {
		h.logger.Error("asset issuer lookup failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrAnchorUnavailable, "could not resolve anchor asset")
		return
	}
	unsigned, err := h.wallet.BuildTrustline(r.Context(), req.Address, h.cfg.AnchorAsset, issuer)
	if err != nil {
		h.logger.Error("build trustline failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrInternal, "could not prepare trustline")
		return
	}
	writeJSON(w, http.StatusOK, unsigned)
}

type submitSignedBody struct {
	XDR       string `json:"xdr"`
	PublicKey string `json:"publicKey"`
	Signature string `json:"signature"` // base64, over the tx hash
}

// submitTrustline attaches the phone's signature and broadcasts (POST /wallet/trustline/submit).
func (h *handler) submitTrustline(w http.ResponseWriter, r *http.Request) {
	if h.wallet == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "on-chain wallet unavailable")
		return
	}
	var req submitSignedBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxWalletBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "invalid JSON body")
		return
	}
	if req.XDR == "" || req.PublicKey == "" || req.Signature == "" {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "xdr, publicKey and signature are required")
		return
	}
	hash, err := h.wallet.SubmitSigned(r.Context(), req.XDR, req.PublicKey, req.Signature)
	if err != nil {
		h.logger.Error("submit trustline failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrInternal, "could not submit trustline")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"hash": hash})
}

// anchorAssetIssuer returns the configured issuer, or discovers it from the anchor's toml.
func (h *handler) anchorAssetIssuer(ctx context.Context) (string, error) {
	if h.cfg.AnchorAssetIssuer != "" {
		return h.cfg.AnchorAssetIssuer, nil
	}
	return h.anchor.AssetIssuer(ctx, h.cfg.AnchorAsset)
}
