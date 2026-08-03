package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/prova/backend/internal/mailer"
	"github.com/prova/backend/internal/otp"
	"github.com/prova/shared/schema"
)

// One-time codes, for two different purposes.
//
//	POST /auth/otp/request  +  /auth/otp/verify    → EMAIL. Signing in. The account identifier.
//	POST /kyc/phone/request +  /kyc/phone/verify   → PHONE. Proving a contact number during KYC.
//
// They are separate on purpose. Email is who the account *is*; the phone number is an attribute the
// anchor needs for compliance and payout contact. Conflating them would mean a user who changes
// their phone loses their account.
//
// # Validation
//
// Every rule comes from `schema` (shared/src/validation.ts, mirrored in validation.go), so the app
// and this handler cannot drift. Client-side checks are a courtesy; these are the actual control,
// because anything can post here.
//
// # How codes work
//
// When SMTP is configured, a **real** random code is generated, stored hashed with a 10-minute TTL
// and a 5-attempt cap, and emailed. That applies in development too, so the path you test is the
// path that ships.
//
// Without SMTP:
//
//   - development falls back to the fixed cfg.DevOTP, so the flow works offline;
//   - production refuses to sign anyone in, rather than accepting a code that was never sent.
//
// SMS for the phone step has no provider yet and still returns 501 — the gap stays explicit.
//
// # Error messages
//
// Every failure returns something a user can act on: what went wrong and what to do about it. A
// stale code says so and offers a resend; a burned code says request a new one. Vague errors on an
// auth screen are where users give up.

const maxAuthBody = 1 << 12

type emailOTPRequest struct {
	Email string `json:"email"`
}

type emailOTPVerify struct {
	Email string `json:"email"`
	Code  string `json:"code"`
}

func (h *handler) otpRequest(w http.ResponseWriter, r *http.Request) {
	var req emailOTPRequest
	if !decodeAuthBody(w, r, &req) {
		return
	}
	if !schema.IsValidEmail(req.Email) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "Enter a valid email address")
		return
	}
	// Rate-limit AFTER validating: a malformed address should not consume someone's hourly quota,
	// and keying the limiter on junk would just fill it with noise.
	if !h.allowOTPRequest(w, r, "email:"+schema.NormalizeEmail(req.Email)) {
		return
	}
	email := schema.NormalizeEmail(req.Email)

	// No mailer: development keeps working offline with the fixed code; production refuses rather
	// than pretending to have sent something.
	if !h.mailer.Configured() {
		if !h.authIsDev() {
			writeError(w, http.StatusNotImplemented, schema.ErrInternal,
				"Email sign-in is not available right now. Please try again later.")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "sent", "devCode": h.cfg.DevOTP})
		return
	}

	code, err := h.otp.Issue(r.Context(), "email:"+email)
	if err != nil {
		h.logger.Error("otp issue failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal,
			"We couldn't create a sign-in code. Please try again.")
		return
	}

	subject, text, html := mailer.CodeEmail(code, int(otp.TTL.Minutes()))
	if err := h.mailer.SendHTML(r.Context(), email, subject, text, html); err != nil {
		// The address is never echoed into the log — an error report should not become a record of
		// who is signing in.
		h.logger.Error("otp email send failed", "err", err)
		writeError(w, http.StatusBadGateway, schema.ErrInternal,
			"We couldn't send your code. Check the address and try again.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

func (h *handler) otpVerify(w http.ResponseWriter, r *http.Request) {
	var req emailOTPVerify
	if !decodeAuthBody(w, r, &req) {
		return
	}
	// Re-validate the address, not just the code: a client can post a code against an address it
	// never requested one for.
	if !schema.IsValidEmail(req.Email) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "Enter a valid email address")
		return
	}
	if !schema.IsValidOTP(req.Code) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "Code must be 6 digits")
		return
	}
	// Guess-rate control. A six-digit code is a million possibilities; without this it is minutes.
	if !h.allowOTPVerify(w, r, "email:"+schema.NormalizeEmail(req.Email)) {
		return
	}
	email := schema.NormalizeEmail(req.Email)

	if !h.mailer.Configured() {
		if !h.authIsDev() {
			writeError(w, http.StatusNotImplemented, schema.ErrInternal,
				"Email sign-in is not available right now. Please try again later.")
			return
		}
		if strings.TrimSpace(req.Code) != h.cfg.DevOTP {
			writeError(w, http.StatusUnauthorized, schema.ErrUnauthenticated,
				"That code isn't right. Please check and try again.")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"token": randomToken(), "email": email})
		return
	}

	switch err := h.otp.Verify(r.Context(), "email:"+email, strings.TrimSpace(req.Code)); {
	case err == nil:
		// Normalised, so "User@Example.com" and "user@example.com" are one account, not two.
		writeJSON(w, http.StatusOK, map[string]string{"token": randomToken(), "email": email})
	case errors.Is(err, otp.ErrNoCode):
		// Expired, already used, or never requested — all look the same to the user, and the fix is
		// the same, so say that rather than making them guess which.
		writeError(w, http.StatusUnauthorized, schema.ErrUnauthenticated,
			"That code has expired. Request a new one.")
	case errors.Is(err, otp.ErrTooManyAttempts):
		writeError(w, http.StatusUnauthorized, schema.ErrUnauthenticated,
			"Too many incorrect attempts. Request a new code.")
	default:
		// Say how many tries are left: it turns a dead end into a recoverable mistake, and it warns
		// a real user that someone else may be guessing at their account.
		remaining := h.otp.AttemptsRemaining(r.Context(), "email:"+email)
		msg := "That code isn't right. Please check and try again."
		if remaining == 1 {
			msg = "That code isn't right. One attempt left before you'll need a new code."
		} else if remaining > 1 {
			msg = fmt.Sprintf("That code isn't right. %d attempts left.", remaining)
		}
		writeError(w, http.StatusUnauthorized, schema.ErrUnauthenticated, msg)
	}
}

