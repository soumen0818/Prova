// Package otp issues and verifies one-time codes.
//
// # What a real code store has to get right
//
// The development stub compared against a constant. A code that actually protects an account needs
// five properties, and missing any one of them makes the rest close to worthless:
//
//   - **Unpredictable** — generated with crypto/rand. `math/rand` seeded by time is guessable, and
//     that alone would defeat the whole mechanism.
//   - **Stored hashed** — a leaked Redis dump must not reveal live codes. They are short-lived, but
//     "short-lived" is not a substitute for "not readable".
//   - **Expiring** — 10 minutes. A code that lives forever is a password with six digits.
//   - **Attempt-capped** — five wrong guesses burns the code. Rate limiting slows an attacker down;
//     this stops them, because the target they are guessing at ceases to exist.
//   - **Single-use** — consumed on success, so a code observed in transit cannot be replayed.
//
// Comparison is constant-time. The timing signal from `==` on a six-digit string is small, but it is
// free to remove and awkward to explain to an auditor.
//
// Redis when available so codes survive a restart and work across replicas; an in-process fallback
// otherwise, which is correct for a single instance and honest about its limits.
package otp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	// Digits in a code. Six is the familiar length; the attempt cap, not the length, is what makes
	// guessing hopeless.
	Digits = 6
	// TTL is how long a code stays valid.
	TTL = 10 * time.Minute
	// MaxAttempts is how many wrong guesses a single code tolerates before it is destroyed.
	MaxAttempts = 5
)

var (
	// ErrNoCode means nothing was issued, or it expired, or it was already used or burned.
	ErrNoCode = errors.New("no active code")
	// ErrIncorrect means the code was wrong but attempts remain.
	ErrIncorrect = errors.New("incorrect code")
	// ErrTooManyAttempts means the code was destroyed by repeated failures. A new one is required.
	ErrTooManyAttempts = errors.New("too many attempts")
)

// Store issues and verifies codes.
type Store struct {
	redis *redis.Client
	mem   *memStore
}

// New builds a store. A nil client falls back to in-process storage.
func New(rdb *redis.Client) *Store {
	return &Store{redis: rdb, mem: newMemStore()}
}

// record is what is persisted: the code's hash and how many guesses remain.
type record struct {
	hash     string
	attempts int
}

func (r record) encode() string {
	return r.hash + ":" + strconv.Itoa(r.attempts)
}

func decodeRecord(s string) (record, bool) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return record{}, false
	}
	n, err := strconv.Atoi(parts[1])
	if err != nil {
		return record{}, false
	}
	return record{hash: parts[0], attempts: n}, true
}

// hashCode binds the digest to the identifier, so a code issued for one address cannot be replayed
// against another even if both happen to be the same six digits.
func hashCode(key, code string) string {
	sum := sha256.Sum256([]byte(key + "\x00" + code))
	return hex.EncodeToString(sum[:])
}

// Generate returns a cryptographically random code.
//
// `rand.Int` over the exact range rather than `n % 1000000`: the modulo version biases the low end
// of the range, which shrinks the search space an attacker faces.
func Generate() (string, error) {
	max := big.NewInt(1)
	for i := 0; i < Digits; i++ {
		max.Mul(max, big.NewInt(10))
	}
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		return "", fmt.Errorf("generate code: %w", err)
	}
	return fmt.Sprintf("%0*d", Digits, n), nil
}

// Issue creates a code for `key` and stores it.
//
// A new code replaces any previous one for the same key, so "resend" cannot leave two valid codes in
// flight — which would otherwise double an attacker's chances for free.
func (s *Store) Issue(ctx context.Context, key string) (string, error) {
	code, err := Generate()
	if err != nil {
		return "", err
	}
	rec := record{hash: hashCode(key, code), attempts: MaxAttempts}

	if s.redis != nil {
		if err := s.redis.Set(ctx, "otp:"+key, rec.encode(), TTL).Err(); err == nil {
			return code, nil
		}
		// Redis is unreachable — fall through to memory rather than failing the sign-in entirely.
	}
	s.mem.set("otp:"+key, rec, TTL)
	return code, nil
}

