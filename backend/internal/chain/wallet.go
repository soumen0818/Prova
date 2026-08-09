package chain

// On-chain wallet operations for the real (testnet) deposit flow.
//
// The user's Stellar secret key lives ONLY on their phone. So this follows the "server prepares,
// phone signs" pattern (Docs: option A): the backend builds an unsigned transaction and hands back
// its hash; the phone signs that 32-byte hash with its ed25519 key; the backend attaches the
// signature and submits. The backend never sees the user's secret.
//
// Scope is deliberately testnet: Friendbot funding is testnet-only, and the traded asset has no
// real value.

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/stellar/go/clients/horizonclient"
	"github.com/stellar/go/network"
	"github.com/stellar/go/txnbuild"
)

// Wallet wraps a Horizon client for account funding, trustlines and balance reads.
type Wallet struct {
	horizon    *horizonclient.Client
	passphrase string
	friendbot  string
}

// NewWallet builds a wallet client for the given Horizon URL + network.
func NewWallet(horizonURL, stellarNetwork string) *Wallet {
	passphrase := network.TestNetworkPassphrase
	friendbot := "https://friendbot.stellar.org"
	if stellarNetwork == "mainnet" {
		passphrase = network.PublicNetworkPassphrase
		friendbot = "" // no Friendbot on mainnet — accounts are funded by real deposits
	}
	return &Wallet{
		horizon:    &horizonclient.Client{HorizonURL: horizonURL, HTTP: &http.Client{Timeout: 30 * time.Second}},
		passphrase: passphrase,
		friendbot:  friendbot,
	}
}

// AssetBalance is one line of an account's holdings.
type AssetBalance struct {
	Code    string `json:"code"`   // "XLM" for native
	Issuer  string `json:"issuer"` // empty for native
	Balance string `json:"balance"`
}

// AccountState is the on-chain snapshot the app renders.
type AccountState struct {
	Exists   bool           `json:"exists"`
	Balances []AssetBalance `json:"balances"`
}

// Load reads an account's existence + balances from Horizon. A not-yet-created account is not an
// error — it simply reports `exists: false` so the app can offer to activate it.
func (w *Wallet) Load(ctx context.Context, address string) (AccountState, error) {
	acct, err := w.horizon.AccountDetail(horizonclient.AccountRequest{AccountID: address})
	if err != nil {
		if horizonclient.IsNotFoundError(err) {
			// Non-nil so this marshals as `[]`, not `null`. A nil slice here reached clients as
			// JSON null and broke any caller that iterated it — which is every caller, since a
			// missing account is exactly the state right before activation.
			return AccountState{Exists: false, Balances: []AssetBalance{}}, nil
		}
		return AccountState{}, fmt.Errorf("load account: %w", err)
	}
	out := AccountState{Exists: true, Balances: make([]AssetBalance, 0, len(acct.Balances))}
	for _, b := range acct.Balances {
		code := b.Code
		if b.Type == "native" {
			code = "XLM"
		}
		out.Balances = append(out.Balances, AssetBalance{Code: code, Issuer: b.Issuer, Balance: b.Balance})
	}
	return out, nil
}

// Fund activates a brand-new account with test XLM via Friendbot (testnet only). Idempotent enough
// for our purposes: calling it on an existing account returns an error we treat as "already funded".
func (w *Wallet) Fund(ctx context.Context, address string) error {
	if w.friendbot == "" {
		return fmt.Errorf("funding is testnet-only")
	}
	if _, err := w.horizon.Fund(address); err != nil {
		// If the account already exists, that's fine — the goal (a usable account) is met.
		if st, ok := w.Load(ctx, address); ok == nil && st.Exists {
			return nil
		}
		return fmt.Errorf("friendbot fund: %w", err)
	}
	return nil
}

// UnsignedTx is what the phone needs to sign: the base64 envelope (opaque, echoed back untouched),
// the 32-byte hash to sign, and the network the signature is scoped to.
type UnsignedTx struct {
	XDR     string `json:"xdr"`
	Hash    string `json:"hash"` // hex; the phone signs these 32 bytes with its ed25519 key
	Network string `json:"network"`
	// Summary is a human-readable description of what the tx does, shown to the user before they
	// sign — so nothing is blind-signed. See Docs/deposit-flow.md.
	Summary string `json:"summary"`
}

