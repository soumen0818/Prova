package pool

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// The folder's happy path is the boring part. What matters is its behaviour when things go wrong,
// because it runs unattended on a timer: a fold that fails must leave the queue exactly as it found
// it, so the next tick retries rather than losing notes.

type fakeTree struct {
	pending  []string
	folded   []string
	pendErr  error
	foldErr  error
	pendCall int
	// queueIdx is the contract's position for the oldest pending note. A pointer so that "unset"
	// means "in sync" — otherwise every existing test would have to state a queue index just to
	// stay on the healthy path, and the zero value would be indistinguishable from a real 0.
	queueIdx *int64
	queueErr error
}

func (f *fakeTree) LowestPendingQueueIndex(_ context.Context) (int64, error) {
	if f.queueErr != nil {
		return 0, f.queueErr
	}
	if f.queueIdx != nil {
		return *f.queueIdx, nil
	}
	// In sync: the contract's next slot is exactly what this tree has folded.
	return int64(len(f.folded)), nil
}

func (f *fakeTree) PendingLeaves(_ context.Context, limit int) ([]string, error) {
	f.pendCall++
	if f.pendErr != nil {
		return nil, f.pendErr
	}
	if len(f.pending) > limit {
		return f.pending[:limit], nil
	}
	return f.pending, nil
}

func (f *fakeTree) FoldedLeaves(context.Context) ([]string, error) {
	if f.foldErr != nil {
		return nil, f.foldErr
	}
	return f.folded, nil
}

type fakeProver struct {
	proof *FoldProof
	err   error
	calls int
}

func (p *fakeProver) ProveFold(_ context.Context, _, next []string) (*FoldProof, error) {
	p.calls++
	if p.err != nil {
		return nil, p.err
	}
	out := *p.proof
	out.Count = len(next)
	return &out, nil
}

type fakeSubmitter struct {
	err    error
	calls  int
	gotHex string
	gotN   int
}

func (s *fakeSubmitter) UpdateRoot(_ context.Context, proofHex, _ string, count int) (string, error) {
	s.calls++
	s.gotHex, s.gotN = proofHex, count
	return "txhash", s.err
}

func newFolder(tree TreeSource, prover FoldProver, sub RootSubmitter) *Folder {
	return NewFolder(tree, prover, sub, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Second)
}

func sampleProof() *FoldProof {
	return &FoldProof{
		Proof:      strings.Repeat("ab", 384),
		OldRoot:    strings.Repeat("11", 32),
		NewRoot:    strings.Repeat("22", 32),
		StartIndex: 0,
		Count:      1,
	}
}

// An empty queue is the normal state most of the time; it must not prove, submit, or log an error.
func TestFolderDoesNothingWhenTheQueueIsEmpty(t *testing.T) {
	prover := &fakeProver{proof: sampleProof()}
	sub := &fakeSubmitter{}
	f := newFolder(&fakeTree{}, prover, sub)

	err := f.foldOnce(context.Background())
	if !errors.Is(err, errNothingToFold) {
		t.Fatalf("got %v, want errNothingToFold", err)
	}
	if prover.calls != 0 || sub.calls != 0 {
		t.Errorf("an empty queue must not prove (%d) or submit (%d)", prover.calls, sub.calls)
	}
}

func TestFolderProvesAndSubmitsAWaitingBatch(t *testing.T) {
	tree := &fakeTree{pending: []string{"aa", "bb"}, folded: []string{"01"}}
	prover := &fakeProver{proof: sampleProof()}
	sub := &fakeSubmitter{}
	f := newFolder(tree, prover, sub)

	if err := f.foldOnce(context.Background()); err != nil {
		t.Fatalf("fold: %v", err)
	}
	if sub.calls != 1 {
		t.Fatalf("expected one submission, got %d", sub.calls)
	}
	if sub.gotN != 2 {
		t.Errorf("submitted count = %d, want 2", sub.gotN)
	}
}

// A batch is capped at MerkleBatch because the circuit has exactly that many slots — asking for more
// would produce a proof the contract cannot accept.
func TestFolderNeverExceedsOneBatch(t *testing.T) {
	tree := &fakeTree{pending: make([]string, 20)}
	for i := range tree.pending {
		tree.pending[i] = "cc"
	}
	prover := &fakeProver{proof: sampleProof()}
	sub := &fakeSubmitter{}

	if err := newFolder(tree, prover, sub).foldOnce(context.Background()); err != nil {
		t.Fatalf("fold: %v", err)
	}
	if sub.gotN > 8 {
		t.Errorf("submitted %d leaves, must never exceed MerkleBatch (8)", sub.gotN)
	}
}

