package server

import (
	"encoding/json"
	"net/http"

	"github.com/prova/shared/schema"
)

// healthz is a liveness probe — the process is up. It reports the shared-schema version so
// clients can detect a contract mismatch against @prova/shared.
//
// It also carries the **maintenance** flag. The app renders its maintenance screen from this
// response, so downtime is announced by the server (flip MAINTENANCE_MODE) rather than shipped as a
// hardcoded client state. When maintenance is on we still answer 200: the client needs to read the
// body to know *why* it should stop, and a hard failure would be indistinguishable from offline.
func (h *handler) healthz(w http.ResponseWriter, _ *http.Request) {
	body := map[string]any{
		"status":        "ok",
		"env":           h.cfg.AppEnv,
		"schemaVersion": schema.SchemaVersion,
		"maintenance":   h.cfg.MaintenanceMode,
	}
	if h.cfg.MaintenanceMode {
		body["status"] = "maintenance"
		body["maintenanceMessage"] = h.cfg.MaintenanceMessage
		// Optional ISO-8601 estimate the app shows as "back around …".
		body["maintenanceUntil"] = h.cfg.MaintenanceUntil
	}
	writeJSON(w, http.StatusOK, body)
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
