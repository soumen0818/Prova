// Package server wires the HTTP router, middleware, and handlers.
package server

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/stellar/go/keypair"

	"github.com/prova/backend/internal/anchor"
	"github.com/prova/backend/internal/chain"
	"github.com/prova/backend/internal/config"
	"github.com/prova/backend/internal/kyc"
	"github.com/prova/backend/internal/mailer"
	"github.com/prova/backend/internal/otp"
	"github.com/prova/backend/internal/pool"
	"github.com/prova/backend/internal/ratelimit"
	"github.com/prova/backend/internal/transfers"
)

type handler struct {
	logger    *slog.Logger
	cfg       config.Config
	transfers *transfers.Service
	anchor    *anchor.Client
	sep10Key  *keypair.Full
	kyc       kyc.Issuer
	// verification drives the KYC state machine; nil disables the /kyc/verifications routes.
	verification *kyc.Service
	// verificationProvider parses provider webhook payloads.
	verificationProvider kyc.Provider
	// wallet does on-chain (testnet) funding/trustline/balance; nil disables the /wallet routes.
	wallet *chain.Wallet
	// limiter throttles abusive callers. Never nil — every endpoint here is unauthenticated, so
	// this is the only thing between a script and the SMS bill or the code space.
	limiter *ratelimit.Limiter
	// otp issues and verifies real one-time codes; mailer delivers them. Never nil — a Noop mailer
	// stands in when SMTP is unconfigured, so the "not available" path is explicit rather than a
	// panic.
	otp    *otp.Store
	mailer mailer.Mailer
	// pool serves the shielded pool's Merkle paths and note feed; nil disables the /pool routes.
	//
	// Without it a wallet cannot build a spend proof at all, so a nil here is not a degraded
	// feature — it means the pool is unusable and the routes say so with 503.
	pool *pool.Service
}

// Deps are the runtime dependencies the server needs. Any service may be nil (e.g. when
// Postgres/anchor/prover are unavailable); the corresponding routes then return 503.
type Deps struct {
	Transfers            *transfers.Service
	Anchor               *anchor.Client
	SEP10Key             *keypair.Full
	KYC                  kyc.Issuer
	Verification         *kyc.Service
	VerificationProvider kyc.Provider
	Wallet               *chain.Wallet
	Pool                 *pool.Service
	// Redis backs the rate limiter so limits hold across replicas. Nil falls back to per-instance
	// in-process counters — degraded, but never open.
	Redis *redis.Client
	// Mailer delivers sign-in codes. Nil falls back to Noop, which reports itself unconfigured.
	Mailer mailer.Mailer
}

// New builds the backend HTTP handler.
func New(logger *slog.Logger, cfg config.Config, deps Deps) http.Handler {
	h := &handler{
		logger:               logger,
		cfg:                  cfg,
		transfers:            deps.Transfers,
		anchor:               deps.Anchor,
		sep10Key:             deps.SEP10Key,
		kyc:                  deps.KYC,
		verification:         deps.Verification,
		verificationProvider: deps.VerificationProvider,
		wallet:               deps.Wallet,
		pool:                 deps.Pool,
		limiter:              ratelimit.New(deps.Redis),
		otp:                  otp.New(deps.Redis),
		mailer:               deps.Mailer,
	}
	if h.mailer == nil {
		h.mailer = mailer.Noop{}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.healthz)
	mux.HandleFunc("GET /readyz", h.readyz)

	// Sign-in: EMAIL one-time code. The email is the account identifier.
	mux.HandleFunc("POST /auth/otp/request", h.otpRequest)
	mux.HandleFunc("POST /auth/otp/verify", h.otpVerify)

	// KYC step 1: verify a contact PHONE number. Separate from sign-in on purpose — the phone is an
	// attribute the anchor needs, not the account identity, so changing it must not cost the account.
	mux.HandleFunc("POST /kyc/phone/request", h.kycPhoneRequest)
	mux.HandleFunc("POST /kyc/phone/verify", h.kycPhoneVerify)

	// The dialling countries the picker offers — served from the same table the server validates
	// against, so the app can never offer a country whose numbers would then be rejected.
	mux.HandleFunc("GET /countries", h.listCountries)

	// Phase 2 — transfer relay + lifecycle. Phase 4 — history (from relays + the indexer).
	mux.HandleFunc("POST /transfers", h.submitTransfer)
	mux.HandleFunc("GET /transfers", h.listTransfers)
	mux.HandleFunc("GET /transfers/{id}", h.getTransfer)

	// Phase 2 — anchor deposit rails (dev endpoints).
	mux.HandleFunc("POST /sep10/auth", h.sep10Auth)
	mux.HandleFunc("POST /sep24/deposit", h.sep24Deposit)
	// User-authenticated deposit (the user signs SEP-10, so funds land in the user's wallet).
	mux.HandleFunc("POST /sep24/deposit/prepare", h.depositPrepare)
	mux.HandleFunc("POST /sep24/deposit/complete", h.depositComplete)

	// Phase 4 — the shielded pool. A wallet holds its own note secrets but has no view of the tree,
	// so these are what let it spend: find my note, prove my note, see what arrived.
	mux.HandleFunc("GET /pool/status", h.poolStatus)
	mux.HandleFunc("GET /pool/notes", h.poolNotes)
	mux.HandleFunc("GET /pool/path/{commitment}", h.poolPath)
	mux.HandleFunc("POST /pool/spent", h.poolSpent)
	mux.HandleFunc("POST /pool/spend", h.poolSpend)

	// Real (testnet) on-chain wallet: activate, add a trustline (phone-signed), read balances.
	mux.HandleFunc("GET /wallet/{address}", h.walletState)
	mux.HandleFunc("POST /wallet/fund", h.walletFund)
	mux.HandleFunc("POST /wallet/trustline/prepare", h.prepareTrustline)
	mux.HandleFunc("POST /wallet/trustline/submit", h.submitTrustline)

	// KYC verification lifecycle (Docs/kyc-verification.md). No endpoint here accepts PII.
	mux.HandleFunc("POST /kyc/verifications", h.startVerification)
	mux.HandleFunc("GET /kyc/verifications/{userId}", h.getVerification)
	mux.HandleFunc("POST /kyc/verifications/webhook", h.verificationWebhook)
	mux.HandleFunc("POST /kyc/verifications/{userId}/decide", h.decideVerification)

	// Credential issuance — gated on an approved verification record — + trusted anchor keys.
	mux.HandleFunc("POST /kyc/credential", h.issueCredential)
	mux.HandleFunc("POST /kyc/credential/renew", h.renewCredential)
	mux.HandleFunc("GET /anchors/trusted", h.trustedAnchors)

	mux.HandleFunc("/", h.notFound)

	// Rate limiting sits INSIDE logging, so a throttled request is still logged — otherwise an
	// attack would be invisible in the very logs you would use to spot it.
	return logging(logger, h.limitByIP(mux))
}

// logging is a minimal request logger; swap/extend with metrics + tracing later.
func logging(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		logger.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"duration", time.Since(start).String(),
		)
	})
}
