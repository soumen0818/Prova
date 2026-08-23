package schema

// Shielded pool contract — FROZEN as v3 (Docs/shielded-pool.md). Mirrors pool.ts.
//
// Single source of truth for the note format, Merkle tree parameters, the circuit's public-input
// order and the on-chain event shape. The circuit, the Soroban contract, the backend indexer and
// the wallet must agree bit-for-bit — a mismatch silently breaks value conservation or makes notes
// unspendable. Nothing here changes without a version bump and a coordinated redeploy (new trusted
// setup + verification key + contract upgrade).
//
// Field elements are BLS12-381 scalars as 32-byte big-endian hex (Soroban `Fr`).

// PoolFormat is the frozen pool/circuit version identifier.
const PoolFormat = "prova-shielded-pool-v3"

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

// Note is a unit of private value — a banknote in the user's wallet.
//
//	commitment = Poseidon(amount, ownerPk, rho)  → on-chain; reveals nothing
//	nullifier  = Poseidon(ownerSk, rho)          → published on spend; prevents double-spend
//
// Rho is a fresh random field element per note: it makes two notes with the same amount and owner
// produce different commitments (unlinkability) and keeps each nullifier unique.
type Note struct {
	// Amount in minor units as a decimal string (u64 range).
	Amount string `json:"amount"`
	// OwnerPk is the recipient's pool public key — the "address" that receives notes.
	OwnerPk Hex `json:"ownerPk"`
	// Rho is the per-note random nonce.
	Rho Hex `json:"rho"`
}

// OwnedNote is a note plus what's needed to spend it.
type OwnedNote struct {
	Note
	Commitment Hex `json:"commitment"`
	// LeafIndex is the note's position in the Merkle tree (needed to build a membership path).
	LeafIndex uint64 `json:"leafIndex"`
	// Nullifier, once known; its presence on-chain means the note is spent.
	Nullifier Hex `json:"nullifier,omitempty"`
}

// Domain separators for key derivation. Distinct constants stop one derived value being reused as
// another (e.g. an owner key masquerading as a nullifier input).
const (
	// PoolDomainOwner: ownerPk = Poseidon(ownerSk, PoolDomainOwner).
	PoolDomainOwner = 1
	// PoolSpendKeyInfo is the HKDF label for the pool spending key (from the wallet master seed).
	PoolSpendKeyInfo = "prova/pool/spend/v1"
	// PoolEncKeyInfo is the HKDF label for the note-encryption keypair (Jubjub).
	PoolEncKeyInfo = "prova/pool/enc/v1"
)

// AmountBits is the width every amount is range-checked to in-circuit (u64 minor units).
const AmountBits = 64

// ---------------------------------------------------------------------------
// Merkle tree
// ---------------------------------------------------------------------------

const (
	// MerkleDepth 20 → 2^20 ≈ 1.05M notes. Each level costs one Poseidon hash in-circuit, so depth
	// is the main lever on proving time.
	MerkleDepth = 20
	// MerkleEmptyLeaf is the value of an empty leaf; zero-subtree hashes derive from it.
	MerkleEmptyLeaf = "0"
	// MerkleRootHistory is how many recent roots the contract accepts.
	//
	// A proof is built against the root the wallet last saw; by the time it lands, other
	// transactions may have advanced the root. Without a window, every concurrent transfer fails.
	MerkleRootHistory = 32
	// MerkleBatch is how many commitments one update_root call folds into the tree.
	//
	// The contract cannot hash — one on-chain Poseidon permutation measured 10,967,507 CPU against
	// a 100M budget, so a depth-20 append cannot even complete (Docs/shielded-pool.md §10.1). New
	// commitments are queued and folded in by a proof. Each folded leaf is a Groth16 public input
	// costing ~1.49M CPU in the verifier's MSM, which caps the batch: 8 ≈ 60M, 16 ≈ 71M, 32 ≈ 95M
	// (no room left). A fold may carry fewer, so a quiet period never strands a note.
	MerkleBatch = 8
)

// NoteStatus is a note's lifecycle state. Value is never at risk in any of them, but a note cannot
// be spent until it is folded into the tree — a membership proof needs it to be a leaf. Wallets must
// present queued notes as confirming, not spendable.
type NoteStatus string

