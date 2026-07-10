package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/prova/shared/schema"
)

// digitsOnly strips everything but 0-9 (for length validation).
func digitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// validPhone mirrors the client rule: 8–15 digits (E.164 range).
func validPhone(phone string) bool {
	d := digitsOnly(phone)
	return len(d) >= 8 && len(d) <= 15
}

// validOTP mirrors the client rule: a run of digits of the configured code length.
func validOTPFormat(code string, length int) bool {
	d := digitsOnly(code)
	return len(d) == length && d == strings.TrimSpace(code)
}

// Phone-login OTP. Two modes, selected by cfg.AuthMode:
//   - development: no SMS is sent; any phone is accepted and the fixed cfg.DevOTP verifies. The
//     request response echoes the dev code so the client can pre-fill it.
//   - production: a real SMS provider (Twilio, etc.) must be wired. Until then these return 501 so
//     the missing integration is explicit rather than silently insecure.
//
// This is intentionally stateless for now (no server-side OTP store): the development path verifies
// against a constant, and the production path is a clearly-marked stub. Swap in a provider + a
// short-lived code store (Redis) when real credentials land — the client contract stays the same.

type otpRequestBody struct {
	Phone string `json:"phone"`
}

type otpVerifyBody struct {
	Phone string `json:"phone"`
	Code  string `json:"code"`
}

func (h *handler) otpRequest(w http.ResponseWriter, r *http.Request) {
	var req otpRequestBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "invalid JSON body")
		return
	}
	if strings.TrimSpace(req.Phone) == "" {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "phone is required")
		return
	}
	if !validPhone(req.Phone) {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "phone must be 8–15 digits")
		return
	}
	if !h.authIsDev() {
		// TODO(Phase 5): send a real SMS OTP via the configured provider.
		writeError(w, http.StatusNotImplemented, schema.ErrInternal, "SMS provider not configured")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent", "devCode": h.cfg.DevOTP})
}

func (h *handler) otpVerify(w http.ResponseWriter, r *http.Request) {
	var req otpVerifyBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "invalid JSON body")
		return
	}
	if !validPhone(req.Phone) {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "phone must be 8–15 digits")
		return
	}
	if !validOTPFormat(req.Code, len(h.cfg.DevOTP)) {
		writeError(w, http.StatusBadRequest, schema.ErrInternal, "code must be 6 digits")
		return
	}
	if !h.authIsDev() {
		writeError(w, http.StatusNotImplemented, schema.ErrInternal, "SMS provider not configured")
		return
	}
	if strings.TrimSpace(req.Code) != h.cfg.DevOTP {
		writeError(w, http.StatusUnauthorized, schema.ErrInternal, "incorrect code")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": randomToken(), "phone": req.Phone})
}

func (h *handler) authIsDev() bool {
	return !strings.EqualFold(h.cfg.AuthMode, "production")
}

func randomToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "dev-token"
	}
	return hex.EncodeToString(b)
}
