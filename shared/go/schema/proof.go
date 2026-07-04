package schema

// Prova proof contract — FROZEN as v1. BLS12-381 Groth16 (arkworks prover, Soroban pairing_check
// verifier). Curve is BLS12-381, NOT BN254 — Soroban only exposes BLS12-381 host functions.
// See Docs/phase1-findings.md. Mirrors proof.ts.
//
// Points use Soroban's uncompressed, big-endian encoding: G1 = x‖y (96 bytes), G2 = x‖y (192 bytes)
// with each Fp2 limb ordered c1‖c0. Scalars are 32-byte big-endian.

// ProofFormat is the frozen proof/VK wire format identifier.
const ProofFormat = "bls12-381-groth16-v1"

// Byte lengths of the BLS12-381 encodings Soroban expects.
const (
	G1Len     = 96  // G1 affine, uncompressed: x(48) ‖ y(48)
	G2Len     = 192 // G2 affine, uncompressed: x(96) ‖ y(96), each Fp2 as c1(48) ‖ c0(48)
	ScalarLen = 32  // Fr scalar, big-endian
)

// Hex is a hex-encoded byte string (no "0x" prefix) in Soroban's big-endian encoding.
type Hex = string

// Groth16Proof is a Groth16 proof over BLS12-381 (A, C in G1; B in G2).
type Groth16Proof struct {
	A Hex `json:"a"` // G1 point, 96-byte hex
	B Hex `json:"b"` // G2 point, 192-byte hex
	C Hex `json:"c"` // G1 point, 96-byte hex
}

// PublicSignals are the public inputs the circuit exposes and the contract verifies, in order.
// Each is a 32-byte big-endian scalar.
type PublicSignals struct {
	// Commitment = Poseidon(amount, secret) — stored on-chain instead of the amount.
	Commitment Hex `json:"commitment"`
	// Nullifier = Poseidon(secret, transferId) — anti-replay, unlinkable.
	Nullifier Hex `json:"nullifier"`
}

// TransferProof is the full payload submitted for verification of one private transfer.
type TransferProof struct {
	Proof         Groth16Proof  `json:"proof"`
	PublicSignals PublicSignals `json:"publicSignals"`
}

// VerificationKey is the Groth16 verifying key in the exact blob the Soroban verifier embeds:
// alpha(G1) ‖ negBeta(G2) ‖ negGamma(G2) ‖ negDelta(G2) ‖ ic[](G1 each).
// beta/gamma/delta are pre-negated so verification is a single pairing_check.
type VerificationKey struct {
	Curve    string `json:"curve"`    // "bls12-381"
	Protocol string `json:"protocol"` // "groth16"
	Format   string `json:"format"`   // ProofFormat
	Alpha    Hex    `json:"alpha"`
	NegBeta  Hex    `json:"negBeta"`
	NegGamma Hex    `json:"negGamma"`
	NegDelta Hex    `json:"negDelta"`
	IC       []Hex  `json:"ic"`
}
