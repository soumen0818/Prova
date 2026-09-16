package provider

import (
	"errors"
	"fmt"
	"strings"
)

/*
 * The settlement boundary (Docs/progress.md §3).
 *
 * # What a settlement intent is
 *
 * The one explicit join between the privacy layer and the value layer. Midnight proves a transfer is
 * *allowed*; Stellar moves the value. Something has to carry the first fact to the second, and this
 * is that something — named, versioned and carrying as little as possible.
 *
 * # Why it is not a second proof system
 *
 * Under Option C (Docs/v2-phase1-midnight-evaluation.md §1.3) the Soroban pool remains the custodian
 * and keeps enforcing everything it enforces today: note ownership, conservation, double-spend, and
 * KYC in-circuit. The Midnight proof runs *alongside* that, and this type is how the two are
 * compared.
 *
 * That makes the honest description of a compliance proof today: **advisory**. It is recorded,
 * compared and audited, and the value layer does not consult it. Saying otherwise would claim a
 * guarantee that does not exist — see ComplianceStatus for how that is kept visible rather than
 * assumed.
 *
 * # What it must not carry
 *
 * No amount, no recipient, no credential contents. The eligibility commitment is a hash, and the
 * settlement request's own fields are all bound inside the Soroban proof. A boundary type is the
 * most tempting place to smuggle "just one more field" across, which is exactly why this one is
 * small and its contents are justified individually.
 */

// IntentVersion is the wire format of a settlement intent.
//
// Versioned from the start because this crosses a boundary between two systems that will not always
// be deployed together. An unversioned structure forces a guess about what an old peer meant, and
// the guess is wrong exactly when it matters.
const IntentVersion = 1

// ComplianceStatus records what the privacy layer actually said about a transfer.
//
// Deliberately more than a boolean. "No proof was offered" and "a proof was offered and did not
// verify" are opposite facts — the first is a transfer from an older client, the second is either a
// bug or an attack — and collapsing them into `false` would hide the difference at the moment it is
// most worth seeing.
type ComplianceStatus string

const (
	// ComplianceNotAttempted means no Midnight proof accompanied this transfer.
	//
	// The expected state during the migration: clients that predate Midnight support produce
	// perfectly valid transfers, and the Soroban circuit is still enforcing KYC for all of them.
	ComplianceNotAttempted ComplianceStatus = "not_attempted"

	// ComplianceVerified means a Midnight proof was supplied and checked out.
	ComplianceVerified ComplianceStatus = "verified"

	// ComplianceFailed means a proof was supplied and did NOT verify.
	//
	// Never ignorable. Under Option C the settlement still proceeds — Soroban is the authority and
	// has its own KYC constraints — but a failure here means the two layers disagree about the same
	// transfer, and that is a fact somebody needs to look at rather than a number on a dashboard.
	ComplianceFailed ComplianceStatus = "failed"
)

// SettlementIntent is a verified statement that a transfer may proceed, plus what the privacy layer
// concluded about it.
//
// Carries the settlement request rather than duplicating its fields: the request's contents are
// bound inside the Soroban proof, and copying them here would create a second version of the truth
// that could drift from the first.
type SettlementIntent struct {
	// Version is IntentVersion at the time of creation.
	Version int

	// Settlement is what the value layer will execute. Every field is proof-bound.
	Settlement SettlementRequest

	// Compliance is what Midnight concluded. See ComplianceStatus.
	Compliance ComplianceStatus

	// EligibilityCommitment is the hash returned by the Midnight `proveEligibility` circuit.
	//
	// A handle, not a disclosure: it binds this settlement to one specific eligibility proof so the
	// two can be matched in an audit, and it reveals nothing further — recovering the credential
	// behind it would mean inverting a hash.
	//
	// Empty when Compliance is ComplianceNotAttempted.
	EligibilityCommitment string

	// ComplianceError is why verification failed, for an operator reading the record.
	//
	// Only set when Compliance is ComplianceFailed, and never returned to a user: a compliance
	// failure is not something a sender can act on, and the text is diagnostic rather than
	// explanatory.
	ComplianceError string
}