// --- Phone verification (KYC step 1) ---

type phoneOTPRequest struct {
	// Phone is full E.164, composed by the client from its country picker.
	Phone string `json:"phone"`
}

type phoneOTPVerify struct {
	Phone string `json:"phone"`
	Code  string `json:"code"`
}

func (h *handler) kycPhoneRequest(w http.ResponseWriter, r *http.Request) {
	var req phoneOTPRequest
	if !decodeAuthBody(w, r, &req) {
		return
	}
	// IsSupportedE164, not IsValidE164: a number outside the supported countries cannot receive a
	// code, so accepting it would strand the user mid-verification with no way forward.
	if !schema.IsSupportedE164(req.Phone) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest,
			"Enter a valid phone number for a supported country")
		return
	}
	// SMS costs real money per message — this limit is the bill.
	if !h.allowOTPRequest(w, r, "phone:"+strings.TrimSpace(req.Phone)) {
		return
	}
	if !h.authIsDev() {
		writeError(w, http.StatusNotImplemented, schema.ErrInternal, "SMS provider not configured")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "sent",
		"devCode": h.cfg.DevOTP,
	})
}

func (h *handler) kycPhoneVerify(w http.ResponseWriter, r *http.Request) {
	var req phoneOTPVerify
	if !decodeAuthBody(w, r, &req) {
		return
	}
	if !schema.IsSupportedE164(req.Phone) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest,
			"Enter a valid phone number for a supported country")
		return
	}
	if !schema.IsValidOTP(req.Code) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "Code must be 6 digits")
		return
	}
	if !h.allowOTPVerify(w, r, "phone:"+strings.TrimSpace(req.Phone)) {
		return
	}
	if !h.authIsDev() {
		writeError(w, http.StatusNotImplemented, schema.ErrInternal, "SMS provider not configured")
		return
	}
	if strings.TrimSpace(req.Code) != h.cfg.DevOTP {
		writeError(w, http.StatusUnauthorized, schema.ErrUnauthenticated, "Incorrect code")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "verified",
		"phone":  strings.TrimSpace(req.Phone),
	})
}

// GET /countries — the dialling countries the picker offers.
//
// Served from the same table the server validates against, so the app can never present a country
// whose numbers would then be rejected.
func (h *handler) listCountries(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"countries": schema.Countries,
		"default":   schema.DefaultCountry,
	})
}

func decodeAuthBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAuthBody)).Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "Invalid request")
		return false
	}
	return true
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