const (
	NoteQueued NoteStatus = "queued"
	NoteFolded NoteStatus = "folded"
	NoteSpent  NoteStatus = "spent"
)

// MerklePath is a membership path: sibling hashes bottom-up plus the index fixing left/right.
type MerklePath struct {
	LeafIndex uint64 `json:"leafIndex"`
	// Siblings has exactly MerkleDepth entries, from the leaf level upward.
	Siblings []Hex `json:"siblings"`
	// Root these siblings hash to — the proof's public input.
	Root Hex `json:"root"`
}

// ---------------------------------------------------------------------------
// Circuit v3 I/O
// ---------------------------------------------------------------------------

// PoolPublicInputs lists the circuit's public inputs IN VERIFICATION ORDER. The contract's
// verifying-key IC layout and the prover's public_inputs() must match exactly, or every proof fails.
//
// PublicAmount is what lets one circuit serve two operations:
//
//	0  → a fully private transfer (value stays in the pool)
//	>0 → an unshield (that much leaves the pool to a public destination)
var PoolPublicInputs = []string{
	"merkleRoot",
	"nullifier",
	"outCommitment1",
	"outCommitment2",
	"publicAmount",
	"destination",
	"anchorPkX",
	"anchorPkY",
	"currentTime",
	// The encrypted notes. Public inputs rather than attachments — see EncryptedNote.
	"epkX",
	"epkY",
	"enc1Amount",
	"enc1Rho",
	"enc2Amount",
	"enc2Rho",
}

// PoolPublicInputCount is the number of public inputs; the VK has this many + 1 IC entries.
const PoolPublicInputCount = 15

// PoolProofBlobBytes is the v3 proof blob size:
// A(96) + B(192) + C(96) + publicInputs(15*32) = 864.
const PoolProofBlobBytes = G1Len + G2Len + G1Len + PoolPublicInputCount*ScalarLen

// ShieldPublicInputs lists the shield proof's public inputs in verification order.
//
// shield is the only way a commitment enters the pool without a spend proof behind it, and the
// contract cannot compute Poseidon to check it. Without this proof a user could transfer 100 tokens
// while committing to 1,000,000, then unshield the pool dry. The contract checks amount against the
// tokens actually transferred, which is what closes that hole.
var ShieldPublicInputs = []string{
	"commitment", "amount", "ownerPk", "epkX", "epkY", "encAmount", "encRho",
}

// ShieldPublicInputCount is the number of shield public inputs.
const ShieldPublicInputCount = 7

// FoldPublicInputs lists the fold proof's public inputs in verification order: oldRoot, newRoot,
// startIndex, count, then MerkleBatch leaves.
//
// The leaves are public inputs precisely so the contract can pass the commitments it queued — that
// is what stops a folder inserting notes of its own invention.
var FoldPublicInputs = func() []string {
	in := []string{"oldRoot", "newRoot", "startIndex", "count"}
	for i := 0; i < MerkleBatch; i++ {
		in = append(in, "leaf"+string(rune('0'+i)))
	}
	return in
}()

// FoldPublicInputCount is the number of fold public inputs.
const FoldPublicInputCount = 4 + MerkleBatch

// PoolPublicSignals is the statement a spend proves; everything else stays a private witness.
type PoolPublicSignals struct {
	// MerkleRoot the membership proof was built against (must be in the contract's history window).
	MerkleRoot Hex `json:"merkleRoot"`
	// Nullifier of the note being spent.
	Nullifier Hex `json:"nullifier"`
	// OutCommitment1 is the recipient's new note.
	OutCommitment1 Hex `json:"outCommitment1"`
	// OutCommitment2 is the change note back to the sender.
	OutCommitment2 Hex `json:"outCommitment2"`
	// PublicAmount leaving the pool (decimal string); "0" for a private transfer.
	PublicAmount string `json:"publicAmount"`
	// Destination is where an unshield pays out, bound into the proof; "0" for a private transfer.
	//
	// Without this binding an unshield proof is valid for any destination, so anyone watching the
	// mempool could resubmit it with their own address and take the payout. It is a fund-theft hole,
	// and it is why this field was added after the V0 freeze.
	Destination Hex `json:"destination"`
	// Anchor key that signed the KYC credential (carried over from v2).
	AnchorPkX Hex `json:"anchorPkX"`
	AnchorPkY Hex `json:"anchorPkY"`
	// CurrentTime the expiry check was made against.
	CurrentTime string `json:"currentTime"`
}

