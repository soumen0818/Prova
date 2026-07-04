// Package server wires the HTTP router, middleware, and handlers.
package server

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/prova/backend/internal/config"
)

type handler struct {
	logger *slog.Logger
	cfg    config.Config
}

// New builds the backend HTTP handler.
//
// Phase 0 exposes health/readiness only. SEP/anchor, transfer relay, Travel-Rule, and indexer
// routes land in Phases 2–5 (see Docs/implementation-guide.md).
func New(logger *slog.Logger, cfg config.Config) http.Handler {
	h := &handler{logger: logger, cfg: cfg}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", h.healthz)
	mux.HandleFunc("GET /readyz", h.readyz)
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
