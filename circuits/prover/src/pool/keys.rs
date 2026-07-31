//! Wallet key derivation for the shielded pool.
//!
//! Everything a wallet needs comes from the one master seed it already backs up, so **restoring that
//! seed restores the ability to both find and spend every note** — no separate key material to lose.
//!
//! Two keys, deliberately distinct:
//!
//! | Key | Derived as | What it can do |
//! |---|---|---|
//! | **spending** (`ownerSk`) | HKDF-SHA256(seed, `PoolDomain.SPEND_KEY_INFO`) | Move money |
//! | **encryption** (`encSk`) | HKDF-SHA256(seed, `PoolDomain.ENC_KEY_INFO`) | Only *find* money |
//!
//! Separating them is what makes a future viewing key possible: handing someone `encSk` lets them
//! audit incoming notes without any ability to spend. Sharing one key for both would make that
//! impossible without also handing over the funds.
//!
//! The labels are frozen in `shared/src/pool.ts` and mirrored in `pool.go`; changing one silently
//! rederives a *different* wallet, so a user would open the app to an empty balance with their money
//! still on-chain under keys nothing derives any more.

use ark_bls12_381::Fr;
use ark_crypto_primitives::sponge::poseidon::PoseidonConfig;
use ark_ed_on_bls12_381::{EdwardsAffine, Fr as JubjubFr};
use ark_ff::PrimeField;
use hkdf::Hkdf;
use sha2::Sha256;

use super::encryption::EncKey;

/// HKDF label for the pool spending key (`PoolDomain.SPEND_KEY_INFO`).
pub const SPEND_KEY_INFO: &[u8] = b"prova/pool/spend/v1";
/// HKDF label for the note-encryption key (`PoolDomain.ENC_KEY_INFO`).
pub const ENC_KEY_INFO: &[u8] = b"prova/pool/enc/v1";

/// A wallet's pool identity.
#[derive(Clone, Copy, Debug)]
pub struct PoolKeys {
    /// Spending secret. Whoever holds this can move the notes.
    pub owner_sk: Fr,
    /// The "address" notes are sent to: `Poseidon(ownerSk, OWNER_DOMAIN)`.
    pub owner_pk: Fr,
    /// Note-encryption keypair (Jubjub). Finds notes; cannot spend them.
    pub enc: EncKey,
}

/// Expand 64 bytes of key material under `info`. HKDF with an empty salt, which is the standard
/// construction when the input is already a high-entropy seed.
fn expand(seed: &[u8], info: &[u8]) -> [u8; 64] {
    let hk = Hkdf::<Sha256>::new(None, seed);
    let mut out = [0u8; 64];
    hk.expand(info, &mut out)
        .expect("64 bytes is a valid HKDF-SHA256 output length");
    out
}

/// Derive a wallet's pool keys from its master seed.
///
/// Both scalars are reduced from 64 bytes rather than 32. Reducing 32 bytes into a ~255-bit field
/// biases the result towards small values; 64 bytes makes that bias negligible, which is the
/// standard construction and matters here because `ownerSk` is the key that guards the money.
pub fn derive(cfg: &PoseidonConfig<Fr>, seed: &[u8]) -> PoolKeys {
    let owner_sk = Fr::from_be_bytes_mod_order(&expand(seed, SPEND_KEY_INFO));
    let enc_sk = JubjubFr::from_be_bytes_mod_order(&expand(seed, ENC_KEY_INFO));
    PoolKeys {
        owner_sk,
        owner_pk: super::owner_pk(cfg, owner_sk),
        enc: EncKey::from_secret(enc_sk),
    }
}

/// The public half a sender needs in order to pay this wallet: where notes go, and how to encrypt
/// them so only this wallet can find them.
#[derive(Clone, Copy, Debug)]
pub struct PoolAddress {
    pub owner_pk: Fr,
    pub enc_pk: EdwardsAffine,
}

impl PoolKeys {
    /// The shareable address. Reveals nothing about the balance or history — it is only a
    /// destination.
    pub fn address(&self) -> PoolAddress {
        PoolAddress {
            owner_pk: self.owner_pk,
            enc_pk: self.enc.pk,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::poseidon_config;

    fn cfg() -> PoseidonConfig<Fr> {
        poseidon_config::<Fr>()
    }

    /// The same seed must always produce the same wallet — this is what makes seed-phrase recovery
    /// work at all. If it ever changed, a restored wallet would show an empty balance while the
    /// money sat on-chain under keys nothing derives any more.
    #[test]
    fn derivation_is_deterministic() {
        let cfg = cfg();
        let seed = [7u8; 32];
        let a = derive(&cfg, &seed);
        let b = derive(&cfg, &seed);
        assert_eq!(a.owner_sk, b.owner_sk);
        assert_eq!(a.owner_pk, b.owner_pk);
        assert_eq!(a.enc.sk, b.enc.sk);
        assert_eq!(a.enc.pk, b.enc.pk);
    }

    #[test]
    fn different_seeds_give_different_wallets() {
        let cfg = cfg();
        let a = derive(&cfg, &[1u8; 32]);
        let b = derive(&cfg, &[2u8; 32]);
        assert_ne!(a.owner_sk, b.owner_sk);
        assert_ne!(a.enc.sk, b.enc.sk);
    }

    /// The spending key and the encryption key must be independent. If one could be derived from the
    /// other, handing someone a viewing key would hand them the money too.
    #[test]
    fn spending_and_encryption_keys_are_independent() {
        let cfg = cfg();
        let k = derive(&cfg, &[3u8; 32]);
        // Different labels over the same seed: the two secrets must not coincide under any
        // reinterpretation of one as the other.
        let owner_bytes = expand(&[3u8; 32], SPEND_KEY_INFO);
        let enc_bytes = expand(&[3u8; 32], ENC_KEY_INFO);
        assert_ne!(owner_bytes, enc_bytes, "the HKDF labels must diverge");
        assert_ne!(
            k.owner_sk,
            Fr::from_be_bytes_mod_order(&enc_bytes),
            "the spending key must not be recoverable from the encryption key material"
        );
    }

    /// The address is what a sender needs, and it must be exactly the keys the note format uses —
    /// otherwise money would be sent to a commitment its owner cannot reproduce.
    #[test]
    fn address_matches_the_note_format() {
        let cfg = cfg();
        let k = derive(&cfg, &[9u8; 32]);
        let addr = k.address();
        assert_eq!(addr.owner_pk, super::super::owner_pk(&cfg, k.owner_sk));
        assert_eq!(addr.enc_pk, k.enc.pk);

        // A note paid to this address must open with this wallet's encryption key and reconstruct
        // the same commitment — the full round trip a recipient performs.
        let rho = Fr::from(4242u64);
        let note = super::super::Note::new(500, addr.owner_pk, rho);
        let commitment = note.commitment(&cfg);
        let enc = super::super::encryption::encrypt(
            &cfg,
            JubjubFr::from(77u64),
            &addr.enc_pk,
            Fr::from(500u64),
            rho,
            0,
        );
        let found =
            super::super::encryption::try_open(&cfg, k.enc.sk, addr.owner_pk, commitment, &enc, 0)
                .expect("the recipient must find a note paid to their address");
        assert_eq!(found.amount, 500);
    }
}
