package schema

// Anchor-attested KYC credential — FROZEN for Phase 3. Mirrors credential.ts.
//
// The anchor signs (userId, kycLevel, expiry) with a Poseidon-challenge Schnorr/EdDSA over Jubjub,
// verified inside the Groth16 circuit. Identity data never touches the chain — only userId
// (= Poseidon(secret, domain)). All field elements are 32-byte big-endian hex.

// CredentialFormat is the frozen credential/signature scheme identifier.
const CredentialFormat = "jubjub-eddsa-poseidon-v1"

// MinKycLevel is the minimum KYC level the circuit accepts (must match the circuit constant).
const MinKycLevel = 1

// AnchorPublicKey is an anchor's Jubjub public key (affine coordinates, each 32-byte big-endian).
type AnchorPublicKey struct {
	X Hex `json:"x"`
	Y Hex `json:"y"`
}

// CredentialSignature is a Schnorr/EdDSA signature over Jubjub: nonce point R=(rX,rY) and scalar s.
type CredentialSignature struct {
	RX Hex `json:"rX"`
	RY Hex `json:"rY"`
	S  Hex `json:"s"`
}

// KycCredential is what the anchor returns after KYC. Stored only in the user's wallet — never on a
// server, never on-chain.
type KycCredential struct {
	// UserID = Poseidon(secret, domain) — binds the credential to the wallet's transfer secret.
	UserID   Hex `json:"userId"`
	KycLevel int `json:"kycLevel"`
	// Expiry is unix seconds; the circuit enforces expiry >= currentTime.
	Expiry    int64               `json:"expiry"`
	Signature CredentialSignature `json:"signature"`
	// Anchor is the public key that signed this credential (must be in the trusted set).
	Anchor AnchorPublicKey `json:"anchor"`
}
