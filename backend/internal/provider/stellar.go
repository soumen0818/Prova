package provider

import (
	"context"
	"errors"
	"fmt"

	"github.com/prova/backend/internal/pool"
)

// StellarSettlement is the SettlementProvider backed by the Soroban shielded pool.
//
// A thin adapter over the existing relayer, deliberately: the relayer is deployed, tested and has
// moved real value, so this maps its behaviour onto the interface rather than reimplementing it.
// The one thing added is idempotency bookkeeping (see Settle).
//
// # What Stellar custodies
//
// Today the pool contract holds the tokens AND verifies the proof, in one transaction. That means
// settlement here is atomic with verification — nothing moves without a valid proof, because the
// contract checking the proof is the contract holding the money. Any future architecture that
// separates these loses that property and must say what replaces it (Docs/progress.md §1.3).
type StellarSettlement struct {
	relay *pool.Relayer
}

// NewStellarSettlement wraps a relayer. A nil relayer is valid and yields an unavailable provider —
// users can still submit their own transactions, losing submitter privacy but nothing else.
func NewStellarSettlement(relay *pool.Relayer) *StellarSettlement {
	return &StellarSettlement{relay: relay}
}

func (s *StellarSettlement) Name() string { return "stellar-soroban-pool" }

func (s *StellarSettlement) Available() bool { return s.relay != nil }

// Settle submits a spend to the shielded pool.
//
// # Idempotency
//
// This operation is idempotent by construction rather than by bookkeeping, which is stronger. Each
// spend publishes a nullifier, and the contract rejects a nullifier it has already seen. So a
// duplicate submission cannot move value twice — it is refused on-chain, and surfaces here as
// ErrAlreadySettled.
//
// That is why IdempotencyKey is not consulted: the nullifier already IS the key, enforced by the
// contract instead of by this process. A key-based cache would be strictly weaker, since it would
// live in one replica's memory while the guarantee needs to hold across all of them.
func (s *StellarSettlement) Settle(ctx context.Context, req SettlementRequest) (*SettlementResult, error) {
	if s.relay == nil {
		return nil, ErrUnavailable
	}

	spend := pool.SpendRequest{
		ProofHex:    req.ProofHex,
		Root:        req.Root,
		Nullifier:   req.Nullifier,
		CurrentTime: req.CurrentTime,
		Amount:      req.Amount,
		Destination: req.Destination,
		Outputs: pool.SpendOutputs{
			C1:         req.Outputs.C1,
			C2:         req.Outputs.C2,
			EpkX:       req.Outputs.EpkX,
			EpkY:       req.Outputs.EpkY,
			Enc1Amount: req.Outputs.Enc1Amount,
			Enc1Rho:    req.Outputs.Enc1Rho,
			Enc2Amount: req.Outputs.Enc2Amount,
			Enc2Rho:    req.Outputs.Enc2Rho,
		},
	}

	var (
		txHash string
		err    error
	)
	switch req.Kind {
	case KindUnshield:
		txHash, err = s.relay.Unshield(ctx, spend)
	default:
		txHash, err = s.relay.Transact(ctx, spend)
	}
	if err != nil {
		return nil, translateRelayError(err)
	}
	return &SettlementResult{TxHash: txHash, Settled: true}, nil
}

// translateRelayError maps the relayer's typed errors onto the provider vocabulary.
//
// The relayer's detail is preserved with %w so operators keep the CLI's own words, while callers
// branch on the provider-level error. Anything unrecognised passes through unwrapped rather than
// being forced into a category it does not belong to — a wrong category here would have a caller
// retry something terminal, or give up on something recoverable.
func translateRelayError(err error) error {
	// Both errors are wrapped with %w, so errors.Is matches the provider category AND the relayer's
	// original. That matters in both directions: callers branch on the category, while an operator
	// reading a log still reaches the CLI's own words — which is the only thing that distinguishes
	// contract error #4 from a serialisation mismatch.
	//
	// A single `%w: %s` would wrap only the first and stringify the second, silently cutting the
	// underlying error out of the chain.
	switch {
	case errors.Is(err, pool.ErrNoteAlreadySpent):
		// The contract refused a nullifier it has already seen. Either a genuine double-spend
		// attempt or — far more often — an honest retry of something that already landed. Both mean
		// the value moved exactly once, which is what ErrAlreadySettled says.
		return fmt.Errorf("%w: %w", ErrAlreadySettled, err)
	case errors.Is(err, pool.ErrSpendRejected):
		return fmt.Errorf("%w: %w", ErrProofRejected, err)
	case errors.Is(err, pool.ErrRootExpired):
		return fmt.Errorf("%w: %w", ErrRootExpired, err)
	case errors.Is(err, pool.ErrPoolPaused):
		return fmt.Errorf("%w: %w", ErrPaused, err)
	default:
		return err
	}
}

// StellarPrivacy is the PrivacyProvider backed by the Soroban pool and its indexer.
//
// "Privacy provider" is accurate but worth reading carefully: this serves only PUBLIC state — the
// tree, the spent set, the queue. The private half (note secrets, amounts, the proofs themselves)
// never reaches the backend at all, which is the property the whole design exists to protect.
type StellarPrivacy struct {
	svc *pool.Service
}

// NewStellarPrivacy wraps the pool service. A nil service yields a provider whose methods report
// unavailability rather than panicking — the indexer is optional in some deployments.
func NewStellarPrivacy(svc *pool.Service) *StellarPrivacy {
	return &StellarPrivacy{svc: svc}
}

func (p *StellarPrivacy) Name() string { return "stellar-soroban-pool" }

func (p *StellarPrivacy) MerklePath(ctx context.Context, commitment string) (*MerklePath, error) {
	if p.svc == nil {
		return nil, ErrUnavailable
	}
	path, err := p.svc.MerklePathFor(ctx, commitment)
	if err != nil {
		// ErrNotFolded and "unknown" are different answers to a user: one is "wait", the other is
		// "we have never seen this". Preserved as distinct errors rather than collapsed.
		if errors.Is(err, pool.ErrNotFolded) {
			return nil, fmt.Errorf("%w: %s", ErrNotFolded, commitment)
		}
		return nil, err
	}
	return &MerklePath{
		LeafIndex: path.LeafIndex,
		Siblings:  path.Siblings,
		Root:      path.Root,
	}, nil
}

func (p *StellarPrivacy) SpentNullifiers(ctx context.Context, nullifiers []string) ([]string, error) {
	if p.svc == nil {
		return nil, ErrUnavailable
	}
	return p.svc.SpentNullifiers(ctx, nullifiers)
}

func (p *StellarPrivacy) State(ctx context.Context) (*PrivacyState, error) {
	if p.svc == nil {
		return nil, ErrUnavailable
	}
	st, err := p.svc.Status(ctx)
	if err != nil {
		return nil, err
	}
	return &PrivacyState{
		Root:       string(st.Root),
		TreeSize:   st.TreeSize,
		QueueDepth: st.QueueDepth,
	}, nil
}
