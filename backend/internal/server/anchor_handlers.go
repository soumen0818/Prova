package server

import (
	"encoding/json"
	"net/http"

	"github.com/stellar/go/network"
	"github.com/stellar/go/txnbuild"

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

// depositPrepare fetches a SEP-10 challenge for the USER's account and returns it for signing.
//
// The user (not the backend) authenticates, so the anchor deposits to the user's wallet. The
// backend validates the challenge before returning its hash, and includes a human-readable summary
// so the app can show what's being signed.
func (h *handler) depositPrepare(w http.ResponseWriter, r *http.Request) {
	if h.anchor == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrAnchorUnavailable, "anchor not configured")
		return
	}
	var body struct {
		Address string `json:"address"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil || body.Address == "" {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "address is required")
		return
	}
	challengeXDR, passphrase, webAuth, err := h.anchor.UserChallenge(r.Context(), body.Address)
	if err != nil {
		h.logger.Error("sep10 user challenge failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrAnchorUnavailable, "could not start authentication")
		return
	}
	tx, err := txnbuild.TransactionFromXDR(challengeXDR)
	if err != nil {
		writeError(w, http.StatusBadGateway, schema.ErrAnchorUnavailable, "bad challenge")
		return
	}
	simple, _ := tx.Transaction()
	hashHex, herr := simple.HashHex(passphrase)
	if herr != nil {
		writeError(w, http.StatusBadGateway, schema.ErrAnchorUnavailable, "hash challenge")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"xdr":     challengeXDR,
		"hash":    hashHex,
		"network": passphrase,
		"webAuth": webAuth,
		"summary": "Sign in to your anchor to add money",
	})
}

// depositComplete attaches the user's signature to the challenge, exchanges it for a token (kept
// server-side), and starts the SEP-24 interactive deposit to the user's address.
func (h *handler) depositComplete(w http.ResponseWriter, r *http.Request) {
	if h.anchor == nil || h.wallet == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrAnchorUnavailable, "anchor not configured")
		return
	}
	var body struct {
		Address   string `json:"address"`
		XDR       string `json:"xdr"`
		WebAuth   string `json:"webAuth"`
		Network   string `json:"network"`
		PublicKey string `json:"publicKey"`
		Signature string `json:"signature"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "invalid JSON body")
		return
	}
	if body.Address == "" || body.XDR == "" || body.WebAuth == "" || body.PublicKey == "" || body.Signature == "" {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "missing fields")
		return
	}
	passphrase := body.Network
	if passphrase == "" {
		passphrase = network.TestNetworkPassphrase
	}
	// Attach the user's signature to the (already server-signed) challenge.
	generic, err := txnbuild.TransactionFromXDR(body.XDR)
	if err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "bad challenge")
		return
	}
	tx, ok := generic.Transaction()
	if !ok {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "bad challenge")
		return
	}
	signed, err := tx.AddSignatureBase64(passphrase, body.PublicKey, body.Signature)
	if err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "invalid signature")
		return
	}
	signedXDR, err := signed.Base64()
	if err != nil {
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "encode challenge")
		return
	}
	token, err := h.anchor.TokenForSignedChallenge(r.Context(), body.WebAuth, signedXDR)
	if err != nil {
		h.logger.Error("sep10 token exchange failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrAnchorUnavailable, "authentication failed")
		return
	}
	depositURL, id, err := h.anchor.DepositInteractive(r.Context(), token, h.cfg.AnchorAsset, body.Address)
	if err != nil {
		h.logger.Error("sep24 deposit failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrAnchorUnavailable, "deposit initiation failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"account": body.Address, "url": depositURL, "id": id})
}

// sep24Deposit is the legacy backend-authenticated deposit (kept for the simple/no-user path).
// The user-authenticated flow is depositPrepare + depositComplete.
func (h *handler) sep24Deposit(w http.ResponseWriter, r *http.Request) {
	if h.anchor == nil || h.sep10Key == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrAnchorUnavailable, "anchor not configured")
		return
	}
	var body struct {
		Address string `json:"address"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body)
	target := body.Address
	if target == "" {
		target = h.sep10Key.Address()
	}

	token, err := h.anchor.Authenticate(r.Context(), h.sep10Key)
	if err != nil {
		h.logger.Error("sep10 auth failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrAnchorUnavailable, "sep10 authentication failed")
		return
	}
	depositURL, id, err := h.anchor.DepositInteractive(r.Context(), token, h.cfg.AnchorAsset, target)
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