// ---------------------------------------------------------------------------
// Note encryption (discovery)
// ---------------------------------------------------------------------------

// EncryptedNote lets an owner find money sent to them. Wallets scan events and trial-decrypt; what
// opens is theirs. The chain only ever sees ciphertext.
//
// Scheme: Jubjub ECDH + a Poseidon one-time pad, computed INSIDE the spend circuit.
//
//	epk     = esk·G                    S = esk·encPk = encSk·epk
//	k       = Poseidon(S.x, S.y, slot)
//	cAmount = amount + Poseidon(k, 1)  cRho = rho + Poseidon(k, 2)
//
// Deliberately not an off-circuit AEAD. A payload that merely travels beside the proof can be
// corrupted by whoever submits the transaction: the money stays on-chain and stays the recipient's,
// but their wallet can never find it — indistinguishable from losing it. These fields are Groth16
// public inputs produced by the circuit, so corrupting one invalidates the proof instead.
//
// Binding an off-circuit ciphertext with SHA-256 was measured and rejected: ~42,000 constraints per
// 64-byte block against 240 for a Poseidon hash.
type EncryptedNote struct {
	// EpkX/EpkY are the ephemeral Jubjub public key, shared by both output notes.
	EpkX Hex `json:"epkX"`
	EpkY Hex `json:"epkY"`
	// EncAmount/EncRho are the masked payload.
	EncAmount Hex `json:"encAmount"`
	EncRho    Hex `json:"encRho"`
	// Slot is the output index (0 or 1), domain-separated into the key derivation so two notes to
	// the same recipient cannot share a mask. The wallet must record it to decrypt.
	Slot uint8 `json:"slot"`
}

// NoteEvent is one appended leaf plus the payload its owner can decrypt.
type NoteEvent struct {
	Commitment Hex `json:"commitment"`
	// LeafIndex in the tree — the wallet needs it to build a spend path.
	LeafIndex uint64        `json:"leafIndex"`
	Encrypted EncryptedNote `json:"encrypted"`
	// Ledger sequence the event was emitted at (scan cursor).
	Ledger uint32 `json:"ledger"`
}

// ---------------------------------------------------------------------------
// Contract operations
// ---------------------------------------------------------------------------

// Pool operations (Docs/shielded-pool.md §1).
const (
	// PoolShield: public — tokens move into the pool, one note is created.
	PoolShield = "shield"
	// PoolTransact: private — spend a note → recipient note + change note.
	PoolTransact = "transact"
	// PoolUnshield: spend a note → tokens leave the pool publicly (+ change note).
	PoolUnshield = "unshield"
	// PoolUpdateRoot: maintenance — fold queued commitments into the tree and advance the root.
	//
	// Permissionless: the proof enforces correctness, so a folder can neither mint nor steal. Its
	// only power is to stop, which delays new notes becoming spendable. The V3 relayer runs it.
	PoolUpdateRoot = "updateRoot"
)

// ---------------------------------------------------------------------------
// Backend API (V3 indexer)
// ---------------------------------------------------------------------------

// PoolScanMaxLimit caps one page of the note-scan feed.
//
// Wallets trial-decrypt every entry, so the page size is a client-CPU budget, not a bandwidth one.
const PoolScanMaxLimit = 500

// PoolNoteRecord is one note as served to a scanning wallet.
//
// The feed is deliberately unfiltered: selecting by recipient server-side would tell the backend who
// is being paid, which is exactly the privacy the pool exists to provide. Wallets download every
// record and try each one; what opens is theirs.
type PoolNoteRecord struct {
	// QueueIndex is the scan cursor — monotonic and gapless. Resume from the last one seen.
	QueueIndex int64 `json:"queueIndex"`
	// Commitment is the tree leaf, and what a successful trial-decryption must reproduce.
	Commitment Hex `json:"commitment"`
	// Encrypted payload; only this note's owner can open it.
	Encrypted EncryptedNote `json:"encrypted"`
	// LeafIndex is the tree position, present only once folded. While nil the note exists but is
	// NOT yet spendable — a membership proof needs a leaf that exists. Wallets must show these as
	// confirming, not as available balance.
	LeafIndex *int64 `json:"leafIndex,omitempty"`
	// Ledger the note was emitted at.
	Ledger int64 `json:"ledger"`
}

