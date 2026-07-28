package server

// KYC verification endpoints — see Docs/kyc-verification.md §6.
//
// None of these accept personal data. The app sends only the opaque userId (= Poseidon(secret,
// domain)) and a tier; documents go straight from the device to the verification provider. There is
// deliberately no endpoint that can receive a document, so there is no document store to leak.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/prova/backend/internal/kyc"
	"github.com/prova/shared/schema"
)

const maxKYCBody = 1 << 16

// startVerification begins a KYC verification for a wallet (POST /kyc/verifications).
func (h *handler) startVerification(w http.ResponseWriter, r *http.Request) {
	if h.verification == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "verification unavailable")
		return
	}
	var req schema.StartVerificationRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxKYCBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "invalid JSON body")
		return
	}
	if req.UserID == "" {
		writeError(w, http.StatusBadRequest, schema.ErrKYCRequired, "userId is required")
		return
	}

	v, err := h.verification.Start(r.Context(), string(req.UserID), req.Tier)
	if errors.Is(err, kyc.ErrNotRetryable) {
		// Terminal rejection (sanctions/duplicate/underage) — resubmission must not be possible.
		writeError(w, http.StatusForbidden, schema.ErrKYCRequired, "this verification cannot be retried")
		return
	}
	if err != nil {
		h.logger.Error("start verification failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrInternal, "could not start verification")
		return
	}
	writeJSON(w, http.StatusOK, v.ToRecord())
}

// getVerification returns the current status (GET /kyc/verifications/{userId}).
func (h *handler) getVerification(w http.ResponseWriter, r *http.Request) {
	if h.verification == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "verification unavailable")
		return
	}
	userID := r.PathValue("userId")
	if userID == "" {
		writeError(w, http.StatusBadRequest, schema.ErrKYCRequired, "userId is required")
		return
	}
	v, err := h.verification.Get(r.Context(), userID)
	if errors.Is(err, kyc.ErrNotFound) {
		writeJSON(w, http.StatusOK, schema.VerificationRecord{Status: schema.VerificationNotStarted})
		return
	}
	if err != nil {
		h.logger.Error("get verification failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not read verification")
		return
	}
	writeJSON(w, http.StatusOK, v.ToRecord())
}

// verificationWebhook receives a provider verdict (POST /kyc/verifications/webhook).
//
// Authenticated with an HMAC-SHA256 signature over the raw body and idempotent in the service, so a
// replayed verdict cannot forge or duplicate an approval.
func (h *handler) verificationWebhook(w http.ResponseWriter, r *http.Request) {
	if h.verification == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "verification unavailable")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxKYCBody))
	if err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "could not read body")
		return
	}
	if !h.validWebhookSignature(r.Header.Get("X-Prova-Signature"), body) {
		writeError(w, http.StatusUnauthorized, schema.ErrInternal, "invalid signature")
		return
	}

	verdict, err := h.verificationProvider.Parse(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "invalid verdict payload")
		return
	}
	if err := h.verification.ApplyVerdict(r.Context(), verdict); err != nil && !errors.Is(err, kyc.ErrNotFound) {
		h.logger.Error("apply verdict failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not apply verdict")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// decideVerification records a human compliance decision (POST /kyc/verifications/{userId}/decide).
// Compliance-only: in production this sits behind the anchor's authenticated console.
func (h *handler) decideVerification(w http.ResponseWriter, r *http.Request) {
	if h.verification == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "verification unavailable")
		return
	}
	userID := r.PathValue("userId")
	var req schema.DecideRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxKYCBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "invalid JSON body")
		return
	}
	approve := req.Decision == "approved"
	v, err := h.verification.Decide(r.Context(), userID, approve, req.ReasonCode, req.Reviewer)
	if errors.Is(err, kyc.ErrNotFound) {
		writeError(w, http.StatusNotFound, schema.ErrKYCRequired, "no verification for this user")
		return
	}
	if err != nil {
		h.logger.Error("decide verification failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not record decision")
		return
	}
	writeJSON(w, http.StatusOK, v.ToRecord())
}

// issueCredential returns an anchor-signed credential — gated on a stored `approved` record.
//
// The caller cannot assert its own approval: the level and expiry come from the verification record,
// never from the request body.
func (h *handler) issueCredential(w http.ResponseWriter, r *http.Request) {
	if h.verification == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "verification unavailable")
		return
	}
	var req schema.StartVerificationRequest // reuse: only userId is read
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxKYCBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "invalid JSON body")
		return
	}
	if req.UserID == "" {
		writeError(w, http.StatusBadRequest, schema.ErrKYCRequired, "userId is required")
		return
	}

	cred, err := h.verification.IssueCredential(r.Context(), string(req.UserID))
	switch {
	case errors.Is(err, kyc.ErrNotApproved), errors.Is(err, kyc.ErrNotFound):
		writeError(w, http.StatusForbidden, schema.ErrKYCRequired, "verification is not approved")
		return
	case err != nil:
		h.logger.Error("credential issuance failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrCredentialInvalid, "could not issue credential")
		return
	}
	writeJSON(w, http.StatusOK, cred)
}

// renewCredential re-issues before expiry (POST /kyc/credential/renew). Re-screening at renewal is
// what bounds sanctions exposure, since an on-phone credential cannot be revoked remotely.
func (h *handler) renewCredential(w http.ResponseWriter, r *http.Request) {
	if h.verification == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "verification unavailable")
		return
	}
	var req schema.StartVerificationRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxKYCBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "invalid JSON body")
		return
	}
	cred, err := h.verification.Renew(r.Context(), string(req.UserID))
	switch {
	case errors.Is(err, kyc.ErrNotApproved), errors.Is(err, kyc.ErrNotFound):
		writeError(w, http.StatusForbidden, schema.ErrKYCRequired, "verification is not approved")
		return
	case err != nil:
		h.logger.Error("credential renewal failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrCredentialInvalid, "could not renew credential")
		return
	}
	writeJSON(w, http.StatusOK, cred)
}

// validWebhookSignature checks the HMAC-SHA256 of the raw body against the configured secret.
// If no secret is configured (local dev), signature checking is skipped.
func (h *handler) validWebhookSignature(header string, body []byte) bool {
	if h.cfg.KYCWebhookSecret == "" {
		return true
	}
	mac := hmac.New(sha256.New, []byte(h.cfg.KYCWebhookSecret))
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(header))
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