// BuildTrustline prepares an unsigned ChangeTrust transaction so the user can hold `assetCode`
// issued by `issuer`. The account must already exist (fund it first).
func (w *Wallet) BuildTrustline(ctx context.Context, address, assetCode, issuer string) (UnsignedTx, error) {
	acct, err := w.horizon.AccountDetail(horizonclient.AccountRequest{AccountID: address})
	if err != nil {
		return UnsignedTx{}, fmt.Errorf("load account: %w", err)
	}
	asset := txnbuild.CreditAsset{Code: assetCode, Issuer: issuer}
	changeTrustAsset, err := asset.ToChangeTrustAsset()
	if err != nil {
		return UnsignedTx{}, fmt.Errorf("asset: %w", err)
	}
	tx, err := txnbuild.NewTransaction(txnbuild.TransactionParams{
		SourceAccount:        &acct,
		IncrementSequenceNum: true,
		BaseFee:              txnbuild.MinBaseFee,
		Preconditions:        txnbuild.Preconditions{TimeBounds: txnbuild.NewTimeout(300)},
		Operations:           []txnbuild.Operation{&txnbuild.ChangeTrust{Line: changeTrustAsset}},
	})
	if err != nil {
		return UnsignedTx{}, fmt.Errorf("build tx: %w", err)
	}
	return w.toUnsigned(tx)
}

// SubmitSigned attaches the phone's signature (base64, over the tx hash, by `publicKey`) to the
// previously built envelope and submits it. `AddSignatureBase64` verifies the signature against the
// key over the tx hash, so a bad signature is rejected before anything is submitted.
func (w *Wallet) SubmitSigned(ctx context.Context, envelopeXDR, publicKey, signatureB64 string) (string, error) {
	generic, err := txnbuild.TransactionFromXDR(envelopeXDR)
	if err != nil {
		return "", fmt.Errorf("parse envelope: %w", err)
	}
	tx, ok := generic.Transaction()
	if !ok {
		return "", fmt.Errorf("not a simple transaction")
	}
	signed, err := tx.AddSignatureBase64(w.passphrase, publicKey, signatureB64)
	if err != nil {
		return "", fmt.Errorf("attach signature: %w", err)
	}
	signedXDR, err := signed.Base64()
	if err != nil {
		return "", fmt.Errorf("encode signed tx: %w", err)
	}
	resp, err := w.horizon.SubmitTransactionXDR(signedXDR)
	if err != nil {
		return "", fmt.Errorf("submit tx: %w", err)
	}
	return resp.Hash, nil
}

func (w *Wallet) toUnsigned(tx *txnbuild.Transaction) (UnsignedTx, error) {
	envelope, err := tx.Base64()
	if err != nil {
		return UnsignedTx{}, fmt.Errorf("encode tx: %w", err)
	}
	hash, err := tx.HashHex(w.passphrase)
	if err != nil {
		return UnsignedTx{}, fmt.Errorf("hash tx: %w", err)
	}
	return UnsignedTx{XDR: envelope, Hash: hash, Network: w.passphrase, Summary: SummarizeXDR(envelope)}, nil
}

// SummarizeXDR returns a short, human-readable description of what a transaction does, so the app
// can show the user what they're approving instead of blind-signing a hash. Best-effort: an
// unrecognised transaction is described generically rather than failing.
func SummarizeXDR(envelopeXDR string) string {
	generic, err := txnbuild.TransactionFromXDR(envelopeXDR)
	if err != nil {
		return "Approve this transaction"
	}
	tx, ok := generic.Transaction()
	if !ok {
		return "Approve this transaction"
	}
	ops := tx.Operations()
	if len(ops) == 1 {
		switch op := ops[0].(type) {
		case *txnbuild.ChangeTrust:
			if a, aerr := op.Line.ToAsset(); aerr == nil && !a.IsNative() {
				return "Add " + a.GetCode() + " to your wallet (a one-time trustline)"
			}
			return "Add a trustline to your wallet"
		case *txnbuild.ManageData:
			// SEP-10 challenges are a single manage_data op named "<home_domain> auth".
			return "Sign in to your anchor to add money"
		case *txnbuild.Payment:
			return "Send " + op.Amount + " " + assetCode(op.Asset) + " to " + shortId(op.Destination)
		}
	}
	return fmt.Sprintf("Approve a transaction with %d operation(s)", len(ops))
}

func assetCode(a txnbuild.Asset) string {
	if a == nil || a.IsNative() {
		return "XLM"
	}
	return a.GetCode()
}

func shortId(id string) string {
	if len(id) > 12 {
		return id[:6] + "…" + id[len(id)-4:]
	}
	return id
}
