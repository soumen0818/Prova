// Package kyc is the Phase 3 anchor-side KYC handoff (SEP-12 shape). After the anchor's KYC vendor
// approves a user (stubbed in dev), the anchor signs an attested credential the user stores in their
// wallet. Signing uses the prover CLI (`prova-prover issue-credential`) so the Jubjub/Poseidon
// scheme lives in one place (Rust) and always matches the circuit.
//
// The backend never stores raw identity — the licensed anchor does. Only `userId`
// (= Poseidon(secret, domain)) passes through here, and it reveals nothing.
package kyc

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"

	"github.com/prova/shared/schema"
)

// Issuer issues anchor-attested credentials and exposes the anchor's trusted public key.
type Issuer interface {
	Issue(ctx context.Context, userID string, kycLevel int, expiry int64) (schema.KycCredential, error)
	AnchorPublicKey(ctx context.Context) (schema.AnchorPublicKey, error)
}

// CLIIssuer signs credentials by shelling out to the prover CLI.
type CLIIssuer struct {
	ProverBin  string
	AnchorSeed string // optional; empty → the CLI's built-in dev anchor key
}

// raw is the CLI's issue-credential JSON.
type raw struct {
	UserID    string `json:"userId"`
	KycLevel  int    `json:"kycLevel"`
	Expiry    int64  `json:"expiry"`
	SigRx     string `json:"sigRx"`
	SigRy     string `json:"sigRy"`
	SigS      string `json:"sigS"`
	AnchorPkX string `json:"anchorPkX"`
	AnchorPkY string `json:"anchorPkY"`
}

func (c CLIIssuer) anchorArgs(base ...string) []string {
	if c.AnchorSeed != "" {
		base = append(base, "--anchor-seed", c.AnchorSeed)
	}
	return base
}

// Issue signs (userID, kycLevel, expiry) with the anchor key.
func (c CLIIssuer) Issue(ctx context.Context, userID string, kycLevel int, expiry int64) (schema.KycCredential, error) {
	args := c.anchorArgs(
		"issue-credential",
		"--user-id", userID,
		"--kyc-level", strconv.Itoa(kycLevel),
		"--expiry", strconv.FormatInt(expiry, 10),
	)
	out, err := exec.CommandContext(ctx, c.ProverBin, args...).Output()
	if err != nil {
		return schema.KycCredential{}, fmt.Errorf("issue-credential: %w", err)
	}
	var r raw
	if err := json.Unmarshal(out, &r); err != nil {
		return schema.KycCredential{}, fmt.Errorf("decode credential: %w", err)
	}
	return schema.KycCredential{
		UserID:   r.UserID,
		KycLevel: r.KycLevel,
		Expiry:   r.Expiry,
		Signature: schema.CredentialSignature{
			RX: r.SigRx,
			RY: r.SigRy,
			S:  r.SigS,
		},
		Anchor: schema.AnchorPublicKey{X: r.AnchorPkX, Y: r.AnchorPkY},
	}, nil
}

// AnchorPublicKey returns the anchor's Jubjub public key.
func (c CLIIssuer) AnchorPublicKey(ctx context.Context) (schema.AnchorPublicKey, error) {
	out, err := exec.CommandContext(ctx, c.ProverBin, c.anchorArgs("anchor-pubkey")...).Output()
	if err != nil {
		return schema.AnchorPublicKey{}, fmt.Errorf("anchor-pubkey: %w", err)
	}
	var pk schema.AnchorPublicKey
	if err := json.Unmarshal(out, &pk); err != nil {
		return schema.AnchorPublicKey{}, fmt.Errorf("decode anchor pubkey: %w", err)
	}
	return pk, nil
}
