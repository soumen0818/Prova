package schema

// IVMS101 Travel-Rule data — the "sealed envelope" exchanged edge-to-edge between the two
// regulated anchors. This data NEVER goes on-chain in cleartext. Mirrors ivms101.ts (a minimal
// subset of the IVMS101 standard — expand in Phase 5).

// NaturalPersonName is a natural person's name.
type NaturalPersonName struct {
	PrimaryIdentifier   string `json:"primaryIdentifier"`             // family name
	SecondaryIdentifier string `json:"secondaryIdentifier,omitempty"` // given name
}

// IVMS101Person is one party (originator or beneficiary).
type IVMS101Person struct {
	Name NaturalPersonName `json:"name"`
	// CountryOfResidence is an ISO 3166-1 alpha-2 country code.
	CountryOfResidence string `json:"countryOfResidence,omitempty"`
	// NationalIdentifier is a national ID / passport reference (anchor-held; never on-chain).
	NationalIdentifier string `json:"nationalIdentifier,omitempty"`
	DateOfBirth        string `json:"dateOfBirth,omitempty"` // YYYY-MM-DD
}

// IVMS101Payload is the originator + beneficiary pair the Travel Rule requires.
type IVMS101Payload struct {
	Originator  IVMS101Person `json:"originator"`
	Beneficiary IVMS101Person `json:"beneficiary"`
}

// SealedTravelRuleEnvelope is what rides alongside the proof: ciphertext only, plus routing.
type SealedTravelRuleEnvelope struct {
	// TransferID links the envelope to the on-chain transfer.
	TransferID string `json:"transferId"`
	// BeneficiaryAnchorID is the anchor the envelope is encrypted to.
	BeneficiaryAnchorID string `json:"beneficiaryAnchorId"`
	// Ciphertext is base64 of an IVMS101Payload — decryptable only by the beneficiary anchor.
	Ciphertext string `json:"ciphertext"`
	// EncryptionScheme e.g. "x25519-xsalsa20-poly1305".
	EncryptionScheme string `json:"encryptionScheme"`
}
