package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prova/backend/internal/config"
	"github.com/prova/shared/schema"
)

/*
 * These routes were open.
 *
 * Anyone who knew or guessed a wallet identifier could read its verification status, submit a
 * verification against it, or ask for the credential issued to it — the credential being what the
 * circuit accepts as proof of KYC. The tests below are the regression guard: each names a route that
 * takes a `userId` and asserts it refuses an unauthenticated caller.
 *
 * `New(...)` here has no store, so an authenticated caller cannot get further than the account
 * lookup. That is deliberate — what matters is that the refusal happens BEFORE any work, and 401 is
 * distinguishable from the 503 a missing store produces.
 */

const walletID = "6cb3d3d9f5c126270f7f3bcc3cefe41b8d7bf95f19774b846221653cf52cc1e8"

func openHandler() http.Handler {
	return New(slog.Default(), config.Load(), Deps{Mailer: &stubMailer{}})
}

func TestWalletRoutesRefuseWithoutASession(t *testing.T) {
	h := openHandler()

	for name, tc := range map[string]struct {
		method, path, body string
	}{
		"read verification status": {
			http.MethodGet, "/kyc/verifications/" + walletID, "",
		},
		"start a verification": {
			http.MethodPost, "/kyc/verifications", `{"userId":"` + walletID + `","tier":2}`,
		},
		"collect the credential": {
			http.MethodPost, "/kyc/credential", `{"userId":"` + walletID + `"}`,
		},
		"renew the credential": {
			http.MethodPost, "/kyc/credential/renew", `{"userId":"` + walletID + `"}`,
		},
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 — this route is reachable without signing in", rec.Code)
			}
		})
	}
}

// A token that was never issued must not work, however well-formed it looks.
func TestWalletRoutesRefuseAnInventedToken(t *testing.T) {
	h := openHandler()

	for name, token := range map[string]string{
		"random":       "Bearer aGVsbG8td29ybGQtbm90LWEtcmVhbC10b2tlbg",
		"empty bearer": "Bearer ",
		"wrong scheme": "Basic aGVsbG8=",
		"no scheme":    "aGVsbG8=",
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/kyc/verifications/"+walletID, nil)
			req.Header.Set("Authorization", token)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
		})
	}
}

// Malformed identifiers must still be rejected as bad input, not treated as an auth problem — the
// caller needs to know which mistake they made.
func TestWalletRoutesStillValidateTheIdentifier(t *testing.T) {
	h := openHandler()
	req := httptest.NewRequest(http.MethodGet, "/kyc/verifications/not-a-wallet", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a malformed userId", rec.Code)
	}
}

// The refusal must be the shared unauthenticated code, so the app can tell "sign in again" apart
// from "you cannot do this".
func TestRefusalUsesTheUnauthenticatedCode(t *testing.T) {
	h := openHandler()
	req := httptest.NewRequest(http.MethodGet, "/kyc/verifications/"+walletID, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Code != string(schema.ErrUnauthenticated) {
		t.Errorf("code = %q, want %q", body.Code, schema.ErrUnauthenticated)
	}
}
