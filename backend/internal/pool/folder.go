package pool

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/prova/shared/schema"
)

// Folder turns queued commitments into spendable notes.
//
// # Why this exists
//
// The contract cannot hash — one on-chain Poseidon permutation costs ~11M CPU against a 100M budget
// (§10.1) — so it queues new commitments instead of inserting them into the Merkle tree. This
// service does the hashing off-chain, proves it was done correctly, and submits that proof. Until it
// runs, a note exists and is safe but has no leaf, and a spend proof needs a leaf.
//
// # Operational weight
//
// If the folder stops, **deposits and transfers keep working and no money is at risk — but nothing
// new becomes spendable.** That is the failure to alert on, and `queue_depth` is the signal.
//
// # What it is trusted with: nothing
//
// The proof enforces correctness, and the contract passes the leaves from *its own* queue rather
// than trusting anything submitted here. A folder cannot mint, steal, reorder, skip or duplicate.
// Its only power is to stop. That is why `update_root` is permissionless — if this service dies,
// anyone can take over — and why running it here is an availability decision, not a trust one.
type Folder struct {
	tree     TreeSource
	prover   FoldProver
	submit   RootSubmitter
	logger   *slog.Logger
	interval time.Duration
}

// TreeSource is the slice of the store the folder needs: what is waiting, and what is already in
// the tree. Narrow on purpose — it keeps the folder's failure handling testable without a database,
// and this is logic where "what happens when the submit fails" matters more than the happy path.
type TreeSource interface {
	PendingLeaves(ctx context.Context, limit int) ([]string, error)
	FoldedLeaves(ctx context.Context) ([]string, error)
}

// FoldProver produces the proof that a batch appends correctly.
type FoldProver interface {
	ProveFold(ctx context.Context, leaves, next []string) (*FoldProof, error)
}

// RootSubmitter submits a fold to the chain.
type RootSubmitter interface {
	UpdateRoot(ctx context.Context, proofHex, newRoot string, count int) (txHash string, err error)
}

// NewFolder builds the folder. `tree` is normally the *store.Store.
func NewFolder(
	tree TreeSource,
	prover FoldProver,
	submit RootSubmitter,
	logger *slog.Logger,
	interval time.Duration,
) *Folder {
	return &Folder{tree: tree, prover: prover, submit: submit, logger: logger, interval: interval}
}

// Run folds on a timer until the context is cancelled.
//
// Run **exactly one** of these. Two folders would race to fold the same queue head: the loser's
// proof is rejected because the root moved under it, so nothing breaks — but it is pure waste, and
// the wasted work is a ~1.5 s proof each time.
func (f *Folder) Run(ctx context.Context) {
	ticker := time.NewTicker(f.interval)
	defer ticker.Stop()

	for {
		if err := f.foldOnce(ctx); err != nil && !errors.Is(err, errNothingToFold) {
			// Nothing is advanced locally on failure. The chain is the source of truth and the
			// indexer reads the result back, so a failed fold costs a retry and nothing else.
			f.logger.Warn("fold failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// errNothingToFold is the common, uninteresting case: an empty queue.
var errNothingToFold = errors.New("nothing to fold")

// foldOnce folds up to one batch.
func (f *Folder) foldOnce(ctx context.Context) error {
	pending, err := f.tree.PendingLeaves(ctx, schema.MerkleBatch)
	if err != nil {
		return fmt.Errorf("read queue: %w", err)
	}
	if len(pending) == 0 {
		return errNothingToFold
	}

	// The tree as this backend understands it. If the mirror is behind the chain, the proof's
	// oldRoot will not match and the contract rejects it — safe, and the next tick retries once the
	// indexer has caught up.
	leaves, err := f.tree.FoldedLeaves(ctx)
	if err != nil {
		return fmt.Errorf("read tree: %w", err)
	}

	started := time.Now()
	proof, err := f.prover.ProveFold(ctx, leaves, pending)
	if err != nil {
		return fmt.Errorf("prove fold: %w", err)
	}
	proveTook := time.Since(started)

	txHash, err := f.submit.UpdateRoot(ctx, proof.Proof, proof.NewRoot, proof.Count)
	if err != nil {
		if errors.Is(err, ErrStaleFold) {
			// Another fold landed first, or the mirror was behind. Expected under concurrency and
			// not worth alarming about — the queue is unchanged and the next tick picks it up.
			f.logger.Info("fold superseded, will retry", "count", proof.Count)
			return nil
		}
		return fmt.Errorf("submit fold: %w", err)
	}

	f.logger.Info("folded",
		"count", proof.Count,
		"start_index", proof.StartIndex,
		"new_root", proof.NewRoot,
		"prove_ms", proveTook.Milliseconds(),
		"tx", txHash)

	// Deliberately no local write: the indexer records the new root when it reads the event back.
	// One writer for tree state means the mirror can never disagree with the chain.
	return nil
}

// ErrStaleFold means the contract rejected the fold because its view had already moved on — another
// folder won the race, or this backend's mirror was behind. Retryable, not a fault.
var ErrStaleFold = errors.New("fold is stale; the root moved")

// CLIRootSubmitter submits folds with the `stellar` CLI, matching how transfers are relayed today.
type CLIRootSubmitter struct {
	Bin        string
	ContractID string
	Source     string
	Network    string
}

var foldTxHashRe = regexp.MustCompile(`[0-9a-f]{64}`)

// UpdateRoot invokes `update_root(proof, new_root, count)`.
//
// The proof blob is split back into A/B/C because that is the contract's `Proof` struct shape; the
// contract rebuilds the public inputs from its own queue, so nothing here is trusted.
func (s CLIRootSubmitter) UpdateRoot(ctx context.Context, proofHex, newRoot string, count int) (string, error) {
	// A(96) ‖ B(192) ‖ C(96) = 384 bytes = 768 hex chars.
	if len(proofHex) != 768 {
		return "", fmt.Errorf("fold proof is %d hex chars, expected 768", len(proofHex))
	}
	a, b, c := proofHex[:192], proofHex[192:576], proofHex[576:]

	args := []string{
		"contract", "invoke",
		"--id", s.ContractID,
		"--source", s.Source,
		"--network", s.Network,
		"--send=yes",
		"--",
		"update_root",
		"--proof", fmt.Sprintf(`{"a":"%s","b":"%s","c":"%s"}`, a, b, c),
		"--new_root", newRoot,
		"--count", strconv.Itoa(count),
	}
	out, err := exec.CommandContext(ctx, s.Bin, args...).CombinedOutput()
	text := string(out)

	if err != nil {
		switch {
		// Error #4 InvalidProof / #6 InvalidBatch both mean this fold no longer matches the
		// contract's state — the usual cause is a concurrent fold, not a bug.
		case strings.Contains(text, "Error(Contract, #4)"),
			strings.Contains(text, "Error(Contract, #6)"):
			return "", ErrStaleFold
		default:
			return "", fmt.Errorf("stellar invoke failed: %w: %s", err, lastFoldLines(text, 3))
		}
	}
	return foldTxHashRe.FindString(text), nil
}

func lastFoldLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}
