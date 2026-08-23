package server

import (
	"errors"
	"net/http"

	"github.com/prova/backend/internal/session"
	"github.com/prova/backend/internal/store"
	"github.com/prova/shared/schema"
)

/*
 * Who is calling, and may they act on this wallet?
 *
 * Every app-facing route used to answer "whoever says so". A caller supplied a `userId` and the
 * server took its word: the verification status of any wallet could be read, a verification could be
 * started against one, and the credential issued to it could be requested — by anyone who knew or
 * guessed the identifier. Money was never at risk from that (a spend needs a proof, not an API
 * call), but the KYC record is the one artefact a regulator asks to see, and it was writable by
 * strangers.
 *
 * Two checks, deliberately separate, because they answer different questions:
 *
 *   callerEmail  — is there a live session? (authentication)
 *   ownsWallet   — does that session own the wallet being named? (authorisation)
 *
 * Routes that name no wallet need only the first.
 */

// callerEmail resolves the bearer token to an account, writing a 401 and returning false if it
// cannot. The email is normalised at sign-in, so it is safe to compare directly.
func (h *handler) callerEmail(w http.ResponseWriter, r *http.Request) (string, bool) {
	token := session.BearerToken(r.Header.Get("Authorization"))
	email, err := h.sessions.Resolve(r.Context(), token)
	if err != nil {
		// One message for missing, malformed and expired alike: the fix is the same (sign in
		// again), and distinguishing them would tell an attacker which tokens once existed.
		writeError(w, http.StatusUnauthorized, schema.ErrUnauthenticated, "Please sign in again.")
		return "", false
	}
	return email, true
}

// ownsWallet authenticates the caller and confirms the wallet is theirs, claiming it if it is
// unclaimed. Returns false having already written the response.
//
// The claim is trust-on-first-use: the app cannot prove it holds the key behind the identifier, so
// the first account to present one takes it. What that prevents is the case that matters — a second
// party acting on a wallet somebody is already using.
func (h *handler) ownsWallet(w http.ResponseWriter, r *http.Request, userID string) (string, bool) {
	email, ok := h.callerEmail(w, r)
	if !ok {
		return "", false
	}
	// No accounts table (Postgres unavailable) means the binding cannot be checked. Fail closed:
	// serving these routes unauthenticated is exactly the state this code exists to end.
	if h.store == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "accounts unavailable")
		return "", false
	}

	switch err := h.store.ClaimWallet(r.Context(), email, userID); {
	case err == nil:
		return email, true
	case errors.Is(err, store.ErrWalletClaimed):
		// Deliberately 403 and not 404: the caller is authenticated, and pretending the wallet does
		// not exist would be a lie they could disprove. It says "not yours", not "no such thing".
		writeError(w, http.StatusForbidden, schema.ErrUnauthenticated,
			"This wallet belongs to a different account.")
		return "", false
	default:
		h.logger.Error("wallet claim failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not verify the wallet")
		return "", false
	}
}
