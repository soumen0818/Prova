package pool

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// Relayer submits a user's spend on their behalf.
//
// # Why a relayer at all
//
// The proof already hides the amount and the parties. But *someone* has to pay the transaction fee
// and sign the submission, and if that is the user's own Stellar account then the chain records
// "this account submitted a spend" next to the nullifier. The cryptography would be intact and the
// privacy still gone.
//
// So the backend submits instead, and every spend arrives from the same relayer account. What an
// observer learns is "Prova relayed a transfer", which is true of every transfer.
//
// # What the relayer is trusted with
//
// It cannot steal, redirect or alter anything: the amount, both output notes, the payout destination
// and the encrypted payloads are all bound inside the proof (§10.5, §2). Change any byte and the
// proof fails. Its powers are exactly two:
//
//   - **Refuse to submit.** Censorship, not theft. Mitigated because the contract is permissionless:
//     a user can always submit their own transaction and fall back to on-chain privacy only.
//   - **See the submission.** It handles the plaintext request, so it knows this proof passed
//     through it. It still cannot read the amount or the parties.
type Relayer struct {
	Bin        string
	ContractID string
	Source     string
	Network    string
}

// Typed contract outcomes, so callers can distinguish a user error from an outage.
var (
	// ErrNoteAlreadySpent = contract Error #3 NullifierAlreadyUsed. A double-spend attempt, or an
	// honest retry of something that already landed.
	ErrNoteAlreadySpent = errors.New("note already spent")
	// ErrSpendRejected = contract Error #4 InvalidProof.
	ErrSpendRejected = errors.New("proof rejected")
	// ErrRootExpired = contract Error #5 UnknownRoot: the proof was built against a root that has
	// since aged out of the 32-root window. The wallet must refetch its path and re-prove.
	ErrRootExpired = errors.New("merkle root is no longer accepted; refetch the path and re-prove")
	// ErrPoolPaused = contract Error #10 Paused. Withdrawals are never paused, so this only ever
	// affects shield and transact.
	ErrPoolPaused = errors.New("deposits and transfers are paused")
)

// SpendOutputs are the two notes a spend creates, with their proof-bound encrypted payloads.
type SpendOutputs struct {
	C1         string
	C2         string
	EpkX       string
	EpkY       string
	Enc1Amount string
	Enc1Rho    string
	Enc2Amount string
	Enc2Rho    string
}

func (o SpendOutputs) json() string {
	return fmt.Sprintf(
		`{"c1":"%s","c2":"%s","epk_x":"%s","epk_y":"%s","enc1_amount":"%s","enc1_rho":"%s","enc2_amount":"%s","enc2_rho":"%s"}`,
		o.C1, o.C2, o.EpkX, o.EpkY, o.Enc1Amount, o.Enc1Rho, o.Enc2Amount, o.Enc2Rho)
}

// SpendRequest is a private transfer or an unshield.
//
// `Destination` and `Amount` are set only for an unshield. Both are bound inside the proof, so the
// relayer cannot redirect the payout or change how much leaves the pool.
type SpendRequest struct {
	ProofHex    string
	Root        string
	Nullifier   string
	Outputs     SpendOutputs
	CurrentTime uint64

	// Unshield only.
	Amount      int64
	Destination string
}

// Transact relays a fully private transfer: one note in, two notes out, no tokens move.
func (r Relayer) Transact(ctx context.Context, req SpendRequest) (string, error) {
	a, b, c, err := splitProof(req.ProofHex)
	if err != nil {
		return "", err
	}
	return r.invoke(ctx,
		"transact",
		"--proof", proofJSON(a, b, c),
		"--root", req.Root,
		"--nullifier", req.Nullifier,
		"--out", req.Outputs.json(),
		"--current_time", strconv.FormatUint(req.CurrentTime, 10),
	)
}

// Unshield relays a withdrawal: tokens leave the pool to a public destination.
func (r Relayer) Unshield(ctx context.Context, req SpendRequest) (string, error) {
	a, b, c, err := splitProof(req.ProofHex)
	if err != nil {
		return "", err
	}
	if req.Amount <= 0 {
		return "", fmt.Errorf("unshield amount must be positive")
	}
	if req.Destination == "" {
		return "", fmt.Errorf("unshield needs a destination")
	}
	return r.invoke(ctx,
		"unshield",
		"--proof", proofJSON(a, b, c),
		"--root", req.Root,
		"--nullifier", req.Nullifier,
		"--out", req.Outputs.json(),
		"--amount", strconv.FormatInt(req.Amount, 10),
		"--destination", req.Destination,
		"--current_time", strconv.FormatUint(req.CurrentTime, 10),
	)
}

// splitProof divides the blob into the contract's A/B/C fields.
//
// Checked rather than assumed: a wrong length would produce a silently malformed invocation whose
// failure looks like a proof rejection, sending anyone debugging it in the wrong direction.
func splitProof(hex string) (a, b, c string, err error) {
	// A(96) ‖ B(192) ‖ C(96) = 384 bytes = 768 hex chars.
	if len(hex) != 768 {
		return "", "", "", fmt.Errorf("proof blob is %d hex chars, expected 768", len(hex))
	}
	return hex[:192], hex[192:576], hex[576:], nil
}

func proofJSON(a, b, c string) string {
	return fmt.Sprintf(`{"a":"%s","b":"%s","c":"%s"}`, a, b, c)
}

// invoke runs the CLI and maps contract errors onto typed ones.
func (r Relayer) invoke(ctx context.Context, fn string, callArgs ...string) (string, error) {
	args := append([]string{
		"contract", "invoke",
		"--id", r.ContractID,
		"--source", r.Source,
		"--network", r.Network,
		"--send=yes",
		"--",
	}, callArgs...)

	out, err := exec.CommandContext(ctx, r.Bin, args...).CombinedOutput()
	text := string(out)
	if err == nil {
		return foldTxHashRe.FindString(text), nil
	}

	// Contract error numbers come from the `Error` enum in contracts/pool/src/lib.rs. Mapping them
	// here is what lets the API tell a user "your note was already spent" instead of "internal
	// error" — the difference between a clear message and a support ticket.
	switch {
	case strings.Contains(text, "Error(Contract, #3)"):
		return "", ErrNoteAlreadySpent
	case strings.Contains(text, "Error(Contract, #4)"):
		return "", ErrSpendRejected
	case strings.Contains(text, "Error(Contract, #5)"):
		return "", ErrRootExpired
	case strings.Contains(text, "Error(Contract, #10)"):
		return "", ErrPoolPaused
	default:
		return "", fmt.Errorf("%s failed: %w: %s", fn, err, lastFoldLines(text, 3))
	}
}
