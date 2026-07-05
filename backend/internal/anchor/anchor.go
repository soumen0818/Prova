// Package anchor is a minimal SEP client for the deposit rails: SEP-10 (auth) and SEP-24
// (interactive deposit). It targets the SDF testanchor by default. Documented SEP versions:
// SEP-1 (toml discovery), SEP-10 v3 (web auth), SEP-24 v3 (interactive deposit).
package anchor

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/stellar/go/keypair"
	"github.com/stellar/go/txnbuild"
)

// Endpoints discovered from the anchor's SEP-1 stellar.toml.
type Endpoints struct {
	WebAuth           string
	TransferSEP24     string
	NetworkPassphrase string
	SigningKey        string
}

// Client talks to one anchor (identified by its home domain).
type Client struct {
	HomeDomain string
	HTTP       *http.Client
}

// New builds a client for the given home domain (e.g. "testanchor.stellar.org").
func New(homeDomain string) *Client {
	return &Client{HomeDomain: homeDomain, HTTP: &http.Client{Timeout: 30 * time.Second}}
}

var tomlKV = regexp.MustCompile(`(?m)^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"`)

// Discover fetches and parses the anchor's stellar.toml for the endpoints we need.
func (c *Client) Discover(ctx context.Context) (Endpoints, error) {
	u := "https://" + c.HomeDomain + "/.well-known/stellar.toml"
	body, err := c.get(ctx, u, "")
	if err != nil {
		return Endpoints{}, fmt.Errorf("fetch toml: %w", err)
	}
	kv := map[string]string{}
	for _, m := range tomlKV.FindAllStringSubmatch(string(body), -1) {
		kv[m[1]] = m[2]
	}
	ep := Endpoints{
		WebAuth:           kv["WEB_AUTH_ENDPOINT"],
		TransferSEP24:     kv["TRANSFER_SERVER_SEP0024"],
		NetworkPassphrase: kv["NETWORK_PASSPHRASE"],
		SigningKey:        kv["SIGNING_KEY"],
	}
	if ep.WebAuth == "" || ep.NetworkPassphrase == "" {
		return ep, fmt.Errorf("toml missing WEB_AUTH_ENDPOINT/NETWORK_PASSPHRASE")
	}
	return ep, nil
}

// Authenticate runs the full SEP-10 challenge/response and returns a JWT.
func (c *Client) Authenticate(ctx context.Context, kp *keypair.Full) (string, error) {
	ep, err := c.Discover(ctx)
	if err != nil {
		return "", err
	}

	// 1. Request a challenge transaction for our account.
	q := url.Values{}
	q.Set("account", kp.Address())
	q.Set("home_domain", c.HomeDomain)
	body, err := c.get(ctx, ep.WebAuth+"?"+q.Encode(), "")
	if err != nil {
		return "", fmt.Errorf("sep10 challenge: %w", err)
	}
	var chal struct {
		Transaction       string `json:"transaction"`
		NetworkPassphrase string `json:"network_passphrase"`
	}
	if err := json.Unmarshal(body, &chal); err != nil || chal.Transaction == "" {
		return "", fmt.Errorf("sep10 challenge decode: %w (%s)", err, snippet(body))
	}
	passphrase := chal.NetworkPassphrase
	if passphrase == "" {
		passphrase = ep.NetworkPassphrase
	}

	// 2. Sign the challenge with our key.
	gtx, err := txnbuild.TransactionFromXDR(chal.Transaction)
	if err != nil {
		return "", fmt.Errorf("parse challenge: %w", err)
	}
	tx, ok := gtx.Transaction()
	if !ok {
		return "", fmt.Errorf("challenge is not a simple transaction")
	}
	signed, err := tx.Sign(passphrase, kp)
	if err != nil {
		return "", fmt.Errorf("sign challenge: %w", err)
	}
	signedB64, err := signed.Base64()
	if err != nil {
		return "", fmt.Errorf("encode signed challenge: %w", err)
	}

	// 3. Exchange the signed challenge for a token.
	payload, _ := json.Marshal(map[string]string{"transaction": signedB64})
	respBody, err := c.postJSON(ctx, ep.WebAuth, "", payload)
	if err != nil {
		return "", fmt.Errorf("sep10 token: %w", err)
	}
	var tok struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(respBody, &tok); err != nil || tok.Token == "" {
		return "", fmt.Errorf("sep10 token decode: %w (%s)", err, snippet(respBody))
	}
	return tok.Token, nil
}

// DepositInteractive starts a SEP-24 interactive deposit and returns the popup URL + transaction id.
func (c *Client) DepositInteractive(ctx context.Context, token, assetCode, account string) (depositURL, id string, err error) {
	ep, err := c.Discover(ctx)
	if err != nil {
		return "", "", err
	}
	if ep.TransferSEP24 == "" {
		return "", "", fmt.Errorf("anchor has no SEP-24 transfer server")
	}
	payload, _ := json.Marshal(map[string]string{"asset_code": assetCode, "account": account})
	body, err := c.postJSON(ctx, strings.TrimRight(ep.TransferSEP24, "/")+"/transactions/deposit/interactive", token, payload)
	if err != nil {
		return "", "", err
	}
	var resp struct {
		URL string `json:"url"`
		ID  string `json:"id"`
	}
	if err := json.Unmarshal(body, &resp); err != nil || resp.URL == "" {
		return "", "", fmt.Errorf("sep24 deposit decode: %w (%s)", err, snippet(body))
	}
	return resp.URL, resp.ID, nil
}

// --- helpers ---

func (c *Client) get(ctx context.Context, u, token string) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return c.do(req)
}

func (c *Client) postJSON(ctx context.Context, u, token string, body []byte) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return c.do(req)
}

func (c *Client) do(req *http.Request) ([]byte, error) {
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("anchor %s -> %d: %s", req.URL.Path, resp.StatusCode, snippet(body))
	}
	return body, nil
}

func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
