// Package chain submits transfers to the Soroban verifier contract.
//
// Phase 2 uses the `stellar` CLI as the relayer signer (the funded testnet identity). This keeps
// the dev relayer simple and reliable; a native Soroban RPC signer can replace CLISubmitter later
// behind the same interface.
package chain

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

// Typed contract outcomes, mapped from the contract's #1/#2 errors.
var (
	// ErrReplay = contract Error #1 NullifierAlreadyUsed.
	ErrReplay = errors.New("nullifier already used")
	// ErrInvalidProof = contract Error #2 InvalidProof.
	ErrInvalidProof = errors.New("invalid proof")
)

// Proof carries the hex-encoded Soroban BLS12-381 blobs (as produced by the prover / shared schema).
type Proof struct {
	A          string
	B          string
	C          string
	Commitment string
	Nullifier  string
}

// Submitter relays a transfer to the contract and returns the transaction hash.
type Submitter interface {
	Submit(ctx context.Context, p Proof) (txHash string, err error)
}

// CLISubmitter shells out to the `stellar` CLI.
type CLISubmitter struct {
	Bin        string
	ContractID string
	Source     string
	Network    string
}

var txHashRe = regexp.MustCompile(`[0-9a-f]{64}`)

// Submit invokes `submit(...)` on the contract as a state-changing transaction.
func (s CLISubmitter) Submit(ctx context.Context, p Proof) (string, error) {
	args := []string{
		"contract", "invoke",
		"--id", s.ContractID,
		"--source", s.Source,
		"--network", s.Network,
		"--send=yes",
		"--",
		"submit",
		"--proof_a", p.A,
		"--proof_b", p.B,
		"--proof_c", p.C,
		"--commitment", p.Commitment,
		"--nullifier", p.Nullifier,
	}
	out, err := exec.CommandContext(ctx, s.Bin, args...).CombinedOutput()
	text := string(out)

	if err != nil {
		switch {
		case strings.Contains(text, "Error(Contract, #1)"):
			return "", ErrReplay
		case strings.Contains(text, "Error(Contract, #2)"):
			return "", ErrInvalidProof
		default:
			return "", fmt.Errorf("stellar invoke failed: %w: %s", err, lastLines(text, 3))
		}
	}

	// Best-effort tx hash from the signing line; empty is acceptable (status still tracked).
	if m := txHashRe.FindString(text); m != "" {
		return m, nil
	}
	return "", nil
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}
