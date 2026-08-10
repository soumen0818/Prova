package store

// Support-conversation persistence (migration 0004).
//
// One thread per user, keyed by the same opaque `userId` the KYC tables use. Message bodies are the
// only free text this system stores in the clear, and that is deliberate: a support reply has to be
// readable by the person answering it.

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrThreadNotFound is returned when a user has never opened a conversation.
var ErrThreadNotFound = errors.New("support thread not found")

// SupportThread is one user's conversation with the team.
type SupportThread struct {
	UserID        string
	Status        string
	UnreadCount   int
	LastMessageAt time.Time
	CreatedAt     time.Time
	// LastMessage is the most recent body, for the inbox preview. Empty on an empty thread.
	LastMessage string
	// LastAuthor says who spoke last, which is what tells an operator whether a reply is owed.
	LastAuthor string
}

// SupportMessage is one entry in a conversation.
type SupportMessage struct {
	ID        int64
	UserID    string
	Author    string // "user" | "team"
	Body      string
	CreatedAt time.Time
}

// Message authors.
const (
	SupportAuthorUser = "user"
	SupportAuthorTeam = "team"
)

// AppendSupportMessage records a message, creating the thread on first contact.
//
// A user message raises the unread count; a team reply clears it and reopens nothing — the thread is
// already the right place. Done in one transaction so the inbox can never show a thread whose
// preview disagrees with its messages.
func (s *Store) AppendSupportMessage(ctx context.Context, userID, author, body string) (*SupportMessage, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	unreadDelta := 0
	if author == SupportAuthorUser {
		unreadDelta = 1
	}
	// A user writing in reopens a thread the team had filed away; a team reply marks it read.
	status := "open"
	if _, err := tx.Exec(ctx, `
INSERT INTO support_threads (user_id, last_message_at, unread_count, status)
VALUES ($1, now(), $2, $3)
ON CONFLICT (user_id) DO UPDATE SET
    last_message_at = now(),
    unread_count = CASE WHEN $2 > 0 THEN support_threads.unread_count + $2 ELSE 0 END,
    status = $3`,
		userID, unreadDelta, status); err != nil {
		return nil, err
	}

	var m SupportMessage
	if err := tx.QueryRow(ctx, `
INSERT INTO support_messages (user_id, author, body)
VALUES ($1, $2, $3)
RETURNING id, user_id, author, body, created_at`,
		userID, author, body).Scan(&m.ID, &m.UserID, &m.Author, &m.Body, &m.CreatedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &m, nil
}

// SupportMessages returns a conversation in order, oldest first, for messages after `afterID`.
//
// Pass 0 to read the whole thread. The cursor exists so the app can poll for new replies without
// re-downloading (and re-rendering) a conversation the user is reading.
func (s *Store) SupportMessages(ctx context.Context, userID string, afterID int64, limit int) ([]SupportMessage, error) {
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	rows, err := s.pool.Query(ctx, `
SELECT id, user_id, author, body, created_at
FROM support_messages
WHERE user_id = $1 AND id > $2
ORDER BY id
LIMIT $3`, userID, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Non-nil so an empty conversation marshals as [] rather than null — a null here has crashed
	// the app's list rendering before.
	out := []SupportMessage{}
	for rows.Next() {
		var m SupportMessage
		if err := rows.Scan(&m.ID, &m.UserID, &m.Author, &m.Body, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// SupportThreads lists conversations for the operator inbox, most recently active first.
func (s *Store) SupportThreads(ctx context.Context, status string, limit int) ([]SupportThread, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	// The lateral join fetches each thread's newest message for the preview, which keeps the inbox
	// one query instead of one per row.
	rows, err := s.pool.Query(ctx, `
SELECT t.user_id, t.status, t.unread_count, t.last_message_at, t.created_at,
       COALESCE(m.body, ''), COALESCE(m.author, '')
FROM support_threads t
LEFT JOIN LATERAL (
    SELECT body, author FROM support_messages
    WHERE user_id = t.user_id ORDER BY id DESC LIMIT 1
) m ON true
WHERE ($1 = '' OR t.status = $1)
ORDER BY t.last_message_at DESC
LIMIT $2`, status, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []SupportThread{}
	for rows.Next() {
		var t SupportThread
		if err := rows.Scan(&t.UserID, &t.Status, &t.UnreadCount, &t.LastMessageAt, &t.CreatedAt,
			&t.LastMessage, &t.LastAuthor); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetSupportThread fetches one thread's header.
func (s *Store) GetSupportThread(ctx context.Context, userID string) (*SupportThread, error) {
	var t SupportThread
	err := s.pool.QueryRow(ctx, `
SELECT user_id, status, unread_count, last_message_at, created_at
FROM support_threads WHERE user_id = $1`, userID).
		Scan(&t.UserID, &t.Status, &t.UnreadCount, &t.LastMessageAt, &t.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrThreadNotFound
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// SetSupportThreadStatus files a thread as open or closed.
func (s *Store) SetSupportThreadStatus(ctx context.Context, userID, status string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE support_threads SET status = $2 WHERE user_id = $1`, userID, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrThreadNotFound
	}
	return nil
}

// MarkSupportThreadRead clears the team's unread badge without sending a reply.
func (s *Store) MarkSupportThreadRead(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE support_threads SET unread_count = 0 WHERE user_id = $1`, userID)
	return err
}