// Typed failures at the boundary.
var (
	// ErrIntentVersion means the intent came from an incompatible peer.
	ErrIntentVersion = errors.New("unsupported settlement intent version")

	// ErrIntentIncomplete means a required field is missing — a construction bug, not a user error.
	ErrIntentIncomplete = errors.New("settlement intent is incomplete")

	// ErrComplianceMismatch means the status and the evidence contradict each other: a verified
	// intent with no commitment, or a failure with no reason. Refused rather than repaired, because
	// a boundary type that silently fixes its own contradictions is one nobody can reason about.
	ErrComplianceMismatch = errors.New("compliance status does not match the evidence")
)

// NewIntent builds an intent for a transfer that carried no Midnight proof.
//
// The common path during migration, and deliberately the easiest one to construct correctly: a
// caller that knows nothing about compliance still produces a valid, honestly-labelled intent.
func NewIntent(req SettlementRequest) SettlementIntent {
	return SettlementIntent{
		Version:    IntentVersion,
		Settlement: req,
		Compliance: ComplianceNotAttempted,
	}
}

// WithCompliance records what the privacy layer concluded.
//
// Returns a copy rather than mutating: an intent that changes after it has been recorded is one
// where the audit trail and the decision can disagree.
func (i SettlementIntent) WithCompliance(status ComplianceStatus, commitment, reason string) SettlementIntent {
	i.Compliance = status
	i.EligibilityCommitment = commitment
	i.ComplianceError = reason
	return i
}

// Validate checks the intent is internally consistent before it is acted on.
//
// Structural only. It does not verify the Midnight proof — that happens where the proof system
// lives, and a boundary type that pretended to verify would be claiming an authority it does not
// have.
func (i SettlementIntent) Validate() error {
	if i.Version != IntentVersion {
		return fmt.Errorf("%w: got %d, want %d", ErrIntentVersion, i.Version, IntentVersion)
	}
	if strings.TrimSpace(i.Settlement.Nullifier) == "" {
		return fmt.Errorf("%w: no nullifier", ErrIntentIncomplete)
	}
	if strings.TrimSpace(i.Settlement.ProofHex) == "" {
		return fmt.Errorf("%w: no settlement proof", ErrIntentIncomplete)
	}

	switch i.Compliance {
	case ComplianceNotAttempted:
		// Nothing was claimed, so nothing may be attached. Evidence alongside "not attempted" means
		// a caller lost track of what it actually did.
		if i.EligibilityCommitment != "" || i.ComplianceError != "" {
			return fmt.Errorf("%w: not_attempted carries evidence", ErrComplianceMismatch)
		}
	case ComplianceVerified:
		// A verified claim with no commitment cannot be audited, which makes it indistinguishable
		// from an unverified one.
		if strings.TrimSpace(i.EligibilityCommitment) == "" {
			return fmt.Errorf("%w: verified without a commitment", ErrComplianceMismatch)
		}
		if i.ComplianceError != "" {
			return fmt.Errorf("%w: verified but carries an error", ErrComplianceMismatch)
		}
	case ComplianceFailed:
		// A failure with no reason tells an operator only that something is wrong, which is the
		// least useful moment to be vague.
		if strings.TrimSpace(i.ComplianceError) == "" {
			return fmt.Errorf("%w: failed without a reason", ErrComplianceMismatch)
		}
	default:
		return fmt.Errorf("%w: unknown status %q", ErrComplianceMismatch, i.Compliance)
	}
	return nil
}

// IdempotencyKey is what makes settlement exactly-once.
//
// The nullifier, not a generated id. That is the whole trick: the contract refuses a nullifier it
// has already seen, so a duplicate submission cannot move value twice — enforced on-chain, across
// every replica, rather than by bookkeeping in one process's memory.
//
// A generated key would be strictly weaker and would look stronger, which is the worst combination.
func (i SettlementIntent) IdempotencyKey() string {
	return i.Settlement.Nullifier
}

// AuthorisedBy reports what actually permits this settlement to proceed.
//
// Exists to make the trust model legible at the point of use rather than in a document somebody has
// to remember. Under Option C the answer is always the Soroban proof: the Midnight proof is
// evidence, not authority.
//
// The day that changes — when the pool contract verifies a Midnight proof reference directly — this
// function changes with it, and every caller reading it gets the new answer at once.
func (i SettlementIntent) AuthorisedBy() string {
	if i.Compliance == ComplianceVerified {
		return "soroban proof (midnight compliance proof verified, advisory)"
	}
	return "soroban proof"
}
