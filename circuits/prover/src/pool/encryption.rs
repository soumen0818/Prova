//! In-circuit note encryption — how a recipient discovers money sent to them.
//!
//! ## The problem this solves
//!
//! A commitment on-chain reveals nothing, not even to its owner. So each output note ships with a
//! small encrypted message telling the recipient *"this leaf is yours, here is what is in it"*.
//! Wallets scan new events and trial-decrypt; what opens is theirs.
//!
//! The danger is that this message is **not** protected by the spend proof if it merely travels
//! alongside it. Whoever submits the transaction could corrupt those bytes. The money would still be
//! on-chain and still belong to the recipient, but their wallet could never find it — indistinguishable
//! from losing it.
//!
//! ## Why it is done this way
//!
//! The obvious fix — encrypt with ChaCha20 off-circuit and bind a SHA-256 hash of the ciphertext
//! inside the proof — is ruinous: SHA-256 costs **~42,000 constraints per 64-byte block** in-circuit,
//! against 14,302 for the entire spend circuit. It is expensive because SHA-256 thinks in bits and a
//! circuit thinks in field elements.
//!
//! So the encryption is built from what the circuit already speaks:
//!
//! - **Jubjub ECDH** for the shared secret — the same curve, and the same scalar-multiplication
//!   gadget, the KYC signature check already uses.
//! - **A Poseidon-derived one-time pad** for the payload — one hash per field element, 240 constraints.
//!
//! The ciphertext is then *computed by the circuit* and published as a public input. It is no longer
//! data riding beside the proof; it is part of it. Tampering with a single element invalidates the
//! proof, so a corrupted message never reaches the chain at all. The failure mode stops existing
//! rather than becoming recoverable.
//!
//! ```text
//! epk        = esk·G                        (ephemeral public key, published)
//! S          = esk·encPk = encSk·epk        (ECDH — both sides derive it)
//! k          = Poseidon(S.x, S.y, slot)
//! cAmount    = amount + Poseidon(k, 1)
//! cRho       = rho    + Poseidon(k, 2)
//! ```
//!
//! ## Why `slot` is in the key derivation
//!
//! Both output notes of a transfer share one ephemeral key, so if they go to the **same** recipient
//! they would otherwise derive an identical mask. A public observer could then subtract the two
//! ciphertexts and read `amount1 - amount2` in the clear. Domain-separating by output slot makes the
//! two masks independent.

use ark_bls12_381::Fr as Fq;
use ark_ec::{AffineRepr, CurveGroup};
use ark_ed_on_bls12_381::{EdwardsAffine, Fr as JubjubFr};
use ark_ff::UniformRand;
use ark_std::rand::Rng;

use ark_crypto_primitives::sponge::poseidon::PoseidonConfig;

use crate::poseidon_hash_n;

/// Domain separators inside the derived key, so the amount mask can never equal the rho mask.
pub(super) const MASK_AMOUNT: u64 = 1;
pub(super) const MASK_RHO: u64 = 2;

/// A recipient's note-encryption keypair, over Jubjub so the circuit can use it natively.
///
/// Distinct from the pool *spending* key: this one only finds notes, it cannot move them. Both are
/// derived from the wallet's master seed under different labels (`PoolDomain.ENC_KEY_INFO`).
#[derive(Clone, Copy, Debug)]
pub struct EncKey {
    pub sk: JubjubFr,
    pub pk: EdwardsAffine,
}

impl EncKey {
    pub fn generate<R: Rng>(rng: &mut R) -> Self {
        Self::from_secret(JubjubFr::rand(rng))
    }

    pub fn from_secret(sk: JubjubFr) -> Self {
        Self {
            sk,
            pk: (EdwardsAffine::generator() * sk).into_affine(),
        }
    }
}

/// The published half of an encrypted note: the ephemeral key plus the masked payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EncryptedNote {
    pub epk: EdwardsAffine,
    pub c_amount: Fq,
    pub c_rho: Fq,
}

/// Derive the one-time pad key from an ECDH shared point. Native twin of the in-circuit derivation.
pub fn derive_key(cfg: &PoseidonConfig<Fq>, shared: &EdwardsAffine, slot: u64) -> Fq {
    poseidon_hash_n(cfg, &[shared.x, shared.y, Fq::from(slot)])
}

