//! Shielded pool v3 — note primitives, the incremental Merkle tree, and the three circuits.
//!
//! See `Docs/shielded-pool.md`. The parameters here are frozen in `shared/src/pool.ts` and mirrored
//! in `shared/go/schema/pool.go`; the circuit, the Soroban contract, the backend indexer and the
//! wallet must agree **bit-for-bit** or notes become unspendable.
//!
//! Three circuits rather than one, each independently auditable:
//!
//! | Circuit | Proves | Runs on |
//! |---|---|---|
//! | [`spend`] | "I own a note in the tree, here is its nullifier, and value is conserved" | the phone |
//! | [`shield`] | "this commitment commits to exactly the amount I deposited" | the phone |
//! | [`fold`] | "appending these queued commitments takes the root from A to B" | a server |
//!
//! The split exists because the contract **cannot hash**: one on-chain Poseidon permutation measured
//! 10,967,507 CPU against Soroban's 100M budget, so a depth-20 append cannot even complete. The tree
//! update therefore moves into [`fold`], proved off-chain and merely *verified* on-chain.

use ark_bls12_381::Fr;
use ark_crypto_primitives::sponge::poseidon::PoseidonConfig;

use crate::{poseidon_hash2, poseidon_hash_n};

pub mod encryption;
pub mod ffi;
pub mod fold;
pub mod gadgets;
pub mod keys;
pub mod shield;
pub mod spend;
pub mod tree;

/// Tree depth — 2^20 ≈ 1.05M notes (`MerkleParams.DEPTH`).
pub const DEPTH: usize = 20;

/// Commitments folded per `update_root` call (`MerkleParams.BATCH`).
///
/// Each folded leaf is a Groth16 public input, costing ~1.49M CPU in the verifier's MSM. Measured:
/// 8 leaves ≈ 60M, 16 ≈ 71M, 32 ≈ 95M — 8 leaves keeps ~40M of headroom for custody, storage and
/// events. Raising this only requires a new fold setup; the spend circuit is unaffected.
pub const BATCH: usize = 8;

/// How many recent roots the contract accepts a spend against (`MerkleParams.ROOT_HISTORY`).
pub const ROOT_HISTORY: usize = 32;

/// Amounts are u64 minor units; every amount is range-checked to this width so that a sum can never
/// wrap the field and fake value conservation.
pub const AMOUNT_BITS: usize = 64;

/// Domain separator for owner-key derivation (`PoolDomain.OWNER`). Distinct from the credential's
/// `USER_ID_DOMAIN`, so an owner key can never be reused as a user id or vice versa.
pub const OWNER_DOMAIN: u64 = 1;

/// `ownerPk = Poseidon(ownerSk, OWNER_DOMAIN)` — the "address" that receives notes.
pub fn owner_pk(cfg: &PoseidonConfig<Fr>, owner_sk: Fr) -> Fr {
    poseidon_hash2(cfg, owner_sk, Fr::from(OWNER_DOMAIN))
}

/// `commitment = Poseidon(amount, ownerPk, rho)` — the leaf published on-chain. Reveals nothing:
/// `rho` is fresh per note, so two notes with the same amount and owner look unrelated.
pub fn note_commitment(cfg: &PoseidonConfig<Fr>, amount: Fr, owner_pk: Fr, rho: Fr) -> Fr {
    poseidon_hash_n(cfg, &[amount, owner_pk, rho])
}

/// `nullifier = Poseidon(ownerSk, rho)` — published when a note is spent.
///
/// Deterministic per note, so spending the same note twice produces the same nullifier and the
/// second attempt is rejected on-chain. It reveals nothing about *which* note was spent.
pub fn note_nullifier(cfg: &PoseidonConfig<Fr>, owner_sk: Fr, rho: Fr) -> Fr {
    poseidon_hash2(cfg, owner_sk, rho)
}

/// A fully-specified note plus the secret that owns it.
#[derive(Clone, Copy, Debug)]
pub struct Note {
    pub amount: u64,
    pub owner_pk: Fr,
    pub rho: Fr,
}

impl Note {
    pub fn new(amount: u64, owner_pk: Fr, rho: Fr) -> Self {
        Self {
            amount,
            owner_pk,
            rho,
        }
    }

    /// This note's commitment — the value that becomes a tree leaf.
    pub fn commitment(&self, cfg: &PoseidonConfig<Fr>) -> Fr {
        note_commitment(cfg, Fr::from(self.amount), self.owner_pk, self.rho)
    }
}

/// The empty-leaf value; every zero-subtree hash derives from it (`MerkleParams.EMPTY_LEAF`).
pub fn empty_leaf() -> Fr {
    Fr::from(0u64)
}

/// Zero-subtree hashes: `zeros[0] = EMPTY_LEAF`, `zeros[i+1] = Poseidon(zeros[i], zeros[i])`.
///
/// `zeros[i]` is the root of a fully-empty subtree of height `i`, which is what an incremental tree
/// combines with when a node has no right sibling yet. Shared by the circuit, the indexer and the
/// wallet — all three must derive them identically.
pub fn zero_hashes(cfg: &PoseidonConfig<Fr>) -> [Fr; DEPTH + 1] {
    let mut z = [empty_leaf(); DEPTH + 1];
    for i in 0..DEPTH {
        z[i + 1] = poseidon_hash2(cfg, z[i], z[i]);
    }
    z
}

// ---------------------------------------------------------------------------
// Trusted setup
// ---------------------------------------------------------------------------

/// Deterministic Groth16 keys for the three pool circuits.
///
/// Seeded so testnet artifacts are reproducible: anyone can re-run this and get byte-identical
/// verifying keys, which is what lets the deployed contract be checked against the source. **The
/// toxic waste is therefore public — testnet only.** Mainnet requires a real multi-party ceremony.
///
/// Each circuit is set up independently, so a change to one does not invalidate the others.
pub mod setup {
    use ark_bls12_381::{Bls12_381, Fr};
    use ark_crypto_primitives::sponge::poseidon::PoseidonConfig;
    use ark_groth16::{Groth16, ProvingKey, VerifyingKey};
    use ark_snark::SNARK;
    use ark_std::rand::{rngs::StdRng, SeedableRng};

    use crate::poseidon_config;

    type Keys = (ProvingKey<Bls12_381>, VerifyingKey<Bls12_381>);

    fn cfg() -> PoseidonConfig<Fr> {
        poseidon_config::<Fr>()
    }

    /// Spend circuit keys. Distinct sub-seeds keep the three setups independent.
    pub fn spend(seed: u64) -> Keys {
        let mut rng = StdRng::seed_from_u64(seed ^ 0x5FE4D);
        Groth16::<Bls12_381>::circuit_specific_setup(super::spend::dummy_circuit(cfg()), &mut rng)
            .expect("spend setup")
    }

    /// Shield circuit keys.
    pub fn shield(seed: u64) -> Keys {
        let mut rng = StdRng::seed_from_u64(seed ^ 0x5417D);
        Groth16::<Bls12_381>::circuit_specific_setup(super::shield::dummy_circuit(cfg()), &mut rng)
            .expect("shield setup")
    }

    /// Fold circuit keys.
    pub fn fold(seed: u64) -> Keys {
        let mut rng = StdRng::seed_from_u64(seed ^ 0xF01D);
        Groth16::<Bls12_381>::circuit_specific_setup(super::fold::dummy_circuit(cfg()), &mut rng)
            .expect("fold setup")
    }
}
