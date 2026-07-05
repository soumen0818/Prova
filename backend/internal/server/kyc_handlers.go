package server

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/prova/shared/schema"
)

// kycRequest is the SEP-12 handoff body. In dev the anchor auto-approves; in production the anchor's
// KYC vendor (Sumsub/Onfido/Jumio) gates this. The wallet sends only userId — no raw identity here.
type kycRequest struct {
	UserID   string `json:"userId"`
	KycLevel int    `json:"kycLevel"`
}

// issueCredential runs the (stubbed) KYC approval and returns an anchor-signed credential.
func (h *handler) issueCredential(w http.ResponseWriter, r *http.Request) {
	if h.kyc == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "kyc issuer unavailable")
		return
	}
	var req kycRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "invalid JSON body")
		return
	}
	if req.UserID == "" {
		writeError(w, http.StatusBadRequest, schema.ErrKYCRequired, "userId is required")
		return
	}
	level := req.KycLevel
	if level < schema.MinKycLevel {
		level = 2 // dev default approval level
	}
	// TODO(Phase 5): gate on a real KYC vendor result before issuing. Dev auto-approves.
	expiry := time.Now().Add(365 * 24 * time.Hour).Unix()

	cred, err := h.kyc.Issue(r.Context(), req.UserID, level, expiry)
	if err != nil {
		h.logger.Error("credential issuance failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrCredentialInvalid, "could not issue credential")
		return
	}
	writeJSON(w, http.StatusOK, cred)
}

// trustedAnchors serves the set of anchor public keys whose credentials the circuit/contract accept.
func (h *handler) trustedAnchors(w http.ResponseWriter, r *http.Request) {
	if h.kyc == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "kyc issuer unavailable")
		return
	}
	pk, err := h.kyc.AnchorPublicKey(r.Context())
	if err != nil {
		h.logger.Error("anchor pubkey failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrInternal, "could not read anchor key")
		return
	}
	writeJSON(w, http.StatusOK, []schema.AnchorPublicKey{pk})
}
