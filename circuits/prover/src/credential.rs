//! Anchor-attested KYC credential — Phase 3.
//!
//! The anchor signs `(user_id, kyc_level, expiry)` with a **Poseidon-challenge Schnorr/EdDSA over
//! Jubjub** (the twisted Edwards curve whose base field is BLS12-381's scalar field). Because the
//! curve is embedded in the circuit's native field, the signature can be verified *inside* the
//! Groth16 circuit natively (no non-native field arithmetic) — see the gadget in `lib.rs`.
//!
//! Scheme (EdDSA form):
//!   keygen:  sk ← Fr_jubjub,  pk = sk·G
//!   sign(m): k ← Fr_jubjub,   R = k·G,  e = Poseidon(R.x, R.y, pk.x, pk.y, m),  s = k + e·sk
//!   verify:  s·G == R + e·pk
//! where `m = Poseidon(user_id, kyc_level, expiry)` and `e` is reduced into the Jubjub scalar field.

use ark_bls12_381::Fr as Fq; // circuit field == Jubjub base field
use ark_ec::{AffineRepr, CurveGroup};
use ark_ed_on_bls12_381::{EdwardsAffine, Fr}; // Fr = Jubjub scalar field
use ark_ff::{BigInteger, PrimeField, UniformRand};
use ark_std::rand::Rng;

use crate::{poseidon_config, poseidon_hash_n};
use ark_crypto_primitives::sponge::poseidon::PoseidonConfig;

/// Minimum acceptable KYC level (frozen for circuit v2).
pub const MIN_KYC_LEVEL: u64 = 1;

/// A Schnorr/EdDSA signature over Jubjub.
#[derive(Clone, Copy, Debug)]
pub struct Signature {
    pub r: EdwardsAffine,
    pub s: Fr,
}

/// An anchor-attested credential: the signed fields plus the signature.
#[derive(Clone, Copy, Debug)]
pub struct Credential {
    pub user_id: Fq,
    pub kyc_level: u64,
    pub expiry: u64,
    pub sig: Signature,
}

/// The anchor's signing keypair.
#[derive(Clone, Copy, Debug)]
pub struct AnchorKey {
    pub sk: Fr,
    pub pk: EdwardsAffine,
}

impl AnchorKey {
    /// Generate a fresh anchor key.
    pub fn generate<R: Rng>(rng: &mut R) -> Self {
        let sk = Fr::rand(rng);
        Self::from_secret(sk)
    }

    /// Derive the keypair from a secret scalar.
    pub fn from_secret(sk: Fr) -> Self {
        let pk = (EdwardsAffine::generator() * sk).into_affine();
        Self { sk, pk }
    }
}

/// Domain separator so `user_id` derived from a transfer secret can't collide with commitments.
const USER_ID_DOMAIN: u64 = 0x50524f56415f4b59; // "PROVA_KY"

/// `user_id = Poseidon(secret, USER_ID_DOMAIN)` — a stable per-user id the anchor attests to,
/// bound to the same secret the transfer circuit uses.
pub fn user_id(cfg: &PoseidonConfig<Fq>, secret: Fq) -> Fq {
    poseidon_hash_n(cfg, &[secret, Fq::from(USER_ID_DOMAIN)])
}

/// The message the anchor signs: `m = Poseidon(user_id, kyc_level, expiry)`.
pub fn credential_message(
    cfg: &PoseidonConfig<Fq>,
    user_id: Fq,
    kyc_level: u64,
    expiry: u64,
) -> Fq {
    poseidon_hash_n(cfg, &[user_id, Fq::from(kyc_level), Fq::from(expiry)])
}

/// Reduce a base-field challenge into the Jubjub scalar field (little-endian, mod order).
pub fn challenge_to_scalar(e: Fq) -> Fr {
    Fr::from_le_bytes_mod_order(&e.into_bigint().to_bytes_le())
}

/// Represent a Jubjub scalar (< r_jubjub < q) as a base-field element, for in-circuit allocation.
pub fn scalar_to_field(s: Fr) -> Fq {
    Fq::from_le_bytes_mod_order(&s.into_bigint().to_bytes_le())
}