// PoolMerklePath is a membership path, the private witness of a spend proof.
type PoolMerklePath struct {
	LeafIndex int64 `json:"leafIndex"`
	// Siblings has exactly MerkleDepth entries, from the leaf level upward.
	Siblings []Hex `json:"siblings"`
	// Root these siblings hash to. Served only when still inside the contract's accepted window, so
	// a wallet never builds a proof that is guaranteed to be rejected.
	Root Hex `json:"root"`
}

// PoolStatus is the pool's public health.
type PoolStatus struct {
	// Root and TreeSize describe the newest fold; empty/zero on a pool with nothing folded yet.
	Root     Hex   `json:"root,omitempty"`
	TreeSize int64 `json:"treeSize"`
	Ledger   int64 `json:"ledger,omitempty"`
	// QueueDepth is how many commitments are waiting to be folded. THE metric to alert on: a rising
	// queue means the folder has stalled and new notes are not becoming spendable. Custodied funds
	// are never at risk, but the product looks broken.
	QueueDepth int64 `json:"queueDepth"`
	// Batch is how many a single fold can carry (MerkleBatch).
	Batch int `json:"batch"`

	/*
	 * The folder's last outcome, so a stall explains itself.
	 *
	 * QueueDepth says something is waiting; it cannot say whether the folder is working through it
	 * or failing on it every few seconds. Twice a stuck deposit has needed shell access on a box
	 * behind a security group to answer that. These fields put the reason where anyone can read it.
	 *
	 * FoldError is a short reason, never a stack trace — this is a public endpoint.
	 */
	FoldError string `json:"foldError,omitempty"`
	// FoldFailures is how many attempts have failed in a row: 0 is healthy, a climbing number is a
	// stall rather than a blip.
	FoldFailures int `json:"foldFailures,omitempty"`
	// LastFoldAt is when a fold last SUCCEEDED (RFC 3339). Absent on a pool that has never folded.
	LastFoldAt string `json:"lastFoldAt,omitempty"`
}

// PoolSpendOutputs are the two notes a spend creates, with their encrypted payloads.
//
// Every field here is a Groth16 public input bound by the spend proof, so the relayer cannot alter
// any of them — change one byte and the proof fails.
type PoolSpendOutputs struct {
	C1         Hex `json:"c1"`
	C2         Hex `json:"c2"`
	EpkX       Hex `json:"epkX"`
	EpkY       Hex `json:"epkY"`
	Enc1Amount Hex `json:"enc1Amount"`
	Enc1Rho    Hex `json:"enc1Rho"`
	Enc2Amount Hex `json:"enc2Amount"`
	Enc2Rho    Hex `json:"enc2Rho"`
}

// PoolSpendRequest relays a private transfer or an unshield.
//
// Only `transact` and `unshield` are relayed. `shield` is deliberately not: it requires the user's
// own authorisation to move their tokens, and it is public by design (the anchor already knows the
// deposit), so relaying it would add complexity and buy no privacy.
type PoolSpendRequest struct {
	// Proof is A(96) ‖ B(192) ‖ C(96), hex — 768 characters.
	Proof Hex `json:"proof"`
	// Root the membership proof was built against. Must still be inside the contract's 32-root
	// window, or the spend is rejected and the wallet must refetch its path and re-prove.
	Root      Hex              `json:"root"`
	Nullifier Hex              `json:"nullifier"`
	Outputs   PoolSpendOutputs `json:"outputs"`
	// CurrentTime the credential's expiry was checked against.
	CurrentTime uint64 `json:"currentTime"`

	// Unshield only. Both are bound inside the proof, so the relayer can neither redirect the
	// payout nor change how much leaves the pool.
	Amount      int64  `json:"amount,omitempty"`
	Destination string `json:"destination,omitempty"`
}

// PoolSpendResponse is the relay outcome.
type PoolSpendResponse struct {
	TxHash string `json:"txHash"`
}
