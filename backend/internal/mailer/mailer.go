// Package mailer sends the sign-in code by email.
//
// # Why stdlib SMTP
//
// Go's `net/smtp` does everything needed here, so there is no dependency to audit or keep current
// for a feature that sends one short message. (Nodemailer is the Node equivalent — same protocol,
// different language.)
//
// # Gmail
//
// Works with a Gmail **App Password**, not the account password:
//
//  1. Enable 2-Step Verification on the Google account.
//  2. Google Account → Security → App passwords → generate one for "Mail".
//  3. Use the 16-character value as SMTP_PASSWORD.
//
// Google disabled "less secure app access" in 2022, so an ordinary password will simply be refused.
// Gmail also caps sending at roughly 500 messages a day — fine for testnet, not for launch. See
// `Docs/signup-and-validation.md` for when to move to a transactional provider.
package mailer

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// ErrNotConfigured means no SMTP host is set, so nothing can be sent.
var ErrNotConfigured = errors.New("smtp is not configured")

// Mailer sends transactional email.
type Mailer interface {
	Send(ctx context.Context, to, subject, body string) error
	// Configured reports whether sending is actually possible, so callers can fail loudly at start
	// rather than silently at the first sign-in.
	Configured() bool
}

// SMTP sends over STARTTLS.
type SMTP struct {
	Host string
	Port int
	// Username / Password are the SMTP credentials. For Gmail this is the address and an App
	// Password.
	Username string
	Password string
	// From is the envelope sender. Most providers, Gmail included, require it to match Username.
	From string
	// FromName is the display name recipients see.
	FromName string
	// Timeout bounds the whole exchange, so a hung mail server cannot hold an HTTP request open.
	Timeout time.Duration
}

func (s SMTP) Configured() bool {
	return s.Host != "" && s.Username != "" && s.Password != ""
}

// Send delivers one message.
//
// Explicit STARTTLS rather than `smtp.SendMail`: the helper will happily continue in the clear if
// the server does not advertise STARTTLS, which would put the code — and the address it belongs to —
// on the wire in plaintext. Here, no TLS means no send.
func (s SMTP) Send(ctx context.Context, to, subject, body string) error {
	if !s.Configured() {
		return ErrNotConfigured
	}

	timeout := s.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	addr := net.JoinHostPort(s.Host, fmt.Sprint(s.Port))

	dialer := &net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("dial smtp: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	client, err := smtp.NewClient(conn, s.Host)
	if err != nil {
		return fmt.Errorf("smtp handshake: %w", err)
	}
	defer func() { _ = client.Quit() }()

	ok, _ := client.Extension("STARTTLS")
	if !ok {
		return errors.New("smtp server does not support STARTTLS; refusing to send in plaintext")
	}
	if err := client.StartTLS(&tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12}); err != nil {
		return fmt.Errorf("starttls: %w", err)
	}

	auth := smtp.PlainAuth("", s.Username, s.Password, s.Host)
	if err := client.Auth(auth); err != nil {
		// Gmail's usual cause: an account password instead of an App Password, or 2FA not enabled.
		return fmt.Errorf("smtp auth (for Gmail, use an App Password): %w", err)
	}

	from := s.From
	if from == "" {
		from = s.Username
	}
	if err := client.Mail(from); err != nil {
		return fmt.Errorf("smtp from: %w", err)
	}
	if err := client.Rcpt(to); err != nil {
		return fmt.Errorf("smtp rcpt: %w", err)
	}

	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("smtp data: %w", err)
	}
	if _, err := w.Write([]byte(s.message(from, to, subject, body))); err != nil {
		return fmt.Errorf("smtp write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp close: %w", err)
	}
	return nil
}

// message builds the RFC 5322 envelope.
//
// Header values are stripped of CR and LF. Without that, an address containing a newline could
// inject extra headers — adding a Bcc, say — which is header injection and a genuine way to turn a
// sign-in form into a spam relay.
func (s SMTP) message(from, to, subject, body string) string {
	name := s.FromName
	if name == "" {
		name = "Prova"
	}
	var b strings.Builder
	b.WriteString("From: " + sanitizeHeader(name) + " <" + sanitizeHeader(from) + ">\r\n")
	b.WriteString("To: " + sanitizeHeader(to) + "\r\n")
	b.WriteString("Subject: " + sanitizeHeader(subject) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=\"UTF-8\"\r\n")
	// Codes must never be cached or indexed by a mail client's assistant features.
	b.WriteString("X-Auto-Response-Suppress: All\r\n")
	b.WriteString("Auto-Submitted: auto-generated\r\n")
	b.WriteString("\r\n")
	b.WriteString(body)
	return b.String()
}

func sanitizeHeader(v string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(v)
}

// CodeEmail is the message a user receives.
//
// Deliberately plain: the code large and alone on its own line so it is easy to read and to copy,
// the expiry stated so a stale code is self-explanatory, and a line telling someone who did not
// request it that they can ignore it — which is what turns an unexpected email from alarming into
// merely odd.
func CodeEmail(code string, ttlMinutes int) (subject, body string) {
	subject = code + " is your Prova code"
	body = strings.Join([]string{
		"Your Prova sign-in code is:",
		"",
		"    " + code,
		"",
		fmt.Sprintf("It expires in %d minutes and can be used once.", ttlMinutes),
		"",
		"If you didn't try to sign in, you can ignore this email — nobody can",
		"access your account without this code.",
		"",
		"— Prova",
	}, "\r\n")
	return subject, body
}

// Noop is used when SMTP is unconfigured. It never sends and always reports that fact, so a
// misconfigured deployment fails visibly instead of accepting sign-ups whose codes go nowhere.
type Noop struct{}

func (Noop) Configured() bool { return false }

func (Noop) Send(context.Context, string, string, string) error { return ErrNotConfigured }
