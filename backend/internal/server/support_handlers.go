package server

// In-app support conversations.
//
// Two audiences share one thread: the app writes as "user" and the operator console writes as
// "team". The console's routes are gated by COMPLIANCE_TOKEN, the same secret that gates a KYC
// decision — the console is one application and there is one operator behind it.
//
// The app's own routes are NOT token-gated, because the app has no token to send. They are addressed
// by the opaque userId, which means anyone who learns a userId could read that conversation. That is
// the same exposure the existing verification-status route already carries, and it is recorded here
// rather than hidden: the fix is session-bound auth for user-facing reads, which is a change to make
// across all of them at once rather than inventing a second scheme for this one endpoint.

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prova/backend/internal/store"
	"github.com/prova/shared/schema"
)

const maxSupportBody = 1 << 16

// supportThread returns a user's conversation (GET /support/threads/{userId}).
//
// `after` is a message id cursor so the app can poll for replies without re-downloading a
// conversation the user is currently reading.
func (h *handler) supportThread(w http.ResponseWriter, r *http.Request) {
	st := h.store
	if st == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "support unavailable")
		return
	}
	userID := r.PathValue("userId")
	if !schema.IsValidUserID(userID) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest,
			"userId must be a 32-byte hex wallet identifier")
		return
	}
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)

	msgs, err := st.SupportMessages(r.Context(), userID, after, 200)
	if err != nil {
		h.logger.Error("support messages read failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not load messages")
		return
	}

	// A user who has never written in has no thread row. That is not an error — it is an empty
	// conversation, and the app should open on the greeting rather than on a failure.
	view := schema.SupportThreadView{UserID: userID, Status: "open", Messages: toSupportMessages(msgs)}
	if thread, err := st.GetSupportThread(r.Context(), userID); err == nil {
		view.Status = thread.Status
		view.Unread = thread.UnreadCount
	} else if !errors.Is(err, store.ErrThreadNotFound) {
		h.logger.Error("support thread read failed", "err", err)
	}
	writeJSON(w, http.StatusOK, view)
}

// sendSupportMessage posts a message from the app (POST /support/threads/{userId}/messages).
func (h *handler) sendSupportMessage(w http.ResponseWriter, r *http.Request) {
	h.appendSupport(w, r, schema.AuthorUser)
}

// replySupportMessage posts a reply from the team (POST /ops/support/threads/{userId}/messages).
func (h *handler) replySupportMessage(w http.ResponseWriter, r *http.Request) {
	if !h.validComplianceToken(r.Header.Get("Authorization")) {
		writeError(w, http.StatusUnauthorized, schema.ErrInternal, "missing or invalid compliance token")
		return
	}
	h.appendSupport(w, r, schema.AuthorTeam)
}

func (h *handler) appendSupport(w http.ResponseWriter, r *http.Request, author string) {
	st := h.store
	if st == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "support unavailable")
		return
	}
	userID := r.PathValue("userId")
	if !schema.IsValidUserID(userID) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest,
			"userId must be a 32-byte hex wallet identifier")
		return
	}
	var req schema.SendSupportMessageRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxSupportBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "invalid JSON body")
		return
	}
	body := strings.TrimSpace(req.Body)
	if body == "" {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "message body is required")
		return
	}
	// Counted in runes, not bytes: the limit is about how much someone can type, and a message in
	// Hindi or Malayalam must not be cut shorter than the same message in English.
	if len([]rune(body)) > schema.MaxSupportBodyChars {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "message is too long")
		return
	}

	msg, err := st.AppendSupportMessage(r.Context(), userID, author, body)
	if err != nil {
		h.logger.Error("support message write failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not send message")
		return
	}
	writeJSON(w, http.StatusCreated, toSupportMessage(*msg))
}

