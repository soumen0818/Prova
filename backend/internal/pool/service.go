package pool

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/prova/backend/internal/store"
	"github.com/prova/shared/schema"
)

// Service answers the questions a wallet cannot answer for itself.
//
// A wallet holds its own note secrets but has no view of the tree, so it needs three things from
// here: **where is my note** (leaf index), **how do I prove it** (membership path), and **what
// arrived for me** (the scan feed). Everything served is already public on-chain.
type Service struct {
	store  *store.Store
	prover Prover
	// relay submits spends so the user's own Stellar account is never linked to them. Nil disables
	// the relay endpoints; users can still submit their own transactions, losing submitter privacy
	// but nothing else.
	relay *Relayer
}

// NewService builds the pool service.
func NewService(st *store.Store, prover Prover, relay *Relayer) *Service {
	return &Service{store: st, prover: prover, relay: relay}
}

// ErrRelayUnavailable means no relayer is configured.
var ErrRelayUnavailable = errors.New("no relayer configured")

// Relay submits a spend on the user's behalf.
//
// The relayer can neither steal nor alter: the amount, both output notes, the destination and the
// encrypted payloads are all bound inside the proof. Its only powers are to refuse (censorship, not
// theft — the contract is permissionless, so the user can always submit themselves) and to observe
// that this proof passed through it.
func (s *Service) Relay(ctx context.Context, req schema.PoolSpendRequest) (string, error) {
	if s.relay == nil {
		return "", ErrRelayUnavailable
	}
	spend := SpendRequest{
		ProofHex:    string(req.Proof),
		Root:        string(req.Root),
		Nullifier:   string(req.Nullifier),
		CurrentTime: req.CurrentTime,
		Amount:      req.Amount,
		Destination: req.Destination,
		Outputs: SpendOutputs{
			C1:         string(req.Outputs.C1),
			C2:         string(req.Outputs.C2),
			EpkX:       string(req.Outputs.EpkX),
			EpkY:       string(req.Outputs.EpkY),
			Enc1Amount: string(req.Outputs.Enc1Amount),
			Enc1Rho:    string(req.Outputs.Enc1Rho),
			Enc2Amount: string(req.Outputs.Enc2Amount),
			Enc2Rho:    string(req.Outputs.Enc2Rho),
		},
	}

	// An unshield is exactly a spend that names a destination. The circuit enforces the converse —
	// a zero public amount forbids naming one — so these two paths cannot be confused.
	if req.Amount > 0 {
		return s.relay.Unshield(ctx, spend)
	}
	return s.relay.Transact(ctx, spend)
}

// ErrNotFolded means a commitment is queued but not yet in the tree, so it cannot be spent yet.
// Distinct from "unknown": the wallet should wait rather than treat the note as lost.
var ErrNotFolded = store.ErrNotFolded

// MerklePathFor returns the membership path for a commitment, so the wallet can build a spend proof.
func (s *Service) MerklePathFor(ctx context.Context, commitment string) (*MerklePath, error) {
	index, err := s.store.LeafIndexOf(ctx, commitment)
	if err != nil {
		return nil, err // ErrNotFound (unknown) or ErrNotFolded (still queued)
	}
	leaves, err := s.store.FoldedLeaves(ctx)
	if err != nil {
		return nil, err
	}
	path, err := s.prover.MerklePathFor(ctx, leaves, index)
	if err != nil {
		return nil, err
	}

	// The path is only usable if the root it hashes to is one the contract still accepts. Catching
	// a stale root here saves the user a rejected transaction and a wasted proof.
	known, err := s.RootIsAccepted(ctx, path.Root)
	if err != nil {
		return nil, err
	}
	if !known {
		return nil, fmt.Errorf("path root %s is not in the contract's accepted window", path.Root)
	}
	return path, nil
}

// RootIsAccepted reports whether `root` is still inside the contract's rolling history window.
//
// A proof against an evicted root is rejected on-chain, and the wallet has no way to know that on
// its own.
func (s *Service) RootIsAccepted(ctx context.Context, root string) (bool, error) {
	roots, err := s.store.RecentPoolRoots(ctx, schema.MerkleRootHistory)
	if err != nil {
		return false, err
	}
	for _, r := range roots {
		if r.Root == root {
			return true, nil
		}
	}
	return false, nil
}

// Scan returns notes from `after` onward for the wallet to trial-decrypt.
//
// Deliberately unfiltered: selecting by recipient server-side would tell the backend who is being
// paid, which is precisely the privacy the pool exists to provide. Wallets download everything and
// try each one; what opens is theirs.
func (s *Service) Scan(ctx context.Context, after int64, limit int) ([]schema.PoolNoteRecord, error) {
	if limit <= 0 || limit > schema.PoolScanMaxLimit {
		limit = schema.PoolScanMaxLimit
	}
	notes, err := s.store.ScanPoolNotes(ctx, after, limit)
	if err != nil {
		return nil, err
	}

	out := make([]schema.PoolNoteRecord, 0, len(notes))
	for _, n := range notes {
		rec := schema.PoolNoteRecord{
			QueueIndex: n.QueueIndex,
			Commitment: n.Commitment,
			Encrypted: schema.EncryptedNote{
				EpkX:      n.EpkX,
				EpkY:      n.EpkY,
				EncAmount: n.EncAmount,
				EncRho:    n.EncRho,
				Slot:      uint8(n.Slot),
			},
			Ledger: n.Ledger,
		}
		if n.Folded {
			rec.LeafIndex = &n.LeafIndex
		}
		out = append(out, rec)
	}
	return out, nil
}

// SpentNullifiers reports which of the given nullifiers are already spent, so a restored wallet can
// tell which of its notes are still worth money rather than trusting local state.
func (s *Service) SpentNullifiers(ctx context.Context, nullifiers []string) ([]string, error) {
	if len(nullifiers) > schema.PoolScanMaxLimit {
		return nil, fmt.Errorf("at most %d nullifiers per request", schema.PoolScanMaxLimit)
	}
	return s.store.SpentNullifiers(ctx, nullifiers)
}

// Status is the pool's public health: where the tree is, and whether the folder is keeping up.
func (s *Service) Status(ctx context.Context) (*schema.PoolStatus, error) {
	depth, err := s.store.QueueDepth(ctx)
	if err != nil {
		return nil, err
	}
	st := &schema.PoolStatus{QueueDepth: depth, Batch: schema.MerkleBatch}

	// The folder's own report. A failure to read it must not fail the endpoint — the queue depth and
	// tree size are still worth serving, and this is diagnostics.
	if fs, ferr := s.store.FolderStatus(ctx); ferr == nil {
		st.FoldError = fs.LastError
		st.FoldFailures = fs.ConsecutiveFailures
		if fs.LastSuccessAt != nil {
			st.LastFoldAt = fs.LastSuccessAt.UTC().Format(time.RFC3339)
		}
		st.RelayError = fs.LastRelayError
		if fs.LastRelayAt != nil {
			st.RelayAt = fs.LastRelayAt.UTC().Format(time.RFC3339)
		}
	}

	root, err := s.store.LatestPoolRoot(ctx)
	switch {
	case errors.Is(err, store.ErrNotFound):
		// Nothing folded yet — a brand-new pool, not an error.
	case err != nil:
		return nil, err
	default:
		st.Root = root.Root
		st.TreeSize = root.NextIndex
		st.Ledger = root.Ledger
	}
	return st, nil
}
