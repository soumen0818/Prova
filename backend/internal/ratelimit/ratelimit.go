// Package ratelimit throttles abusive callers.
//
// # Why this is not optional
//
// Every endpoint here is unauthenticated by design — there is no session before sign-in, and the
// pool endpoints deliberately need none. Without a limiter:
//
//   - one script can burn an entire SMS or email budget in minutes, and that is a real bill;
//   - a six-digit code can be brute-forced in ~1M requests, which is hours, not centuries;
//   - `/pool/notes` and `/pool/path` each rebuild a Merkle tree, so they are cheap to request and
//     expensive to serve — a classic amplification target.
//
// # Two controls, because they stop different things
//
//   - **Quota** (N per window) bounds total volume.
//   - **Cooldown** (a minimum gap between attempts for the same identifier) stops the rapid bursts
//     that quota alone permits, and is what actually makes code-guessing impractical.
//
// # Storage
//
// Redis when available, so the limit holds across every replica. When it is not, an in-process
// fallback keeps a per-instance limit rather than failing open — a security control that silently
// disables itself when a dependency wobbles is worse than no control, because nobody notices.
package ratelimit

import (
	"context"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Rule is a quota: at most Limit requests per Window.
type Rule struct {
	Limit  int
	Window time.Duration
}

// Decision is the outcome of one check.
type Decision struct {
	Allowed bool
	// Remaining requests in the current window (never negative).
	Remaining int
	// RetryAfter is how long until the caller may try again. Zero when allowed.
	RetryAfter time.Duration
	// Limit and Window echo the rule, for the response headers.
	Limit  int
	Window time.Duration
}

// Limiter enforces quotas and cooldowns.
type Limiter struct {
	redis *redis.Client
	mem   *memoryStore
}

// New builds a limiter. A nil client falls back to in-process counters.
func New(rdb *redis.Client) *Limiter {
	return &Limiter{redis: rdb, mem: newMemoryStore()}
}

// Allow consumes one unit of `key`'s quota.
//
// Fixed-window counting: cheap, and one round trip. The known trade-off is that a caller can send up
// to 2×Limit across a window boundary. That is acceptable here because the cooldown below is what
// actually bounds attempt *rate* — the quota only bounds volume.
func (l *Limiter) Allow(ctx context.Context, key string, rule Rule) Decision {
	dec := Decision{Limit: rule.Limit, Window: rule.Window}

	count, ttl, err := l.incr(ctx, "rl:"+key, rule.Window)
	if err != nil {
		// Redis failed. Fall back to the in-process counter rather than allowing everything: a
		// degraded limit is still a limit, and failing open here is how budgets get drained.
		count, ttl = l.mem.incr("rl:"+key, rule.Window)
	}

	dec.Remaining = rule.Limit - count
	if dec.Remaining < 0 {
		dec.Remaining = 0
	}
	if count > rule.Limit {
		dec.Allowed = false
		dec.RetryAfter = ttl
		return dec
	}
	dec.Allowed = true
	return dec
}

// Cooldown enforces a minimum gap between attempts for the same identifier.
//
// This is the control that makes guessing a six-digit code impractical: a quota of 10/hour still
// permits ten guesses back-to-back, while a 30-second gap turns any meaningful search into days and
// gives monitoring time to notice.
//
// Returns the remaining wait, or zero if the caller may proceed.
func (l *Limiter) Cooldown(ctx context.Context, key string, every time.Duration) time.Duration {
	full := "cd:" + key

	ok, ttl, err := l.setNX(ctx, full, every)
	if err != nil {
		ok, ttl = l.mem.setNX(full, every)
	}
	if ok {
		return 0
	}
	if ttl <= 0 {
		// The key exists but its TTL is unknown; ask for the full interval rather than letting the
		// caller straight through.
		return every
	}
	return ttl
}

// incr bumps a counter and returns its value plus the window's remaining TTL.
func (l *Limiter) incr(ctx context.Context, key string, window time.Duration) (int, time.Duration, error) {
	if l.redis == nil {
		return 0, 0, errNoRedis
	}
	pipe := l.redis.TxPipeline()
	n := pipe.Incr(ctx, key)
	// NX so a long-running window is not extended by later requests inside it — otherwise a steady
	// stream of traffic would keep pushing the reset out and the window would never close.
	pipe.ExpireNX(ctx, key, window)
	ttl := pipe.TTL(ctx, key)
	if _, err := pipe.Exec(ctx); err != nil {
		return 0, 0, err
	}
	return int(n.Val()), ttl.Val(), nil
}

// setNX claims a cooldown slot, reporting whether it was free and how long until it is.
func (l *Limiter) setNX(ctx context.Context, key string, ttl time.Duration) (bool, time.Duration, error) {
	if l.redis == nil {
		return false, 0, errNoRedis
	}
	ok, err := l.redis.SetNX(ctx, key, "1", ttl).Result()
	if err != nil {
		return false, 0, err
	}
	if ok {
		return true, 0, nil
	}
	remaining, err := l.redis.TTL(ctx, key).Result()
	if err != nil {
		return false, 0, err
	}
	return false, remaining, nil
}

type noRedisError struct{}

func (noRedisError) Error() string { return "redis unavailable" }

var errNoRedis = noRedisError{}

// --- in-process fallback ---

type entry struct {
	count     int
	expiresAt time.Time
}

type memoryStore struct {
	mu     sync.Mutex
	items  map[string]*entry
	lastGC time.Time
}

func newMemoryStore() *memoryStore {
	return &memoryStore{items: make(map[string]*entry), lastGC: time.Now()}
}

func (m *memoryStore) incr(key string, window time.Duration) (int, time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gc()

	now := time.Now()
	e, ok := m.items[key]
	if !ok || now.After(e.expiresAt) {
		e = &entry{expiresAt: now.Add(window)}
		m.items[key] = e
	}
	e.count++
	return e.count, time.Until(e.expiresAt)
}

func (m *memoryStore) setNX(key string, ttl time.Duration) (bool, time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gc()

	now := time.Now()
	if e, ok := m.items[key]; ok && now.Before(e.expiresAt) {
		return false, time.Until(e.expiresAt)
	}
	m.items[key] = &entry{count: 1, expiresAt: now.Add(ttl)}
	return true, 0
}

// gc drops expired entries. Called under the lock, at most once a minute, so a long-lived process
// cannot accumulate a key per address it has ever seen — that would be a slow memory leak an
// attacker could drive deliberately.
func (m *memoryStore) gc() {
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
