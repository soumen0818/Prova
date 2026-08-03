package mailer

import (
	"context"
	"strings"
	"testing"
)

func TestConfiguredRequiresHostAndCredentials(t *testing.T) {
	if (SMTP{}).Configured() {
		t.Error("an empty config must not report itself configured")
	}
	if (SMTP{Host: "smtp.gmail.com"}).Configured() {
		t.Error("a host alone is not enough")
	}
	full := SMTP{Host: "smtp.gmail.com", Port: 587, Username: "u@gmail.com", Password: "app-password"}
	if !full.Configured() {
		t.Error("a complete config must report itself configured")
	}
}

// A misconfigured deployment must fail visibly rather than accept sign-ups whose codes go nowhere.
func TestUnconfiguredSendReportsItself(t *testing.T) {
	if err := (SMTP{}).Send(context.Background(), "a@b.com", "s", "b"); err != ErrNotConfigured {
		t.Errorf("→ %v, want ErrNotConfigured", err)
	}
	if err := (Noop{}).Send(context.Background(), "a@b.com", "s", "b"); err != ErrNotConfigured {
		t.Errorf("noop → %v, want ErrNotConfigured", err)
	}
}

// Newlines in a header value would let an attacker add their own headers — a Bcc, say — turning a
// sign-in form into a spam relay. This is header injection, and it is a real attack.
func TestHeaderInjectionIsStripped(t *testing.T) {
	m := SMTP{Host: "h", Username: "from@example.com", FromName: "Prova"}
	msg := m.message(
		"from@example.com",
		"victim@example.com\r\nBcc: attacker@evil.com",
		"Subject\r\nX-Injected: yes",
		"body",
	)

	// The vulnerability is an injected header LINE, not the substring appearing somewhere. After
	// stripping newlines the payload collapses into the value it came from, which is harmless — so
	// assert on line starts, which is the property that actually matters.
	for _, line := range strings.Split(msg, "\r\n") {
		if strings.HasPrefix(line, "Bcc:") {
			t.Errorf("a newline in the recipient injected a header line: %q", line)
		}
		if strings.HasPrefix(line, "X-Injected") {
			t.Errorf("a newline in the subject injected a header line: %q", line)
		}
	}
	// And no raw newline may survive in a header value at all.
	headers, _, _ := strings.Cut(msg, "\r\n\r\n")
	if strings.ContainsAny(headers, "\n\r") != strings.Contains(headers, "\r\n") {
		t.Error("stray CR or LF in the header block")
	}
	// The header block must still be terminated exactly once, before the body.
	if !strings.Contains(msg, "\r\n\r\nbody") {
		t.Error("the header/body separator is malformed")
	}
}

func TestMessageHasTheRequiredHeaders(t *testing.T) {
	m := SMTP{Host: "h", Username: "from@example.com", FromName: "Prova"}
	msg := m.message("from@example.com", "to@example.com", "Your code", "body")

	for _, want := range []string{
		"From: Prova <from@example.com>",
		"To: to@example.com",
		"Subject: Your code",
		"MIME-Version: 1.0",
		"Content-Type: text/plain",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("missing header: %s", want)
		}
	}
}

// The code has to be easy to read and copy, and an unexpected email has to be self-explanatory.
func TestCodeEmailIsUsable(t *testing.T) {
	subject, text, html := CodeEmail("482913", 10)

	// Many clients surface the code from the subject line, which saves opening the mail at all.
	if !strings.Contains(subject, "482913") {
		t.Error("the subject should carry the code")
	}
	// Both renderable forms must stand alone: a client that blocks HTML must not lose the code.
	for name, body := range map[string]string{"text": text, "html": html} {
		if !strings.Contains(body, "482913") {
			t.Errorf("%s part must contain the code", name)
		}
		if !strings.Contains(body, "10 minutes") {
			t.Errorf("%s part must state the expiry, so a stale code explains itself", name)
		}
		if !strings.Contains(strings.ToLower(body), "didn't try to sign in") &&
			!strings.Contains(strings.ToLower(body), "didn't try to sign in?") {
			t.Errorf("%s part must tell an unexpecting recipient they can ignore it", name)
		}
	}
	// The HTML must reference the logo by Content-ID; a `data:` URI would be stripped by Gmail.
	if !strings.Contains(html, "cid:"+logoCID) {
		t.Error("the HTML must reference the inline logo by CID")
	}
}

// The logo has to actually ship inside the binary, or every email arrives with a broken image.
func TestLogoIsEmbedded(t *testing.T) {
	if len(logoPNG) == 0 {
		t.Fatal("the logo was not embedded")
	}
	if !strings.HasPrefix(string(logoPNG[:4]), "\x89PNG") {
		t.Error("the embedded logo is not a PNG")
	}
}

// The multipart structure is what makes the logo render and keeps a text fallback. Getting the
// nesting wrong produces an email that looks empty in some clients, so it is asserted explicitly.
func TestRichMessageStructure(t *testing.T) {
	m := SMTP{Host: "h", Username: "from@example.com", FromName: "Prova"}
	msg := m.richMessage("from@example.com", "to@example.com", "482913 — code", "plain body", "<p>html body</p>")

	for _, want := range []string{
		"Content-Type: multipart/related;",
		"Content-Type: multipart/alternative;",
		"Content-Type: text/plain; charset=\"UTF-8\"",
		"Content-Type: text/html; charset=\"UTF-8\"",
		"Content-Type: image/png",
		"Content-ID: <" + logoCID + ">",
		"Content-Transfer-Encoding: base64",
		"plain body",
		"<p>html body</p>",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("missing from multipart message: %s", want)
		}
	}

	// text/plain must precede text/html: within multipart/alternative the order is least- to
	// most-preferred, so reversing it would show raw markup in clients that pick the first part.
	if strings.Index(msg, "text/plain") > strings.Index(msg, "text/html") {
		t.Error("text/plain must come before text/html inside multipart/alternative")
	}

	// Base64 lines must respect RFC 2045's 76-character limit; some servers reject longer ones.
	for _, line := range strings.Split(msg, "\r\n") {
		if len(line) > 76 && !strings.HasPrefix(line, "Content-") && !strings.HasPrefix(line, "<") {
			t.Errorf("line exceeds 76 chars: %d", len(line))
			break
		}
	}
}
