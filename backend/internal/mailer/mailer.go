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
	"crypto/rand"
	"crypto/tls"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// ErrNotConfigured means no SMTP host is set, so nothing can be sent.
var ErrNotConfigured = errors.New("smtp is not configured")

// logoPNG is the Prova wordmark, embedded so the binary carries its own branding and the email has
// no external dependency at send time.
//
// It is attached **inline with a Content-ID** rather than referenced as a `data:` URI, because Gmail
// — the client most users read this in — strips `data:` image sources entirely. A CID part is the
// only form that reliably renders.
//
//go:embed assets/logo.png
var logoPNG []byte

// logoCID identifies the inline image; the HTML references it as `cid:prova-logo`.
const logoCID = "prova-logo"

// Mailer sends transactional email.
type Mailer interface {
	// Send delivers a plain-text message.
	Send(ctx context.Context, to, subject, body string) error
	// SendHTML delivers a multipart message: a plain-text part for clients that prefer it, an HTML
	// part, and the logo attached inline. Both parts must carry the same information — a recipient
	// whose client blocks HTML must not lose the code.
	SendHTML(ctx context.Context, to, subject, text, html string) error
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
	return s.deliver(ctx, to, func(from string) string {
		return s.message(from, to, subject, body)
	})
}

// SendHTML delivers the multipart form: text + HTML + the inline logo.
func (s SMTP) SendHTML(ctx context.Context, to, subject, text, html string) error {
	return s.deliver(ctx, to, func(from string) string {
		return s.richMessage(from, to, subject, text, html)
	})
}

// deliver runs the SMTP exchange, building the payload once the envelope sender is known.
func (s SMTP) deliver(ctx context.Context, to string, build func(from string) string) error {
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
	if _, err := w.Write([]byte(build(from))); err != nil {
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
	var b strings.Builder
	b.WriteString(s.headers(from, to, subject))
	b.WriteString("Content-Type: text/plain; charset=\"UTF-8\"\r\n")
	b.WriteString("\r\n")
	b.WriteString(body)
	return b.String()
}

// richMessage builds a `multipart/related` message:
//
//	multipart/related          ← binds the HTML to the image it references
//	├── multipart/alternative  ← lets the client pick the form it can render
//	│   ├── text/plain
//	│   └── text/html
//	└── image/png (inline, Content-ID: prova-logo)
//
// Plain text comes first inside `alternative`: the order is least-to-most preferred, so a client
// that understands both shows the HTML, and one that does not still shows a usable code.
func (s SMTP) richMessage(from, to, subject, text, html string) string {
	related, alternative := boundary(), boundary()

	var b strings.Builder
	b.WriteString(s.headers(from, to, subject))
	b.WriteString("Content-Type: multipart/related; boundary=\"" + related + "\"\r\n")
	b.WriteString("\r\n")

	// --- the two renderable forms ---
	b.WriteString("--" + related + "\r\n")
	b.WriteString("Content-Type: multipart/alternative; boundary=\"" + alternative + "\"\r\n\r\n")

	b.WriteString("--" + alternative + "\r\n")
	b.WriteString("Content-Type: text/plain; charset=\"UTF-8\"\r\n\r\n")
	b.WriteString(text + "\r\n")

	b.WriteString("--" + alternative + "\r\n")
	b.WriteString("Content-Type: text/html; charset=\"UTF-8\"\r\n\r\n")
	b.WriteString(html + "\r\n")

	b.WriteString("--" + alternative + "--\r\n")

	// --- the inline logo the HTML references ---
	b.WriteString("--" + related + "\r\n")
	b.WriteString("Content-Type: image/png\r\n")
	b.WriteString("Content-Transfer-Encoding: base64\r\n")
	b.WriteString("Content-ID: <" + logoCID + ">\r\n")
	b.WriteString("Content-Disposition: inline; filename=\"prova.png\"\r\n\r\n")
	b.WriteString(wrap76(base64.StdEncoding.EncodeToString(logoPNG)))

	b.WriteString("--" + related + "--\r\n")
	return b.String()
}

// headers writes the envelope headers shared by every message we send.
func (s SMTP) headers(from, to, subject string) string {
	name := s.FromName
	if name == "" {
		name = "Prova"
	}
	var b strings.Builder
	b.WriteString("From: " + sanitizeHeader(name) + " <" + sanitizeHeader(from) + ">\r\n")
	b.WriteString("To: " + sanitizeHeader(to) + "\r\n")
	b.WriteString("Subject: " + sanitizeHeader(subject) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	// Codes must never be cached or indexed by a mail client's assistant features.
	b.WriteString("X-Auto-Response-Suppress: All\r\n")
	b.WriteString("Auto-Submitted: auto-generated\r\n")
	return b.String()
}

// boundary returns a random MIME boundary. Random rather than fixed so no message body can ever
// contain a line that looks like the delimiter and truncate the email.
func boundary() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// A predictable boundary is still valid MIME; only collision resistance is weakened.
		return "prova-boundary-fallback"
	}
	return "prova_" + hex.EncodeToString(b[:])
}

