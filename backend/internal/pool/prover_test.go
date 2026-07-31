package pool

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// These run against the REAL prover binary, not a stub.
//
// The whole reason this package shells out is that the tree must agree bit-for-bit with the circuit
// and the on-chain root — a second Poseidon in Go would be a permanent opportunity to drift, and
// drift does not fail loudly, it makes notes unspendable. A mocked prover would test the mock and
// prove nothing about that agreement, so these are integration tests by design and skip when the
// binary is absent rather than pretending to pass.

func proverBin(t *testing.T) Prover {
	t.Helper()

	if bin := os.Getenv("PROVER_BIN"); bin != "" {
		return Prover{Bin: bin}
	}
	// The path a local `cargo build --release` produces.
	built, err := filepath.Abs("../../../circuits/prover/target/release/prova-prover")
	if err == nil {
		if _, statErr := os.Stat(built); statErr == nil {
			return Prover{Bin: built}
		}
	}
	if path, lookErr := exec.LookPath("prova-prover"); lookErr == nil {
		return Prover{Bin: path}
	}

	t.Skip("prova-prover not built; run `cargo build --release` in circuits/prover or set PROVER_BIN")
	return Prover{}
}

// A handful of distinct, non-zero commitments. Zero is the empty-leaf value and the fold circuit
// rejects it in an active slot, so test data must never use it.
func testLeaves(n int) []string {
	out := make([]string, 0, n)
	for i := 1; i <= n; i++ {
		out = append(out, "00000000000000000000000000000000000000000000000000000000000000"+hexByte(byte(i)))
	}
	return out
}

func hexByte(b byte) string {
	const digits = "0123456789abcdef"
	return string([]byte{digits[b>>4], digits[b&0x0f]})
}

func TestMerklePathShapeAndConsistency(t *testing.T) {
	p := proverBin(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	leaves := testLeaves(5)

	var root string
	for i := range leaves {
		path, err := p.MerklePathFor(ctx, leaves, int64(i))
		if err != nil {
			t.Fatalf("path for leaf %d: %v", i, err)
		}
		if path.LeafIndex != int64(i) {
			t.Errorf("leaf %d: got index %d", i, path.LeafIndex)
		}
		// Exactly MerkleDepth siblings, or the in-circuit membership gadget cannot consume it.
		if len(path.Siblings) != 20 {
			t.Fatalf("leaf %d: got %d siblings, want 20 (MerkleDepth)", i, len(path.Siblings))
		}
		for j, s := range path.Siblings {
			if len(s) != 64 {
				t.Errorf("leaf %d sibling %d is %d chars, want 64", i, j, len(s))
			}
		}
		// Every leaf of the same tree must report the same root; a differing one would mean paths
		// are being built against inconsistent trees.
		if i == 0 {
			root = path.Root
		} else if path.Root != root {
			t.Fatalf("leaf %d reports root %s, leaf 0 reported %s", i, path.Root, root)
		}
	}
}

// A path is only meaningful against the whole tree, so an out-of-range index must be refused rather
// than silently returning a path that verifies against nothing.
func TestMerklePathRejectsOutOfRangeLeaf(t *testing.T) {
	p := proverBin(t)
	ctx := context.Background()
	leaves := testLeaves(3)

	if _, err := p.MerklePathFor(ctx, leaves, 3); err == nil {
		t.Error("index == len(leaves) must be rejected")
	}
	if _, err := p.MerklePathFor(ctx, leaves, -1); err == nil {
		t.Error("a negative index must be rejected")
	}
}

// The root a fold advances to must equal the root a path reports once those leaves are in the tree.
// This is the agreement the whole design rests on: the contract stores the fold's root, and wallets
// prove against the path's root. If they ever differ, every spend fails.
func TestFoldRootMatchesMerklePathRoot(t *testing.T) {
	p := proverBin(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	existing := testLeaves(2)
	incoming := []string{testLeaves(3)[2]}

	proof, err := p.ProveFold(ctx, existing, incoming)
	if err != nil {
		t.Fatalf("fold: %v", err)
	}
	if proof.Count != 1 {
		t.Errorf("count = %d, want 1", proof.Count)
	}
	if proof.StartIndex != 2 {
		t.Errorf("startIndex = %d, want 2 (appending after two leaves)", proof.StartIndex)
	}
	// A(96) + B(192) + C(96) = 384 bytes = 768 hex chars.
	if len(proof.Proof) != 768 {
		t.Errorf("proof blob is %d hex chars, want 768", len(proof.Proof))
	}
	if proof.OldRoot == proof.NewRoot {
		t.Error("a fold must advance the root")
	}

	after := append(append([]string{}, existing...), incoming...)
	path, err := p.MerklePathFor(ctx, after, 2)
	if err != nil {
		t.Fatalf("path: %v", err)
	}
	if path.Root != proof.NewRoot {
		t.Fatalf("fold advanced to %s but the path proves against %s — the contract and wallets "+
			"would disagree and every spend would fail", proof.NewRoot, path.Root)
	}
}

func TestProveFoldRejectsEmptyBatch(t *testing.T) {
	p := proverBin(t)
	if _, err := p.ProveFold(context.Background(), testLeaves(2), nil); err == nil {
		t.Error("an empty fold is meaningless and must be refused")
	}
}

// Folding more than MerkleBatch cannot be proved — the circuit has exactly BATCH slots — so it must
// fail here rather than produce a proof the contract will reject.
func TestProveFoldRejectsOversizedBatch(t *testing.T) {
	p := proverBin(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if _, err := p.ProveFold(ctx, nil, testLeaves(9)); err == nil {
		t.Error("a batch larger than MerkleBatch (8) must be refused")
	}
}
