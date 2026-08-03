package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/prova/backend/internal/config"
	"github.com/prova/shared/schema"
)

// Server-side validation is the actual control — the app's checks are a courtesy, and anything can
// post here. These assert that every endpoint rejects malformed input *before* doing any work, and
// that it uses the shared rules rather than a private copy that could drift.

func authHandler() http.Handler {
	return New(slog.Default(), config.Load(), Deps{})
}

func post(t *testing.T, h http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestEmailOTPRequestValidatesTheAddress(t *testing.T) {
	h := authHandler()

	for _, bad := range []string{
		`{"email":""}`,
		`{"email":"plainaddress"}`,
		`{"email":"user@"}`,
		`{"email":"user@example"}`,
		`{"email":"user name@example.com"}`,
		`{"email":"user@example..com"}`,
		`{}`,
		`not json`,
	} {
		rec := post(t, h, "/auth/otp/request", bad)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s → %d, want 400", bad, rec.Code)
		}
	}

	rec := post(t, h, "/auth/otp/request", `{"email":"user@example.com"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("a valid address → %d, want 200", rec.Code)
	}
}

// The code alone is not enough: a client can post a code against an address it never requested one
// for, so the address must be re-validated on verify too.
func TestEmailOTPVerifyValidatesBothFields(t *testing.T) {
	h := authHandler()
	code := config.Load().DevOTP

	for _, bad := range []struct{ body, why string }{
		{`{"email":"nope","code":"` + code + `"}`, "malformed email"},
		{`{"email":"user@example.com","code":"123"}`, "short code"},
		{`{"email":"user@example.com","code":"abcdef"}`, "non-numeric code"},
		{`{"email":"user@example.com","code":"1234567"}`, "long code"},
		{`{"email":"user@example.com"}`, "missing code"},
	} {
		rec := post(t, h, "/auth/otp/verify", bad.body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s → %d, want 400", bad.why, rec.Code)
		}
	}

	// A well-formed but wrong code is 401, not 400 — the request was fine, the credential was not.
	rec := post(t, h, "/auth/otp/verify", `{"email":"user@example.com","code":"999999"}`)
	if code != "999999" && rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong code → %d, want 401", rec.Code)
	}
}

// Emails are normalised so one person cannot end up with two accounts that differ only by case.
func TestEmailOTPVerifyNormalizesTheAddress(t *testing.T) {
	h := authHandler()
	code := config.Load().DevOTP

	rec := post(t, h, "/auth/otp/verify", `{"email":"  User@Example.COM ","code":"`+code+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("→ %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["email"] != "user@example.com" {
		t.Errorf("email = %q, want normalised", body["email"])
	}
	if body["token"] == "" {
		t.Error("a session token must be returned")
	}
}

// The KYC phone step must reject numbers it could never send a code to — accepting one would strand
// the user mid-verification with no way forward.
func TestKycPhoneRequestRejectsUnsupportedNumbers(t *testing.T) {
	h := authHandler()

	for _, bad := range []struct{ body, why string }{
		{`{"phone":""}`, "empty"},
		{`{"phone":"501234567"}`, "no country code"},
		{`{"phone":"+9715012345"}`, "right country, wrong length"},
		{`{"phone":"+35312345678"}`, "unsupported country"},
		{`{"phone":"+abc"}`, "not digits"},
		{`{}`, "missing"},
	} {
		rec := post(t, h, "/kyc/phone/request", bad.body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s → %d, want 400", bad.why, rec.Code)
		}
	}

	// Both sides of the corridor must work — a rule tuned to only one would break half the users.
	for _, good := range []string{`{"phone":"+971501234567"}`, `{"phone":"+919876543210"}`} {
		if rec := post(t, h, "/kyc/phone/request", good); rec.Code != http.StatusOK {
			t.Errorf("%s → %d, want 200", good, rec.Code)
		}
	}
}

func TestKycPhoneVerifyValidatesBothFields(t *testing.T) {
	h := authHandler()
	code := config.Load().DevOTP

	if rec := post(t, h, "/kyc/phone/verify", `{"phone":"+35312345678","code":"`+code+`"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("unsupported country → %d, want 400", rec.Code)
	}
	if rec := post(t, h, "/kyc/phone/verify", `{"phone":"+971501234567","code":"12"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("short code → %d, want 400", rec.Code)
	}

	rec := post(t, h, "/kyc/phone/verify", `{"phone":"+971501234567","code":"`+code+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("valid verify → %d, want 200", rec.Code)
	}
}

// The picker is served from the same table the server validates against, so the app can never offer
// a country whose numbers would then be rejected.
func TestCountriesEndpointMatchesTheValidationTable(t *testing.T) {
	h := authHandler()
	req := httptest.NewRequest(http.MethodGet, "/countries", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("→ %d, want 200", rec.Code)
	}
	var body struct {
		Countries []schema.Country `json:"countries"`
		Default   string           `json:"default"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Countries) != len(schema.Countries) {
		t.Fatalf("served %d countries, table has %d", len(body.Countries), len(schema.Countries))
	}
	if body.Default != schema.DefaultCountry {
		t.Errorf("default = %q, want %q", body.Default, schema.DefaultCountry)
	}
	// Every served country must actually accept a number of its stated length.
	for _, c := range body.Countries {
		national := strings.Repeat("9", c.NationalDigits)
		if !schema.IsValidNationalNumber(national, c.Code) {
			t.Errorf("%s: served but its own stated length fails validation", c.Code)
		}
		if !schema.IsSupportedE164(schema.ToE164(national, c.Code)) {
			t.Errorf("%s: composed E.164 is not accepted", c.Code)
		}
	}
}

// Oversized bodies must be refused rather than buffered.
func TestAuthBodiesAreSizeLimited(t *testing.T) {
	h := authHandler()
	huge := `{"email":"` + strings.Repeat("a", maxAuthBody*2) + `@example.com"}`
	if rec := post(t, h, "/auth/otp/request", huge); rec.Code != http.StatusBadRequest {
		t.Errorf("oversized body → %d, want 400", rec.Code)
	}
}

// --- Validation audit: identifiers and addresses on every endpoint that accepts them ---
//
// These were previously unchecked or only checked for non-emptiness, which meant arbitrary strings
// could reach the verification table (polluting the KYC audit trail — the one record a regulator
// actually asks for) or become a Horizon call.

func TestKycEndpointsRejectMalformedUserIds(t *testing.T) {
	h := authHandler()
	valid := strings.Repeat("ab", 32)

	bad := []string{
		"",
		"not-hex",
		strings.Repeat("ab", 31), // too short
		strings.Repeat("ab", 33), // too long
		strings.ToUpper(valid),   // uppercase hex is not the canonical form
		"'; DROP TABLE kyc_verifications; --",
	}

	for _, id := range bad {
		// POST /kyc/verifications
		rec := post(t, h, "/kyc/verifications", `{"userId":"`+id+`","tier":2}`)
		if rec.Code == http.StatusOK {
			t.Errorf("startVerification accepted userId %q", id)
		}
		// POST /kyc/credential
		rec = post(t, h, "/kyc/credential", `{"userId":"`+id+`"}`)
		if rec.Code == http.StatusOK {
			t.Errorf("issueCredential accepted userId %q", id)
		}
		// POST /kyc/credential/renew — previously validated nothing at all.
		rec = post(t, h, "/kyc/credential/renew", `{"userId":"`+id+`"}`)
		if rec.Code == http.StatusOK {
			t.Errorf("renewCredential accepted userId %q", id)
		}
	}

	// GET /kyc/verifications/{userId}
	for _, id := range []string{"not-hex", strings.Repeat("ab", 31)} {
		req := httptest.NewRequest(http.MethodGet, "/kyc/verifications/"+id, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code == http.StatusOK {
			t.Errorf("getVerification accepted userId %q", id)
		}
	}
}

// A tier outside the defined set would map to an undefined per-transfer limit.
func TestStartVerificationRejectsUnknownTiers(t *testing.T) {
	h := authHandler()
	valid := strings.Repeat("ab", 32)

	for _, tier := range []string{"0", "-1", "4", "99"} {
		rec := post(t, h, "/kyc/verifications", `{"userId":"`+valid+`","tier":`+tier+`}`)
		if rec.Code == http.StatusOK {
			t.Errorf("tier %s was accepted", tier)
		}
	}
}

// A compliance decision is not a field to guess at: anything that is not an explicit approve or
// reject must be refused, never silently treated as a rejection.
func TestDecideVerificationRejectsUnknownDecisions(t *testing.T) {
	h := authHandler()
	valid := strings.Repeat("ab", 32)

	for _, d := range []string{"", "maybe", "APPROVED", "yes"} {
		rec := post(t, h, "/kyc/verifications/"+valid+"/decide", `{"decision":"`+d+`"}`)
		if rec.Code == http.StatusOK {
			t.Errorf("decision %q was accepted", d)
		}
	}
}

func TestWalletEndpointsRejectMalformedAddresses(t *testing.T) {
	h := authHandler()

	for _, addr := range []string{
		"",
		"not-an-address",
		"GABC",                  // too short
		strings.Repeat("G", 56), // right length, wrong alphabet position
		"MABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV", // muxed, not supported here
	} {
		rec := post(t, h, "/wallet/fund", `{"address":"`+addr+`"}`)
		if rec.Code == http.StatusOK {
			t.Errorf("wallet fund accepted address %q", addr)
		}

		req := httptest.NewRequest(http.MethodGet, "/wallet/"+addr, nil)
		recGet := httptest.NewRecorder()
		h.ServeHTTP(recGet, req)
		if recGet.Code == http.StatusOK {
			t.Errorf("wallet state accepted address %q", addr)
		}
	}
}

// --- Real code path: SMTP configured ---
//
// With a mailer present the handlers stop using the fixed dev constant and issue a real random code
// with a TTL and an attempt cap. These check the behaviour a user actually meets, including that
// every failure carries a message telling them what to do next.

type captureMailer struct {
	sent     int
	lastTo   string
	lastMsg  string
	failWith error
}

func (m *captureMailer) Configured() bool { return true }

func (m *captureMailer) Send(_ context.Context, to, _, body string) error {
	if m.failWith != nil {
		return m.failWith
	}
	m.sent++
	m.lastTo = to
	m.lastMsg = body
	return nil
}

// The sign-in code goes out as multipart. The plain-text part is captured because it carries the
// same code as the HTML and is far simpler to assert against.
func (m *captureMailer) SendHTML(_ context.Context, to, _, text, _ string) error {
	if m.failWith != nil {
		return m.failWith
	}
	m.sent++
	m.lastTo = to
	m.lastMsg = text
	return nil
}

// codeFrom pulls the six-digit code out of the email body.
func codeFrom(t *testing.T, body string) string {
	t.Helper()
	re := regexp.MustCompile(`\b\d{6}\b`)
	code := re.FindString(body)
	if code == "" {
		t.Fatalf("no code in email body: %q", body)
	}
	return code
}

func mailerHandler(m *captureMailer) http.Handler {
	return New(slog.Default(), config.Load(), Deps{Mailer: m})
}

func TestRealCodeIsEmailedAndVerifies(t *testing.T) {
	m := &captureMailer{}
	h := mailerHandler(m)

	rec := post(t, h, "/auth/otp/request", `{"email":"real@example.com"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("request → %d, want 200", rec.Code)
	}
	if m.sent != 1 {
		t.Fatalf("expected one email, sent %d", m.sent)
	}
	if m.lastTo != "real@example.com" {
		t.Errorf("sent to %q", m.lastTo)
	}

	// The real code must NOT be echoed in the response — that would defeat emailing it at all.
	var body map[string]string
	_ = json.NewDecoder(rec.Body).Decode(&body)
	if body["devCode"] != "" {
		t.Error("a real code must never be returned in the HTTP response")
	}

	code := codeFrom(t, m.lastMsg)
	verify := post(t, h, "/auth/otp/verify", `{"email":"real@example.com","code":"`+code+`"}`)
	if verify.Code != http.StatusOK {
		t.Fatalf("verify → %d, want 200", verify.Code)
	}

	// Single-use: a code observed in transit must not be replayable.
	again := post(t, h, "/auth/otp/verify", `{"email":"real@example.com","code":"`+code+`"}`)
	if again.Code == http.StatusOK {
		t.Error("a consumed code must not verify twice")
	}
}

// The fixed dev code must stop working the moment real codes are in play, or the whole mechanism is
// theatre.
func TestDevCodeIsRejectedOnceMailerIsConfigured(t *testing.T) {
	m := &captureMailer{}
	h := mailerHandler(m)

	post(t, h, "/auth/otp/request", `{"email":"dev@example.com"}`)
	rec := post(t, h, "/auth/otp/verify", `{"email":"dev@example.com","code":"`+config.Load().DevOTP+`"}`)
	if rec.Code == http.StatusOK {
		t.Fatal("the dev constant must not verify against a real issued code")
	}
}

// Every rejection has to tell the user what to do next — a bare "invalid" on an auth screen is where
// people give up.
func TestVerifyFailuresCarryActionableMessages(t *testing.T) {
	m := &captureMailer{}
	h := mailerHandler(m)

	// No code was ever requested for this address.
	rec := post(t, h, "/auth/otp/verify", `{"email":"nocode@example.com","code":"123456"}`)
	msg := decodeErr(t, rec).Message
	if !strings.Contains(strings.ToLower(msg), "request a new one") {
		t.Errorf("expired/absent code message should tell them to request another, got %q", msg)
	}

	// A wrong guess should say how many tries remain.
	post(t, h, "/auth/otp/request", `{"email":"wrong@example.com"}`)
	real := codeFrom(t, m.lastMsg)
	bad := "000000"
	if bad == real {
		bad = "111111"
	}
	rec = post(t, h, "/auth/otp/verify", `{"email":"wrong@example.com","code":"`+bad+`"}`)
	msg = decodeErr(t, rec).Message
	if !strings.Contains(msg, "attempts left") && !strings.Contains(msg, "attempt left") {
		t.Errorf("a wrong guess should report remaining attempts, got %q", msg)
	}
}

// A failing mail provider must be reported as such, not as a generic error — and must not leave the
// user believing a code is on its way.
func TestMailSendFailureIsReported(t *testing.T) {
	m := &captureMailer{failWith: errors.New("smtp refused")}
	h := mailerHandler(m)

	rec := post(t, h, "/auth/otp/request", `{"email":"fail@example.com"}`)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("→ %d, want 502", rec.Code)
	}
	msg := decodeErr(t, rec).Message
	if strings.Contains(strings.ToLower(msg), "smtp") {
		t.Errorf("the provider's internal error must not leak to the user: %q", msg)
	}
	if msg == "" {
		t.Error("a failure must still explain itself")
	}
}
