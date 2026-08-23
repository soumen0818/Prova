// Package session issues and resolves the bearer tokens that authenticate app requests.
//
// Before this existed, signing in returned a random string that was never written down, so every
// app-facing route trusted whatever identifier the caller sent. Anyone who learned or guessed a
// `userId` could read its verification status, start a verification against it, or ask for the
// credential issued to it. Nothing was stolen by that alone — money moves by proof, not by API call
// — but the KYC record is the one thing a regulator asks to see, and it was writable by anybody.
//
// The design mirrors internal/otp: Redis when it is there, an in-process map when it is not, so a
// single-container deployment works without an extra service.
package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// TTL is how long a sign-in lasts. Refreshed on every use, so an active user is never signed out
// mid-task and an abandoned device stops working within the month.
const TTL = 30 * 24 * time.Hour

// ErrNoSession means the token is unknown, expired, or was never issued here.
var ErrNoSession = errors.New("no such session")

// Store issues and resolves session tokens.
type Store struct {
	redis *redis.Client
	mem   *memStore
}

// New builds a store. A nil client falls back to in-process storage, which is correct for a single
// instance and loses every session on restart — acceptable, because signing in again is one email.
func New(rdb *redis.Client) *Store {
	return &Store{redis: rdb, mem: newMemStore()}
}

/*
 * Tokens are stored HASHED, never in the clear.
 *
 * The token is a bearer credential: whoever holds it is the user. Keeping the raw value would mean
 * a Redis dump, a log line, or a stray `KEYS *` hands over every live session. Hashing costs one
 * SHA-256 per request and makes the stored form useless on its own — the same reason the PIN is
 * kept as a verifier rather than a PIN.
 */
func key(token string) string {
	sum := sha256.Sum256([]byte(token))
	return "session:" + hex.EncodeToString(sum[:])
}

// Issue creates a session for an email and returns the token to hand back to the client.
func (s *Store) Issue(ctx context.Context, email string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	if s.redis != nil {
		if err := s.redis.Set(ctx, key(token), email, TTL).Err(); err == nil {
			return token, nil
		}
		// Fall through to memory: losing sign-in entirely because Redis blinked is worse than a
		// session that does not survive a restart.
	}
	s.mem.set(key(token), email, TTL)
	return token, nil
}

// Resolve returns the email a token belongs to, refreshing its expiry.
func (s *Store) Resolve(ctx context.Context, token string) (string, error) {
	if token == "" {
		return "", ErrNoSession
	}
	k := key(token)

	if s.redis != nil {
		email, err := s.redis.Get(ctx, k).Result()
		if err == nil {
			// Sliding expiry: someone using the app daily is never logged out, while an abandoned
			// token still ages away.
			s.redis.Expire(ctx, k, TTL)
			return email, nil
		}
		if !errors.Is(err, redis.Nil) {
			// Redis is unreachable rather than empty. Fall through and try memory rather than
			// signing everybody out.
			if email, ok := s.mem.get(k); ok {
				return email, nil
			}
			return "", err
		}
	}

	if email, ok := s.mem.get(k); ok {
		return email, nil
	}
	return "", ErrNoSession
}

// Revoke ends a session — sign-out, and the natural response to a token that looks compromised.
func (s *Store) Revoke(ctx context.Context, token string) {
	if token == "" {
		return
	}
	k := key(token)
	if s.redis != nil {
		s.redis.Del(ctx, k)
	}
	s.mem.del(k)
}

// BearerToken pulls the token out of an Authorization header.
//
// Tolerant of case because the scheme is case-insensitive per RFC 7235, and a client that sends
// "bearer" is not wrong — it should not fail authentication for it.
func BearerToken(header string) string {
	const prefix = "bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}

// --- in-process fallback -----------------------------------------------------

type memEntry struct {
	email   string
	expires time.Time
}

type memStore struct {
	mu sync.Mutex
	m  map[string]memEntry
}

func newMemStore() *memStore { return &memStore{m: make(map[string]memEntry)} }

func (m *memStore) set(k, email string, ttl time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.m[k] = memEntry{email: email, expires: time.Now().Add(ttl)}
}

func (m *memStore) get(k string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.m[k]
	if !ok {
		return "", false
	}
	if time.Now().After(e.expires) {
		// Expiry is enforced on read; there is no sweeper because the map only holds live sessions
		// for one process and is discarded on restart.
		delete(m.m, k)
		return "", false
	}
	// Sliding expiry, matching the Redis path.
	e.expires = time.Now().Add(TTL)
	m.m[k] = e
	return e.email, true
}

func (m *memStore) del(k string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.m, k)
}
