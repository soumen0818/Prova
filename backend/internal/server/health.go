package server

import (
	"encoding/json"
	"net/http"

	"github.com/prova/shared/schema"
)

// healthz is a liveness probe — the process is up. It reports the shared-schema version so
// clients can detect a contract mismatch against @prova/shared.
func (h *handler) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":        "ok",
		"env":           h.cfg.AppEnv,
		"schemaVersion": schema.SchemaVersion,
	})
}

// notFound returns the shared API error envelope for unmatched routes.
func (h *handler) notFound(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusNotFound, schema.APIError{
		Code:    schema.ErrInternal,
		Message: "route not found",
	})
}

// readyz is a readiness probe.
// TODO(Phase 2): verify Postgres, Redis, and Soroban RPC connectivity before reporting ready.
func (h *handler) readyz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
