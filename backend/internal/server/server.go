// Package server wires the HTTP router, middleware, and handlers.
package server

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/stellar/go/keypair"

	"github.com/prova/backend/internal/anchor"
	"github.com/prova/backend/internal/config"
	"github.com/prova/backend/internal/transfers"
)

type handler struct {
	logger    *slog.Logger
	cfg       config.Config
	transfers *transfers.Service
	anchor    *anchor.Client
	sep10Key  *keypair.Full
}

// Deps are the runtime dependencies the server needs. Any of the Phase 2 services may be nil (e.g.
// when Postgres/anchor are unavailable); the corresponding routes then return 503.
type Deps struct {
	Transfers *transfers.Service
	Anchor    *anchor.Client
	SEP10Key  *keypair.Full
}

// New builds the backend HTTP handler.
func New(logger *slog.Logger, cfg config.Config, deps Deps) http.Handler {
	h := &handler{
		logger:    logger,
		cfg:       cfg,
		transfers: deps.Transfers,
		anchor:    deps.Anchor,
		sep10Key:  deps.SEP10Key,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.healthz)
	mux.HandleFunc("GET /readyz", h.readyz)

	// Phase 2 — transfer relay + lifecycle.
	mux.HandleFunc("POST /transfers", h.submitTransfer)
	mux.HandleFunc("GET /transfers/{id}", h.getTransfer)

	// Phase 2 — anchor deposit rails (dev endpoints).
	mux.HandleFunc("POST /sep10/auth", h.sep10Auth)
	mux.HandleFunc("POST /sep24/deposit", h.sep24Deposit)

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
