package server

// Shield endpoints — moving money INTO the shielded pool.
//
// Shield is the one pool operation the relayer cannot do for a user: the contract runs
// `from.require_auth()` and then moves tokens out of *their* account. So it follows the same
// "server prepares, phone signs, server submits" pattern as the trustline (Docs/deposit-flow.md).
// The backend never sees the user's secret, and the phone never needs a Stellar SDK.

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/prova/backend/internal/chain"
	"github.com/prova/shared/schema"
)

const maxShieldBody = 1 << 16

// shieldUnavailable reports 503 when the pool contract or Soroban RPC is not configured.
func (h *handler) shieldUnavailable(w http.ResponseWriter) bool {
	if h.shielder == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal,
			"the shielded pool is not configured on this server")
		return true
	}
	return false
}

// prepareShield builds an unsigned shield transaction (POST /pool/shield/prepare).
//
// Simulation happens here, so an invalid proof is caught before the user is asked to approve
// anything — rather than after they have signed and paid a fee for a transaction that reverts.
func (h *handler) prepareShield(w http.ResponseWriter, r *http.Request) {
	if h.shieldUnavailable(w) {
		return
	}
	var req schema.ShieldPrepareRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxShieldBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "invalid JSON body")
		return
	}
	if !schema.IsValidStellarAddress(req.Address) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "not a valid Stellar address")
		return
	}
	if req.Amount <= 0 {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "amount must be positive")
		return
	}

	unsigned, err := h.shielder.Build(r.Context(), chain.ShieldRequest{
		From:   req.Address,
		Amount: req.Amount,
		Note: chain.ShieldNote{
			Commitment: req.Note.Commitment,
			OwnerPk:    req.Note.OwnerPk,
			EpkX:       req.Note.EpkX,
			EpkY:       req.Note.EpkY,
			EncAmount:  req.Note.EncAmount,
			EncRho:     req.Note.EncRho,
		},
		ProofA: req.ProofA,
		ProofB: req.ProofB,
		ProofC: req.ProofC,
	})
	switch {
	case errors.Is(err, chain.ErrShieldRejected):
		// The chain says this call would revert. That is the caller's problem, not ours — 422 so a
		// client can tell it apart from "we are broken" and must not retry unchanged.
		h.logger.Warn("shield simulation rejected", "err", err)
		writeError(w, http.StatusUnprocessableEntity, schema.ErrBadRequest,
			"the deposit was rejected by the pool contract")
		return
	case err != nil:
		h.logger.Error("build shield failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrInternal, "could not prepare the deposit")
		return
	}
	writeJSON(w, http.StatusOK, unsigned)
}

// submitShield attaches the phone's signature and broadcasts (POST /pool/shield/submit).
func (h *handler) submitShield(w http.ResponseWriter, r *http.Request) {
	if h.shieldUnavailable(w) {
		return
	}
	var req submitSignedBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxShieldBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "invalid JSON body")
		return
	}
	if req.XDR == "" || req.Signature == "" {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "xdr and signature are required")
		return
	}
	if !schema.IsValidStellarAddress(req.PublicKey) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "not a valid Stellar address")
		return
	}

	hash, err := h.shielder.SubmitSigned(r.Context(), req.XDR, req.PublicKey, req.Signature)
	switch {
	case errors.Is(err, chain.ErrShieldUnconfirmed):
		// Accepted but unconfirmed: the money may still arrive. Reporting failure here is what
		// makes someone deposit a second time, so this is an explicit non-failure status.
		h.logger.Warn("shield unconfirmed", "hash", hash, "err", err)
		writeJSON(w, http.StatusAccepted, schema.ShieldSubmitResponse{
			Hash: hash, Status: schema.ShieldPending,
		})
		return
	case errors.Is(err, chain.ErrShieldRejected):
		h.logger.Warn("shield rejected on submit", "err", err)
		writeError(w, http.StatusUnprocessableEntity, schema.ErrBadRequest,
			"the deposit was rejected by the pool contract")
		return
	case err != nil:
		h.logger.Error("submit shield failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrInternal, "could not submit the deposit")
		return
	}
	writeJSON(w, http.StatusOK, schema.ShieldSubmitResponse{Hash: hash, Status: schema.ShieldConfirmed})
}
