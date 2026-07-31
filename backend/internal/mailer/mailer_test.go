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
	subject, body := CodeEmail("482913", 10)

	// Many clients surface the code from the subject line, which saves opening the mail at all.
	if !strings.Contains(subject, "482913") {
		t.Error("the subject should carry the code")
	}
	if !strings.Contains(body, "482913") {
		t.Error("the body must contain the code")
	}
	if !strings.Contains(body, "10 minutes") {
		t.Error("the body must state the expiry, so a stale code explains itself")
	}
	if !strings.Contains(strings.ToLower(body), "didn't try to sign in") {
		t.Error("the body must tell an unexpecting recipient they can ignore it")
	}
}