// listSupportThreads is the operator inbox (GET /ops/support/threads).
func (h *handler) listSupportThreads(w http.ResponseWriter, r *http.Request) {
	if !h.validComplianceToken(r.Header.Get("Authorization")) {
		writeError(w, http.StatusUnauthorized, schema.ErrInternal, "missing or invalid compliance token")
		return
	}
	st := h.store
	if st == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "support unavailable")
		return
	}
	status := r.URL.Query().Get("status")
	if status != "" && status != "open" && status != "closed" {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, `status must be "open" or "closed"`)
		return
	}
	threads, err := st.SupportThreads(r.Context(), status, 100)
	if err != nil {
		h.logger.Error("support inbox read failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not load inbox")
		return
	}

	out := make([]schema.SupportThreadRecord, 0, len(threads))
	for _, t := range threads {
		out = append(out, schema.SupportThreadRecord{
			UserID:        t.UserID,
			Status:        t.Status,
			Unread:        t.UnreadCount,
			LastMessage:   t.LastMessage,
			LastAuthor:    t.LastAuthor,
			LastMessageAt: t.LastMessageAt.UTC().Format(time.RFC3339),
			CreatedAt:     t.CreatedAt.UTC().Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// opsSupportThread reads one conversation for the console (GET /ops/support/threads/{userId}).
//
// Opening a thread marks it read, which is what an operator means by opening it. Read state is a
// convenience for the person working the queue, not a record of anything, so it is safe to move it
// on a GET.
func (h *handler) opsSupportThread(w http.ResponseWriter, r *http.Request) {
	if !h.validComplianceToken(r.Header.Get("Authorization")) {
		writeError(w, http.StatusUnauthorized, schema.ErrInternal, "missing or invalid compliance token")
		return
	}
	st := h.store
	if st == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "support unavailable")
		return
	}
	userID := r.PathValue("userId")
	if !schema.IsValidUserID(userID) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest,
			"userId must be a 32-byte hex wallet identifier")
		return
	}
	msgs, err := st.SupportMessages(r.Context(), userID, 0, 200)
	if err != nil {
		h.logger.Error("support messages read failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not load messages")
		return
	}
	if err := st.MarkSupportThreadRead(r.Context(), userID); err != nil {
		// Losing the badge update is cosmetic; refusing to show the conversation is not.
		h.logger.Warn("could not clear support unread badge", "err", err)
	}

	view := schema.SupportThreadView{UserID: userID, Status: "open", Messages: toSupportMessages(msgs)}
	if thread, err := st.GetSupportThread(r.Context(), userID); err == nil {
		view.Status = thread.Status
	}
	writeJSON(w, http.StatusOK, view)
}

// setSupportThreadStatus files a thread (POST /ops/support/threads/{userId}/status).
func (h *handler) setSupportThreadStatus(w http.ResponseWriter, r *http.Request) {
	if !h.validComplianceToken(r.Header.Get("Authorization")) {
		writeError(w, http.StatusUnauthorized, schema.ErrInternal, "missing or invalid compliance token")
		return
	}
	st := h.store
	if st == nil {
		writeError(w, http.StatusServiceUnavailable, schema.ErrInternal, "support unavailable")
		return
	}
	userID := r.PathValue("userId")
	if !schema.IsValidUserID(userID) {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest,
			"userId must be a 32-byte hex wallet identifier")
		return
	}
	var req struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxSupportBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, "invalid JSON body")
		return
	}
	if req.Status != "open" && req.Status != "closed" {
		writeError(w, http.StatusBadRequest, schema.ErrBadRequest, `status must be "open" or "closed"`)
		return
	}
	if err := st.SetSupportThreadStatus(r.Context(), userID, req.Status); err != nil {
		if errors.Is(err, store.ErrThreadNotFound) {
			writeError(w, http.StatusNotFound, schema.ErrBadRequest, "no conversation for this user")
			return
		}
		h.logger.Error("support status write failed", "err", err)
		writeError(w, http.StatusInternalServerError, schema.ErrInternal, "could not update conversation")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func toSupportMessage(m store.SupportMessage) schema.SupportMessage {
	return schema.SupportMessage{
		ID:     m.ID,
		Author: m.Author,
		Body:   m.Body,
		SentAt: m.CreatedAt.UTC().Format(time.RFC3339),
	}
}

func toSupportMessages(in []store.SupportMessage) []schema.SupportMessage {
	// Non-nil so an empty conversation marshals as [] rather than null.
	out := make([]schema.SupportMessage, 0, len(in))
	for _, m := range in {
		out = append(out, toSupportMessage(m))
	}
	return out
}