fn masks(cfg: &PoseidonConfig<Fq>, k: Fq) -> (Fq, Fq) {
    (
        poseidon_hash_n(cfg, &[k, Fq::from(MASK_AMOUNT)]),
        poseidon_hash_n(cfg, &[k, Fq::from(MASK_RHO)]),
    )
}

/// Encrypt `(amount, rho)` to `recipient_pk` under ephemeral secret `esk`.
///
/// `slot` is the output index (0 or 1) and must differ between the two notes of one transfer — see
/// the module docs for why.
pub fn encrypt(
    cfg: &PoseidonConfig<Fq>,
    esk: JubjubFr,
    recipient_pk: &EdwardsAffine,
    amount: Fq,
    rho: Fq,
    slot: u64,
) -> EncryptedNote {
    let epk = (EdwardsAffine::generator() * esk).into_affine();
    let shared = (*recipient_pk * esk).into_affine();
    let k = derive_key(cfg, &shared, slot);
    let (m_amount, m_rho) = masks(cfg, k);
    EncryptedNote {
        epk,
        c_amount: amount + m_amount,
        c_rho: rho + m_rho,
    }
}

/// Recover `(amount, rho)` with the recipient's encryption secret.
///
/// Always succeeds arithmetically — it cannot tell on its own whether the note was addressed to this
/// key. [`try_open`] is the check that does.
pub fn decrypt(
    cfg: &PoseidonConfig<Fq>,
    enc_sk: JubjubFr,
    note: &EncryptedNote,
    slot: u64,
) -> (Fq, Fq) {
    let shared = (note.epk * enc_sk).into_affine();
    let k = derive_key(cfg, &shared, slot);
    let (m_amount, m_rho) = masks(cfg, k);
    (note.c_amount - m_amount, note.c_rho - m_rho)
}

/// Trial-decryption: is this published commitment a note for `owner_pk`?
///
/// Decrypt, rebuild the commitment from the result, and compare. A match is overwhelming evidence
/// the note is ours — forging one would mean finding a Poseidon collision. This is what a wallet runs
/// over every new event; the chain only ever sees ciphertext.
pub fn try_open(
    cfg: &PoseidonConfig<Fq>,
    enc_sk: JubjubFr,
    owner_pk: Fq,
    commitment: Fq,
    note: &EncryptedNote,
    slot: u64,
) -> Option<super::Note> {
    let (amount, rho) = decrypt(cfg, enc_sk, note, slot);
    if super::note_commitment(cfg, amount, owner_pk, rho) != commitment {
        return None;
    }
    // The amount must be a real u64; anything wider was never a valid note (the spend circuit
    // range-checks it), so refuse rather than hand back a nonsense balance.
    let amount_u64 = fq_to_u64(amount)?;
    Some(super::Note::new(amount_u64, owner_pk, rho))
}

