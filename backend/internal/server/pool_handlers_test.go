package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prova/backend/internal/config"
	"github.com/prova/shared/schema"
)

// The pool routes are the wallet's only way to spend, so their failure modes have to be precise: a
// wallet must be able to tell "not configured" from "unknown note" from "wait, it's coming".
// Confusing the last two is the costly one — it would have a user believe their money is gone when
// it is simply one fold away.

func poolHandler() http.Handler {
	// Deps.Pool left nil: no Postgres in unit tests, which also exercises the unavailable path.
	return New(slog.Default(), config.Load(), Deps{})
}

func decodeErr(t *testing.T, rec *httptest.ResponseRecorder) schema.APIError {
	t.Helper()
	var e schema.APIError
	if err := json.NewDecoder(rec.Body).Decode(&e); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return e
}

// Without an indexer a wallet cannot build a spend proof at all, so the routes must say so plainly
// rather than 404 (which reads as "your note does not exist").
func TestPoolRoutesReportUnavailableWithoutAnIndexer(t *testing.T) {
	h := poolHandler()
	commitment := strings.Repeat("ab", 32)

	for _, tc := range []struct {
		method, path string
		body         string
	}{
		{http.MethodGet, "/pool/status", ""},
		{http.MethodGet, "/pool/notes", ""},
		{http.MethodGet, "/pool/path/" + commitment, ""},
		{http.MethodPost, "/pool/spent", `{"nullifiers":[]}`},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			var req *http.Request
			if tc.body == "" {
				req = httptest.NewRequest(tc.method, tc.path, nil)
			} else {
				req = httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("got %d, want 503", rec.Code)
			}
			if code := decodeErr(t, rec).Code; code != schema.ErrPoolUnavailable {
				t.Errorf("got error code %q, want %q", code, schema.ErrPoolUnavailable)
			}
		})
	}
}

// Malformed input must be rejected before it reaches the prover, so a bad request cannot become a
// confusing internal error — or, worse, an expensive tree rebuild.
func TestPoolPathRejectsMalformedCommitments(t *testing.T) {
	h := poolHandler()

	for _, bad := range []string{
		"short",
		strings.Repeat("ab", 31), // 62 chars
		strings.Repeat("ab", 33), // 66 chars
		strings.Repeat("zz", 32), // not hex
		strings.Repeat("AB", 32), // uppercase is normalised, but non-hex chars are not
	} {
		req := httptest.NewRequest(http.MethodGet, "/pool/path/"+bad, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		// Uppercase hex is lowercased by the handler and is therefore valid — it reaches the
		// unavailable check instead. Everything else must be a 400.
		if bad == strings.Repeat("AB", 32) {
			if rec.Code != http.StatusServiceUnavailable {
				t.Errorf("uppercase hex should normalise and reach the service, got %d", rec.Code)
			}
			continue
		}
		if rec.Code != http.StatusBadRequest {
			t.Errorf("commitment %q: got %d, want 400", bad, rec.Code)
		}
	}
}

func TestIsHex32(t *testing.T) {
	if !isHex32(strings.Repeat("0", 64)) {
		t.Error("64 hex chars must be accepted")
	}
	if !isHex32(strings.Repeat("ab", 32)) {
		t.Error("lowercase hex must be accepted")
	}
	for _, bad := range []string{
		"",
		strings.Repeat("0", 63),
		strings.Repeat("0", 65),
		strings.Repeat("A", 64), // uppercase: callers must normalise first
		strings.Repeat("g", 64),
	} {
		if isHex32(bad) {
			t.Errorf("%q must be rejected", bad)
		}
	}
}

func TestQueryInt64(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/pool/notes?after=42", nil)
	if v, err := queryInt64(req, "after", 0); err != nil || v != 42 {
		t.Fatalf("got %d, %v", v, err)
	}
	// A missing parameter takes the default rather than erroring: scanning from the start is the
	// sensible reading of "no cursor".
	if v, err := queryInt64(req, "missing", 7); err != nil || v != 7 {
		t.Fatalf("default not applied: got %d, %v", v, err)
	}

	bad := httptest.NewRequest(http.MethodGet, "/pool/notes?after=abc", nil)
	if _, err := queryInt64(bad, "after", 0); err == nil {
		t.Error("a non-numeric cursor must be rejected, not silently treated as 0 — that would " +
			"make a wallet rescan from the beginning every poll")
	}
}

// A relay failure must name its cause.
//
// "could not relay the spend" tells the person whose money it is nothing, and gives whoever they
// report it to nothing either. The relayer already captures the last lines of CLI output; this
// asserts they are not thrown away on the way out.
func TestShortReasonNamesTheCauseAndStaysBounded(t *testing.T) {
	if got := shortReason(errors.New("transact failed: exit status 127: libdbus-1.so.3 missing")); //nolint:lll
	!strings.Contains(got, "libdbus-1.so.3") {
		t.Errorf("shortReason dropped the cause: %q", got)
	}

	// Multi-line CLI output has to survive as one readable line.
	multi := errors.New("transact failed:\n  line two\n  line three")
	got := shortReason(multi)
	if strings.Contains(got, "\n") {
		t.Errorf("shortReason left a newline in a single-line message: %q", got)
	}

	// It is a public response, so it must not carry an unbounded dump.
	long := errors.New(strings.Repeat("x", 5000))
	if n := len([]rune(shortReason(long))); n > 210 {
		t.Errorf("shortReason returned %d runes, want it bounded near 200", n)
	}
}