/// Expose the user-id domain separator for the in-circuit derivation.
pub const USER_ID_DOMAIN_CONST: u64 = USER_ID_DOMAIN;

/// Schnorr challenge `e = Poseidon(R.x, R.y, pk.x, pk.y, m)`.
fn challenge(cfg: &PoseidonConfig<Fq>, r: &EdwardsAffine, pk: &EdwardsAffine, m: Fq) -> Fq {
    poseidon_hash_n(cfg, &[r.x, r.y, pk.x, pk.y, m])
}

/// Sign message `m` with the anchor key.
pub fn sign<R: Rng>(cfg: &PoseidonConfig<Fq>, key: &AnchorKey, m: Fq, rng: &mut R) -> Signature {
    let k = Fr::rand(rng);
    let r = (EdwardsAffine::generator() * k).into_affine();
    let e = challenge(cfg, &r, &key.pk, m);
    let s = k + challenge_to_scalar(e) * key.sk;
    Signature { r, s }
}

/// Verify a signature natively: `s·G == R + e·pk`.
pub fn verify(cfg: &PoseidonConfig<Fq>, pk: &EdwardsAffine, m: Fq, sig: &Signature) -> bool {
    let e = challenge(cfg, &sig.r, pk, m);
    let e_s = challenge_to_scalar(e);
    let lhs = EdwardsAffine::generator() * sig.s; // s·G
    let rhs = sig.r.into_group() + *pk * e_s; // R + e·pk
    lhs.into_affine() == rhs.into_affine()
}

/// Issue a credential for a user: the anchor signs `(user_id, kyc_level, expiry)`.
pub fn issue<R: Rng>(
    cfg: &PoseidonConfig<Fq>,
    key: &AnchorKey,
    user_id: Fq,
    kyc_level: u64,
    expiry: u64,
    rng: &mut R,
) -> Credential {
    let m = credential_message(cfg, user_id, kyc_level, expiry);
    let sig = sign(cfg, key, m, rng);
    Credential {
        user_id,
        kyc_level,
        expiry,
        sig,
    }
}

/// Convenience: verify a full credential against an anchor public key.
pub fn verify_credential(cfg: &PoseidonConfig<Fq>, pk: &EdwardsAffine, cred: &Credential) -> bool {
    let m = credential_message(cfg, cred.user_id, cred.kyc_level, cred.expiry);
    verify(cfg, pk, m, &cred.sig)
}

/// Default Poseidon config for the credential scheme (same params as the transfer circuit).
pub fn cfg() -> PoseidonConfig<Fq> {
    poseidon_config::<Fq>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_std::rand::{rngs::StdRng, SeedableRng};

    #[test]
    fn sign_verify_roundtrip() {
        let cfg = cfg();
        let mut rng = StdRng::seed_from_u64(7);
        let key = AnchorKey::generate(&mut rng);
        let uid = user_id(&cfg, Fq::from(123456u64));
        let cred = issue(&cfg, &key, uid, 2, 2_000_000_000, &mut rng);
        assert!(
            verify_credential(&cfg, &key.pk, &cred),
            "valid credential must verify"
        );
    }

    #[test]
    fn tampered_fields_fail() {
        let cfg = cfg();
        let mut rng = StdRng::seed_from_u64(7);
        let key = AnchorKey::generate(&mut rng);
        let uid = user_id(&cfg, Fq::from(123456u64));
        let mut cred = issue(&cfg, &key, uid, 2, 2_000_000_000, &mut rng);
        cred.kyc_level = 5; // tamper after signing
        assert!(
            !verify_credential(&cfg, &key.pk, &cred),
            "tampered level must fail"
        );
    }

    #[test]
    fn forged_signature_fails() {
        let cfg = cfg();
        let mut rng = StdRng::seed_from_u64(7);
        let anchor = AnchorKey::generate(&mut rng);
        let attacker = AnchorKey::generate(&mut rng);
        let uid = user_id(&cfg, Fq::from(999u64));
        // Signed by the attacker, checked against the real anchor's key.
        let cred = issue(&cfg, &attacker, uid, 2, 2_000_000_000, &mut rng);
        assert!(
            !verify_credential(&cfg, &anchor.pk, &cred),
            "forged signature must fail"
        );
    }
}
