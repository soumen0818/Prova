package server

import (
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/prova/backend/internal/ratelimit"
	"github.com/prova/shared/schema"
)

// Rate limits.
//
// Every endpoint is unauthenticated by design, so these are the only thing standing between a script
// and the SMS bill, the code space, or the CPU spent rebuilding Merkle trees.
//
// Two layers, because they stop different attacks:
//
//   - **Per-IP**, applied to everything: a blunt ceiling on one source.
//   - **Per-identifier**, on the OTP paths: an attacker rotating IPs still cannot hammer one
//     address, and a legitimate user on a shared NAT is not punished for their neighbours.
//
// The numbers below are deliberately generous for humans and hostile to scripts. A real person
// requests a code once, maybe twice; a hundred requests an hour from one IP is not a person.
var (
	// globalIPRule is the blunt ceiling on any single source across all endpoints.
	globalIPRule = ratelimit.Rule{Limit: 300, Window: time.Minute}

	// otpRequestIPRule bounds how many codes one source can trigger. This is the SMS/email bill.
	otpRequestIPRule = ratelimit.Rule{Limit: 20, Window: time.Hour}

	// otpRequestIDRule bounds codes sent to a single address or number. Low on purpose: nobody
	// legitimately needs six codes an hour, and each one costs money and annoys the recipient.
	otpRequestIDRule = ratelimit.Rule{Limit: 5, Window: time.Hour}

	// otpRequestCooldown is the gap between codes for one identifier. Stops "resend" being a
	// hammer, and gives the first code time to actually arrive.
	otpRequestCooldown = 60 * time.Second

	// otpVerifyIDRule caps guesses against one identifier. A six-digit code has a million
	// possibilities; ten tries an hour makes exhaustive search take roughly eleven years.
	otpVerifyIDRule = ratelimit.Rule{Limit: 10, Window: time.Hour}

	// otpVerifyCooldown is the gap between guesses. This is what makes brute force impractical
	// even inside a single window — the quota alone would permit ten back-to-back attempts.
	otpVerifyCooldown = 2 * time.Second

	// poolReadRule protects the endpoints that rebuild a Merkle tree per request: cheap to ask for,
	// expensive to serve, and therefore a natural amplification target.
	poolReadRule = ratelimit.Rule{Limit: 120, Window: time.Minute}
)

// clientIP resolves the caller's address.
//
// X-Forwarded-For is honoured only when the deployment says it is behind a proxy. Trusting it
// unconditionally would make every limit here bypassable with one header, which is the standard way
// IP rate limiting is defeated.
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			// Left-most entry is the original client; the rest are proxies.
			for i := 0; i < len(fwd); i++ {
				if fwd[i] == ',' {
					return trimSpace(fwd[:i])
				}
			}
			return trimSpace(fwd)
		}
		if real := r.Header.Get("X-Real-IP"); real != "" {
			return trimSpace(real)
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

// writeRateLimitHeaders advertises the caller's budget.
//
// Field names follow the IETF `RateLimit-*` draft, which is what well-behaved clients look for so
// they can back off before being blocked rather than after.
func writeRateLimitHeaders(w http.ResponseWriter, d ratelimit.Decision) {
	w.Header().Set("RateLimit-Limit", strconv.Itoa(d.Limit))
	w.Header().Set("RateLimit-Remaining", strconv.Itoa(d.Remaining))
	w.Header().Set("RateLimit-Reset", strconv.Itoa(int(d.Window.Seconds())))
}

// tooManyRequests refuses a call and tells the caller when to come back.
func tooManyRequests(w http.ResponseWriter, retryAfter time.Duration, message string) {
	if retryAfter < time.Second {
		retryAfter = time.Second
	}
	w.Header().Set("Retry-After", strconv.Itoa(int(retryAfter.Seconds())))
	writeError(w, http.StatusTooManyRequests, schema.ErrRateLimited, message)
}

// limitByIP is the global middleware: a ceiling on any single source, applied to every route.
func (h *handler) limitByIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Health checks are exempt: load balancers poll them constantly, and rate-limiting a
		// liveness probe is how a healthy service gets taken out of rotation.
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			next.ServeHTTP(w, r)
			return
		}

		ip := clientIP(r, h.cfg.TrustProxyHeaders)
		d := h.limiter.Allow(r.Context(), "ip:"+ip, globalIPRule)
		writeRateLimitHeaders(w, d)
		if !d.Allowed {
			h.logger.Warn("rate limited", "ip", ip, "path", r.URL.Path)
			tooManyRequests(w, d.RetryAfter, "Too many requests. Please slow down.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// allowOTPRequest gates sending a code: per-IP volume, per-identifier volume, and a cooldown.
//
// `identifier` is the email address or phone number. Returns false once a response has been written.
func (h *handler) allowOTPRequest(w http.ResponseWriter, r *http.Request, identifier string) bool {
	ip := clientIP(r, h.cfg.TrustProxyHeaders)

	if d := h.limiter.Allow(r.Context(), "otpreq:ip:"+ip, otpRequestIPRule); !d.Allowed {
		h.logger.Warn("otp request rate limited by ip", "ip", ip)
		tooManyRequests(w, d.RetryAfter, "Too many codes requested. Try again later.")
		return false
	}

	// The cooldown is checked before the quota so a rapid double-tap costs the user a short wait
	// rather than one of their five hourly codes.
	if wait := h.limiter.Cooldown(r.Context(), "otpreq:"+identifier, otpRequestCooldown); wait > 0 {
		tooManyRequests(w, wait, "Please wait before requesting another code.")
		return false
	}

	if d := h.limiter.Allow(r.Context(), "otpreq:id:"+identifier, otpRequestIDRule); !d.Allowed {
		h.logger.Warn("otp request rate limited by identifier")
		tooManyRequests(w, d.RetryAfter, "Too many codes requested for this account. Try again later.")
		return false
	}
	return true
}

// allowOTPVerify gates guessing a code: a per-identifier quota plus a short gap between attempts.
//
// The gap matters more than the quota. Ten guesses an hour still allows ten instant attempts; a
// two-second floor turns any real search into years and gives monitoring time to see it happening.
func (h *handler) allowOTPVerify(w http.ResponseWriter, r *http.Request, identifier string) bool {
	ip := clientIP(r, h.cfg.TrustProxyHeaders)

	if wait := h.limiter.Cooldown(r.Context(), "otpver:"+identifier, otpVerifyCooldown); wait > 0 {
		tooManyRequests(w, wait, "Too many attempts. Please wait a moment.")
		return false
	}
	if d := h.limiter.Allow(r.Context(), "otpver:id:"+identifier, otpVerifyIDRule); !d.Allowed {
		h.logger.Warn("otp verify rate limited", "ip", ip)
		tooManyRequests(w, d.RetryAfter, "Too many incorrect codes. Try again later.")
		return false
	}
	return true
}

// allowPoolRead gates the endpoints that rebuild a Merkle tree per request.
func (h *handler) allowPoolRead(w http.ResponseWriter, r *http.Request) bool {
	ip := clientIP(r, h.cfg.TrustProxyHeaders)
	d := h.limiter.Allow(r.Context(), "poolread:"+ip, poolReadRule)
	writeRateLimitHeaders(w, d)
	if !d.Allowed {
		tooManyRequests(w, d.RetryAfter, "Too many requests. Please slow down.")
		return false
	}
	return true
}