/// Field element -> u64, or `None` if it does not fit.
fn fq_to_u64(v: Fq) -> Option<u64> {
    use ark_ff::{BigInteger, PrimeField};
    let bytes = v.into_bigint().to_bytes_le();
    if bytes[8..].iter().any(|b| *b != 0) {
        return None;
    }
    let mut out = [0u8; 8];
    out.copy_from_slice(&bytes[..8]);
    Some(u64::from_le_bytes(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poseidon_config;
    use ark_std::rand::{rngs::StdRng, SeedableRng};

    fn setup() -> (PoseidonConfig<Fq>, StdRng) {
        (poseidon_config::<Fq>(), StdRng::seed_from_u64(11))
    }

    #[test]
    fn round_trip() {
        let (cfg, mut rng) = setup();
        let recipient = EncKey::generate(&mut rng);
        let esk = JubjubFr::rand(&mut rng);
        let (amount, rho) = (Fq::from(4200u64), Fq::from(98765u64));

        let note = encrypt(&cfg, esk, &recipient.pk, amount, rho, 0);
        assert_eq!(decrypt(&cfg, recipient.sk, &note, 0), (amount, rho));
    }

    /// Both sides must derive the same secret from opposite halves of the exchange — the property
    /// the whole scheme rests on.
    #[test]
    fn ecdh_agrees_from_both_sides() {
        let (cfg, mut rng) = setup();
        let recipient = EncKey::generate(&mut rng);
        let esk = JubjubFr::rand(&mut rng);
        let epk = (EdwardsAffine::generator() * esk).into_affine();

        let sender_side = (recipient.pk * esk).into_affine();
        let recipient_side = (epk * recipient.sk).into_affine();
        assert_eq!(sender_side, recipient_side);
        assert_eq!(
            derive_key(&cfg, &sender_side, 0),
            derive_key(&cfg, &recipient_side, 0)
        );
    }

    #[test]
    fn wrong_key_does_not_open_the_note() {
        let (cfg, mut rng) = setup();
        let recipient = EncKey::generate(&mut rng);
        let stranger = EncKey::generate(&mut rng);
        let owner_pk = Fq::from(31337u64);
        let esk = JubjubFr::rand(&mut rng);
        let note_amount = 500u64;
        let rho = Fq::from(777u64);

        let enc = encrypt(&cfg, esk, &recipient.pk, Fq::from(note_amount), rho, 0);
        let commitment = super::super::note_commitment(&cfg, Fq::from(note_amount), owner_pk, rho);

        assert!(
            try_open(&cfg, recipient.sk, owner_pk, commitment, &enc, 0).is_some(),
            "the intended recipient must find their note"
        );
        assert!(
            try_open(&cfg, stranger.sk, owner_pk, commitment, &enc, 0).is_none(),
            "nobody else may open it — this is what keeps scanning private"
        );
    }

    /// Two notes to the *same* recipient in one transfer share an ephemeral key. Without
    /// domain-separating by output slot their masks would be identical, and subtracting the two
    /// public ciphertexts would reveal the difference of the amounts to any observer.
    #[test]
    fn output_slots_use_independent_masks() {
        let (cfg, mut rng) = setup();
        let recipient = EncKey::generate(&mut rng);
        let esk = JubjubFr::rand(&mut rng);
        let amount = Fq::from(1000u64);
        let rho = Fq::from(1u64);

        let a = encrypt(&cfg, esk, &recipient.pk, amount, rho, 0);
        let b = encrypt(&cfg, esk, &recipient.pk, amount, rho, 1);
        assert_ne!(
            a.c_amount, b.c_amount,
            "identical plaintexts in different slots must not produce identical ciphertexts"
        );
        // ...and each still opens correctly under its own slot.
        assert_eq!(decrypt(&cfg, recipient.sk, &a, 0), (amount, rho));
        assert_eq!(decrypt(&cfg, recipient.sk, &b, 1), (amount, rho));
    }

    #[test]
    fn decrypting_under_the_wrong_slot_fails_to_open() {
        let (cfg, mut rng) = setup();
        let recipient = EncKey::generate(&mut rng);
        let owner_pk = Fq::from(5u64);
        let esk = JubjubFr::rand(&mut rng);
        let rho = Fq::from(9u64);
        let enc = encrypt(&cfg, esk, &recipient.pk, Fq::from(70u64), rho, 0);
        let commitment = super::super::note_commitment(&cfg, Fq::from(70u64), owner_pk, rho);
        assert!(try_open(&cfg, recipient.sk, owner_pk, commitment, &enc, 1).is_none());
    }

    #[test]
    fn oversized_amount_is_refused() {
        // A note whose "amount" is not a u64 could never have passed the spend circuit's range
        // check, so opening must refuse it rather than report a nonsense balance.
        let (cfg, mut rng) = setup();
        let recipient = EncKey::generate(&mut rng);
        let owner_pk = Fq::from(5u64);
        let esk = JubjubFr::rand(&mut rng);
        let huge = Fq::from(u64::MAX) + Fq::from(1u64);
        let rho = Fq::from(3u64);
        let enc = encrypt(&cfg, esk, &recipient.pk, huge, rho, 0);
        let commitment = super::super::note_commitment(&cfg, huge, owner_pk, rho);
        assert!(try_open(&cfg, recipient.sk, owner_pk, commitment, &enc, 0).is_none());
    }
}
