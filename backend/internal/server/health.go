package server

import (
	"encoding/json"
	"net/http"
)

// healthz is a liveness probe — the process is up.
func (h *handler) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
		"env":    h.cfg.AppEnv,
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