// wrap76 breaks base64 into RFC 2045's 76-character lines. Some servers reject longer ones.
func wrap76(s string) string {
	var b strings.Builder
	for len(s) > 76 {
		b.WriteString(s[:76] + "\r\n")
		s = s[76:]
	}
	if s != "" {
		b.WriteString(s + "\r\n")
	}
	return b.String()
}

func sanitizeHeader(v string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(v)
}

// CodeEmail is the message a user receives: subject, plain-text body, and HTML body.
//
// The subject leads with the code because most clients show it in the notification and the list
// view — a lot of people never open the mail at all, which is the fastest possible sign-in.
//
// The design is deliberately short: logo, the code, when it expires, and one line for someone who
// did not request it. A one-time code is read in about three seconds, so anything more is furniture.
func CodeEmail(code string, ttlMinutes int) (subject, text, html string) {
	subject = fmt.Sprintf("%s — your Prova sign-in code", code)

	text = strings.Join([]string{
		"Your Prova sign-in code:",
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

	// Table layout with inline styles: the only markup that renders consistently across Gmail,
	// Outlook and Apple Mail. `bgcolor` is set alongside the CSS because Outlook ignores the latter
	// on table cells, and a dark card with unreadable text would be worse than no styling at all.
	html = fmt.Sprintf(`<!doctype html>
<html><body style="margin:0;padding:0;background:#0E0E11;">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0E0E11" style="background:#0E0E11;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="max-width:440px;">

    <tr><td align="left" style="padding:0 4px 24px;">
      <img src="cid:%s" width="96" alt="Prova" style="display:block;border:0;width:96px;height:auto;">
    </td></tr>

    <tr><td bgcolor="#17171A" style="background:#17171A;border-radius:16px;padding:32px;">
      <p style="margin:0 0 20px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;line-height:22px;color:#9A9AA0;">
        Your sign-in code
      </p>
      <p style="margin:0 0 20px;font-family:'SF Mono',SFMono-Regular,Consolas,monospace;font-size:34px;line-height:40px;font-weight:700;letter-spacing:7px;color:#E6F94E;">
        %s
      </p>
      <p style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:21px;color:#9A9AA0;">
        Expires in %d minutes. Can be used once.
      </p>
    </td></tr>

    <tr><td style="padding:20px 4px 0;">
      <p style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;line-height:20px;color:#6B6B72;">
        Didn't try to sign in? You can ignore this email — nobody can access your account without this code.
      </p>
    </td></tr>

  </table>
</td></tr>
</table>
</body></html>`, logoCID, code, ttlMinutes)

	return subject, text, html
}

// Noop is used when SMTP is unconfigured. It never sends and always reports that fact, so a
// misconfigured deployment fails visibly instead of accepting sign-ups whose codes go nowhere.
type Noop struct{}

func (Noop) Configured() bool { return false }

func (Noop) Send(context.Context, string, string, string) error { return ErrNotConfigured }

func (Noop) SendHTML(context.Context, string, string, string, string) error {
	return ErrNotConfigured
}