// Verify checks `code` against the stored record and consumes it on success.
//
// Returns ErrNoCode, ErrIncorrect, or ErrTooManyAttempts. A wrong guess decrements the remaining
// attempts; exhausting them destroys the code, so an attacker cannot keep guessing at the same
// target indefinitely no matter how patiently they pace themselves around the rate limiter.
func (s *Store) Verify(ctx context.Context, key, code string) error {
	full := "otp:" + key

	raw, ok := s.load(ctx, full)
	if !ok {
		return ErrNoCode
	}
	rec, ok := decodeRecord(raw)
	if !ok {
		s.del(ctx, full)
		return ErrNoCode
	}

	if subtle.ConstantTimeCompare([]byte(rec.hash), []byte(hashCode(key, code))) == 1 {
		// Single-use: consume it so an observed code cannot be replayed.
		s.del(ctx, full)
		return nil
	}

	rec.attempts--
	if rec.attempts <= 0 {
		s.del(ctx, full)
		return ErrTooManyAttempts
	}
	s.store(ctx, full, rec)
	return ErrIncorrect
}

// AttemptsRemaining reports how many guesses are left, for messaging. Zero when there is no code.
func (s *Store) AttemptsRemaining(ctx context.Context, key string) int {
	raw, ok := s.load(ctx, "otp:"+key)
	if !ok {
		return 0
	}
	rec, ok := decodeRecord(raw)
	if !ok {
		return 0
	}
	return rec.attempts
}

func (s *Store) load(ctx context.Context, key string) (string, bool) {
	if s.redis != nil {
		v, err := s.redis.Get(ctx, key).Result()
		if err == nil {
			return v, true
		}
		if !errors.Is(err, redis.Nil) {
			// Connection problem rather than a miss — check memory before giving up.
			if rec, ok := s.mem.get(key); ok {
				return rec.encode(), true
			}
		}
		return "", false
	}
	rec, ok := s.mem.get(key)
	if !ok {
		return "", false
	}
	return rec.encode(), true
}

// store rewrites a record while preserving its original expiry — a wrong guess must not extend the
// code's life, which would let an attacker keep one alive indefinitely.
func (s *Store) store(ctx context.Context, key string, rec record) {
	if s.redis != nil {
		if err := s.redis.Set(ctx, key, rec.encode(), redis.KeepTTL).Err(); err == nil {
			return
		}
	}
	s.mem.update(key, rec)
}

func (s *Store) del(ctx context.Context, key string) {
	if s.redis != nil {
		_ = s.redis.Del(ctx, key).Err()
	}
	s.mem.del(key)
}

// --- in-process fallback ---

type memEntry struct {
	rec       record
	expiresAt time.Time
}

type memStore struct {
	mu     sync.Mutex
	items  map[string]memEntry
	lastGC time.Time
}

func newMemStore() *memStore {
	return &memStore{items: make(map[string]memEntry), lastGC: time.Now()}
}

func (m *memStore) set(key string, rec record, ttl time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gc()
	m.items[key] = memEntry{rec: rec, expiresAt: time.Now().Add(ttl)}
}

// update preserves the existing expiry.
func (m *memStore) update(key string, rec record) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.items[key]; ok {
		m.items[key] = memEntry{rec: rec, expiresAt: e.expiresAt}
	}
}

func (m *memStore) get(key string) (record, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.items[key]
	if !ok || time.Now().After(e.expiresAt) {
		return record{}, false
	}
	return e.rec, true
}

func (m *memStore) del(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.items, key)
}

// gc drops expired entries, at most once a minute, so a long-lived process cannot accumulate one
// entry per address it has ever seen.
func (m *memStore) gc() {
	now := time.Now()
	if now.Sub(m.lastGC) < time.Minute {
		return
	}
	m.lastGC = now
	for k, e := range m.items {
		if now.After(e.expiresAt) {
			delete(m.items, k)
		}
	}
}