// Losing a race with another folder is expected under concurrency, not a fault. It must be swallowed
// so it neither pages anyone nor stops the loop — the queue is untouched and the next tick retries.
func TestFolderTreatsAStaleFoldAsRetryable(t *testing.T) {
	tree := &fakeTree{pending: []string{"aa"}}
	sub := &fakeSubmitter{err: ErrStaleFold}
	f := newFolder(tree, &fakeProver{proof: sampleProof()}, sub)

	if err := f.foldOnce(context.Background()); err != nil {
		t.Fatalf("a stale fold must not be reported as a failure, got %v", err)
	}
}

// Any other submission failure IS worth reporting — it could be a broken relayer key or an
// unreachable RPC, and silence would let the queue grow unnoticed.
func TestFolderReportsRealSubmissionFailures(t *testing.T) {
	tree := &fakeTree{pending: []string{"aa"}}
	sub := &fakeSubmitter{err: errors.New("rpc unreachable")}
	f := newFolder(tree, &fakeProver{proof: sampleProof()}, sub)

	err := f.foldOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "rpc unreachable") {
		t.Fatalf("expected the submission error to surface, got %v", err)
	}
}

func TestFolderReportsProvingFailures(t *testing.T) {
	tree := &fakeTree{pending: []string{"aa"}}
	sub := &fakeSubmitter{}
	f := newFolder(tree, &fakeProver{err: errors.New("prover crashed")}, sub)

	err := f.foldOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "prover crashed") {
		t.Fatalf("expected the proving error to surface, got %v", err)
	}
	if sub.calls != 0 {
		t.Error("a failed proof must never be submitted")
	}
}

// A database read failure must abort before proving. Proving on a partial view would produce a fold
// against the wrong tree — rejected on-chain, but a wasted ~1.5 s every tick.
func TestFolderAbortsIfItCannotReadTheTree(t *testing.T) {
	tree := &fakeTree{pending: []string{"aa"}, foldErr: errors.New("db down")}
	prover := &fakeProver{proof: sampleProof()}
	f := newFolder(tree, prover, &fakeSubmitter{})

	if err := f.foldOnce(context.Background()); err == nil {
		t.Fatal("expected an error when the tree cannot be read")
	}
	if prover.calls != 0 {
		t.Error("must not prove against an unreadable tree")
	}
}

// The CLI submitter splits the blob into the contract's A/B/C fields; a wrong length would produce a
// silently malformed invocation, so it is rejected up front.
func TestCLIRootSubmitterRejectsAMalformedProofBlob(t *testing.T) {
	s := CLIRootSubmitter{Bin: "stellar", ContractID: "C...", Source: "src", Network: "testnet"}
	if _, err := s.UpdateRoot(context.Background(), "tooshort", "root", 1); err == nil {
		t.Fatal("a proof blob of the wrong length must be rejected before invoking the CLI")
	}
}

func TestRunStopsOnContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	f := newFolder(&fakeTree{}, &fakeProver{proof: sampleProof()}, &fakeSubmitter{})

	done := make(chan struct{})
	go func() { f.Run(ctx); close(done) }()
	cancel()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop on cancellation")
	}
}

// A backend started against a pool that already has folded notes cannot fold, and must say so.
//
// This is the failure that stranded a real deposit: the contract had 2 leaves, a fresh database had
// 0, and every proof built from the short tree was rejected. The folder retried every 8 seconds for
// half an hour while the balance sat at "confirming" and the logs said only "fold failed".
//
// Waiting cannot fix it — the missing notes were learned from chain events, and Soroban RPC serves
// only a rolling ~7-day window — so the folder must refuse loudly rather than retry silently.
func TestFolderRefusesWhenTheLocalTreeIsMissingLeaves(t *testing.T) {
	contractHasFolded := int64(2)
	tree := &fakeTree{
		pending:  []string{"aa"},
		folded:   nil, // fresh database: nothing folded locally
		queueIdx: &contractHasFolded,
	}
	prover := &fakeProver{}
	submitter := &fakeSubmitter{}
	f := newFolder(tree, prover, submitter)

	err := f.foldOnce(context.Background())
	if !errors.Is(err, errTreeGap) {
		t.Fatalf("foldOnce() = %v, want errTreeGap", err)
	}
	// Proving is expensive and submitting costs a fee. Neither should be attempted for a batch
	// that cannot possibly be accepted.
	if prover.calls != 0 {
		t.Errorf("prover was called %d times, want 0", prover.calls)
	}
	if submitter.calls != 0 {
		t.Errorf("submitter was called %d times, want 0", submitter.calls)
	}
}
