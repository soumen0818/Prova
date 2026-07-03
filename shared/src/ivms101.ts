/**
 * IVMS101 Travel-Rule data — the "sealed envelope" exchanged edge-to-edge between the two regulated
 * anchors (UAE originator, India beneficiary). See proposal.md §9.
 *
 * This data NEVER goes on-chain in cleartext. It travels encrypted to the beneficiary anchor's
 * public key (primary path) or off-chain via a Travel-Rule network (fallback). These types are a
 * minimal subset of the IVMS101 standard — expand in Phase 5.
 */

export interface NaturalPersonName {
  primaryIdentifier: string; // family name
  secondaryIdentifier?: string; // given name
}

export interface IVMS101Person {
  name: NaturalPersonName;
  /** ISO 3166-1 alpha-2 country code. */
  countryOfResidence?: string;
  /** National ID / passport reference (anchor-held; never on-chain). */
  nationalIdentifier?: string;
  dateOfBirth?: string; // YYYY-MM-DD
}

/** The originator + beneficiary pair the Travel Rule requires to travel with the funds. */
export interface IVMS101Payload {
  originator: IVMS101Person;
  beneficiary: IVMS101Person;
}

/** What actually rides alongside the proof: ciphertext only, plus routing metadata. */
export interface SealedTravelRuleEnvelope {
  /** Links the envelope to the on-chain transfer (matches the nullifier/transfer id). */
  transferId: string;
  /** Beneficiary anchor identifier the envelope is encrypted to. */
  beneficiaryAnchorId: string;
  /** Base64 ciphertext of an IVMS101Payload — decryptable only by the beneficiary anchor. */
  ciphertext: string;
  encryptionScheme: string; // e.g. "x25519-xsalsa20-poly1305"
}
