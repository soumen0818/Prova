// Package pool serves the shielded pool's off-chain half: the Merkle tree a wallet needs to build a
// spend proof, the note feed it scans for incoming money, and the folder that makes new notes
// spendable (Docs/shielded-pool.md §10.7).
//
// # Why the maths lives in Rust
//
// The tree is hashed with Poseidon, and the on-chain root, the in-circuit membership check and this
// mirror must agree **bit-for-bit**. A second Poseidon implementation in Go would be a permanent
// opportunity for the two to drift, and drift here does not fail loudly — it silently makes notes
// unspendable. So this package shells out to `prova-prover`, exactly as credential issuance already
// does, and the hash exists in exactly one place.
package pool

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
)

// Prover runs the prover CLI for tree operations.
type Prover struct {
	// Bin is the prova-prover binary (config.ProverBin).
	Bin string
	// FoldKeyCache, if set, is where the fold proving key is cached.
	//
	// Generating it costs ~1.5 s and the folder runs every few seconds, so paying that per
	// invocation would dominate fold latency. The setup is seeded and deterministic, so the cache is
	// a pure speed-up — deleting the file costs time, never correctness.
	FoldKeyCache string
	// Seed for the trusted setup; must match the verifying keys embedded in the contract.
	Seed uint64
}

// MerklePath is a membership path for one leaf.
type MerklePath struct {
	LeafIndex int64    `json:"leafIndex"`
	Siblings  []string `json:"siblings"`
	Root      string   `json:"root"`
}

// FoldProof is what `update_root` needs: the proof bytes plus the transition it attests to.
//
// The contract rebuilds the public inputs from its own queue rather than trusting these, which is
// exactly what stops a folder inserting commitments that were never queued. The values are carried
// here so the caller can sanity-check and log the transition.
type FoldProof struct {
	// Proof is A(96) ‖ B(192) ‖ C(96), hex-encoded.
	Proof      string `json:"proof"`
	OldRoot    string `json:"oldRoot"`
	NewRoot    string `json:"newRoot"`
	StartIndex int64  `json:"startIndex"`
	Count      int    `json:"count"`
}

// MerklePathFor rebuilds the tree from `leaves` (folded commitments, in leaf order) and returns the
// membership path for `index`.
//
// `leaves` must be every folded leaf, in order: a Merkle path is only meaningful against the whole
// tree, and a truncated list would produce a path that verifies against nothing.
func (p Prover) MerklePathFor(ctx context.Context, leaves []string, index int64) (*MerklePath, error) {
	if index < 0 || index >= int64(len(leaves)) {
		return nil, fmt.Errorf("leaf %d is outside the tree (%d leaves)", index, len(leaves))
	}
	input, err := json.Marshal(struct {
		Leaves []string `json:"leaves"`
		Index  int64    `json:"index"`
	}{nonNil(leaves), index})
	if err != nil {
		return nil, err
	}

	out, err := p.run(ctx, input, "merkle-path")
	if err != nil {
		return nil, err
	}
	var path MerklePath
	if err := json.Unmarshal(out, &path); err != nil {
		return nil, fmt.Errorf("decode merkle path: %w", err)
	}
	return &path, nil
}

// ProveFold proves that appending `next` to the tree built from `leaves` advances the root.
func (p Prover) ProveFold(ctx context.Context, leaves, next []string) (*FoldProof, error) {
	if len(next) == 0 {
		return nil, fmt.Errorf("nothing to fold")
	}
	input, err := json.Marshal(struct {
		Leaves []string `json:"leaves"`
		New    []string `json:"new"`
	}{nonNil(leaves), nonNil(next)})
	if err != nil {
		return nil, err
	}

	args := []string{"fold-prove"}
	if p.FoldKeyCache != "" {
		args = append(args, "--pk-cache", p.FoldKeyCache)
	}
	if p.Seed != 0 {
		args = append(args, "--seed", strconv.FormatUint(p.Seed, 10))
	}

	out, err := p.run(ctx, input, args...)
	if err != nil {
		return nil, err
	}
	var proof FoldProof
	if err := json.Unmarshal(out, &proof); err != nil {
		return nil, fmt.Errorf("decode fold proof: %w", err)
	}
	if proof.Count != len(next) {
		// The CLI verifies its own proof off-chain before emitting it, so this would mean the two
		// sides disagree about the batch — worth failing loudly rather than submitting.
		return nil, fmt.Errorf("fold proof covers %d leaves, expected %d", proof.Count, len(next))
	}
	return &proof, nil
}

// run pipes `input` to the CLI on stdin and returns stdout.
//
// stderr is captured and surfaced: the CLI reports refusals there (an out-of-range leaf, a proof
// that failed its own verification), and losing that turns a precise error into "exit status 1".
func (p Prover) run(ctx context.Context, input []byte, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, p.Bin, args...)
	cmd.Stdin = bytes.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if msg := stderr.String(); msg != "" {
			return nil, fmt.Errorf("%s: %w: %s", args[0], err, msg)
		}
		return nil, fmt.Errorf("%s: %w", args[0], err)
	}
	return stdout.Bytes(), nil
}

// nonNil guarantees a JSON array rather than `null`.
//
// A nil Go slice marshals to `null`, and the prover CLI's input types expect a sequence — so it
// panics rather than reporting a usable error. This bites in exactly the case that must work:
// the *first* fold, when no leaf has been folded yet and the folded-leaf list is legitimately
// empty. Left unguarded, the pool can never make its first note spendable.
func nonNil(xs []string) []string {
	if xs == nil {
		return []string{}
	}
	return xs
}
