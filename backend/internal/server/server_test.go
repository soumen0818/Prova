package server

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prova/backend/internal/config"
)

func TestHealthz(t *testing.T) {
	h := New(slog.Default(), config.Load(), Deps{})

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}
