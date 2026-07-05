package server

import (
	"net/http"

	"github.com/prova/shared/schema"
)

// writeError sends the shared API error envelope.
func writeError(w http.ResponseWriter, status int, code schema.ErrorCode, message string) {
	writeJSON(w, status, schema.APIError{Code: code, Message: message})
}
