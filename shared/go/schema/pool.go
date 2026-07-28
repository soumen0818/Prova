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
	// PoolEncKeyInfo is the HKDF label for the note-encryption keypair (X25519).
	PoolEncKeyInfo = "prova/pool/enc/v1"
)

// AmountBits is the width every amount is range-checked to in-circuit (u64 minor units).
const AmountBits = 64

// ---------------------------------------------------------------------------
// Merkle tree
// ---------------------------------------------------------------------------

const (
	// MerkleDepth 20 → 2^20 ≈ 1.05M notes. Each level costs one Poseidon hash in-circuit and
	// on-chain, so depth is the main lever on both proving time and contract CPU.
	MerkleDepth = 20
	// MerkleEmptyLeaf is the value of an empty leaf; zero-subtree hashes derive from it.
	MerkleEmptyLeaf = "0"
	// MerkleRootHistory is how many recent roots the contract accepts.
	//
	// A proof is built against the root the wallet last saw; by the time it lands, other
	// transactions may have advanced the root. Without a window, every concurrent transfer fails.
	MerkleRootHistory = 32
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
	"anchorPkX",
	"anchorPkY",
	"currentTime",
}

// PoolPublicInputCount is the number of public inputs; the VK has this many + 1 IC entries.
const PoolPublicInputCount = 8

// PoolProofBlobBytes is the v3 proof blob size:
// A(96) + B(192) + C(96) + publicInputs(8*32) = 640. (v2 was 544 with 5 public inputs.)
const PoolProofBlobBytes = G1Len + G2Len + G1Len + PoolPublicInputCount*ScalarLen

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
	// Anchor key that signed the KYC credential (carried over from v2).
	AnchorPkX Hex `json:"anchorPkX"`
	AnchorPkY Hex `json:"anchorPkY"`
	// CurrentTime the expiry check was made against.
	CurrentTime string `json:"currentTime"`
}

// ---------------------------------------------------------------------------
// Note encryption (discovery)
// ---------------------------------------------------------------------------

// EncryptedNote is an output note encrypted to its recipient and emitted with the transaction, so
// the owner can find money sent to them. Wallets scan events and trial-decrypt; what opens is
// theirs. The chain only ever sees ciphertext.
//
// Scheme: X25519 ECDH to the recipient's encPk → ChaCha20-Poly1305.
type EncryptedNote struct {
	// EphemeralPk is the X25519 public key for this payload (32-byte hex).
	EphemeralPk Hex `json:"ephemeralPk"`
	// Nonce for the AEAD (12-byte hex).
	Nonce Hex `json:"nonce"`
	// Ciphertext of the JSON Note, including the Poly1305 tag.
	Ciphertext Hex `json:"ciphertext"`
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
)
