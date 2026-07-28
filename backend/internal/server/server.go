// Package server wires the HTTP router, middleware, and handlers.
package server

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/stellar/go/keypair"

	"github.com/prova/backend/internal/anchor"
	"github.com/prova/backend/internal/chain"
	"github.com/prova/backend/internal/config"
	"github.com/prova/backend/internal/kyc"
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
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.healthz)
	mux.HandleFunc("GET /readyz", h.readyz)

	// Phone-login OTP (dev-bypass / prod SMS provider).
	mux.HandleFunc("POST /auth/otp/request", h.otpRequest)
	mux.HandleFunc("POST /auth/otp/verify", h.otpVerify)

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

	return logging(logger, mux)
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
