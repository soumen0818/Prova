#![no_std]
//! Prova on-chain verifier.
//!
//! Phase 1: verifies a BLS12-381 Groth16 proof against the embedded verification key using
//! Soroban's native `bls12_381` host functions (`g1_msm` + `pairing_check`), returning accept/reject.
//! (The design pivoted from BN254 to BLS12-381 because Soroban only exposes BLS12-381 host
//! functions — see Docs and the prova-prover crate.)
//!
//! The proof asserts, without revealing the amount:
//!   - `1 <= amount <= 9999`                     (range)
//!   - `commitment = Poseidon(amount, secret)`
//!   - `nullifier  = Poseidon(secret, transferId)`
//!
//! Public inputs (in order): `[commitment, nullifier]`.
//!
//! Phase 0's nullifier registry + commitment store + events remain for Phase 2; `submit` records a
//! transfer, `verify` is the pure proof check.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bls12_381::{Fr, G1Affine, G2Affine},
    symbol_short, vec, BytesN, Env, U256,
};

/// Frozen circuit-v1 verifying key, in Soroban BLS12-381 encoding, produced by the prova-prover CLI:
/// `alpha(96) ‖ -beta(192) ‖ -gamma(192) ‖ -delta(192) ‖ IC0(96) ‖ IC1(96) ‖ IC2(96)`.
/// beta/gamma/delta are pre-negated so verification is a single `pairing_check`.
static VK: &[u8] = include_bytes!("verifying_key.bin");

// Byte offsets into VK.
const ALPHA: usize = 0;
const NEG_BETA: usize = 96;
const NEG_GAMMA: usize = 288;
const NEG_DELTA: usize = 480;
const IC0: usize = 672;
const IC1: usize = 768;
const IC2: usize = 864;

#[contracttype]
pub enum DataKey {
    /// Marks a nullifier as spent.
    Nullifier(BytesN<32>),
    /// Records a stored commitment.
    Commitment(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NullifierAlreadyUsed = 1,
    InvalidProof = 2,
}

#[contract]
pub struct Verifier;

/// Read a 96-byte G1 point from a slice of the embedded VK.
fn vk_g1(env: &Env, off: usize) -> G1Affine {
    let mut a = [0u8; 96];
    a.copy_from_slice(&VK[off..off + 96]);
    G1Affine::from_bytes(BytesN::from_array(env, &a))
}

/// Read a 192-byte G2 point from a slice of the embedded VK.
fn vk_g2(env: &Env, off: usize) -> G2Affine {
    let mut a = [0u8; 192];
    a.copy_from_slice(&VK[off..off + 192]);
    G2Affine::from_bytes(BytesN::from_array(env, &a))
}

#[contractimpl]
impl Verifier {
    /// Verify a Groth16 proof for one transfer against the embedded VK. Returns true iff valid.
    ///
    /// Reduces the Groth16 equation to a single pairing check:
    ///   `e(A,B) · e(alpha, -beta) · e(vk_x, -gamma) · e(C, -delta) == 1`
    /// where `vk_x = IC0 + commitment·IC1 + nullifier·IC2`.
    pub fn verify(
        env: Env,
        proof_a: BytesN<96>,
        proof_b: BytesN<192>,
        proof_c: BytesN<96>,
        commitment: BytesN<32>,
        nullifier: BytesN<32>,
    ) -> bool {
        let bls = env.crypto().bls12_381();

        let a = G1Affine::from_bytes(proof_a);
        let b = G2Affine::from_bytes(proof_b);
        let c = G1Affine::from_bytes(proof_c);

        let alpha = vk_g1(&env, ALPHA);
        let neg_beta = vk_g2(&env, NEG_BETA);
        let neg_gamma = vk_g2(&env, NEG_GAMMA);
        let neg_delta = vk_g2(&env, NEG_DELTA);

        // vk_x = IC0·1 + IC1·commitment + IC2·nullifier   (G1 multi-scalar multiplication)
        let one = Fr::from_u256(U256::from_u32(&env, 1));
        let ic = vec![&env, vk_g1(&env, IC0), vk_g1(&env, IC1), vk_g1(&env, IC2)];
        let scalars = vec![
            &env,
            one,
            Fr::from_bytes(commitment),
            Fr::from_bytes(nullifier),
        ];
        let vk_x = bls.g1_msm(ic, scalars);

        let vp1 = vec![&env, a, alpha, vk_x, c];
        let vp2 = vec![&env, b, neg_beta, neg_gamma, neg_delta];
        bls.pairing_check(vp1, vp2)
    }

    /// Has this nullifier already been spent?
    pub fn is_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier))
    }

    /// Record one transfer: reject replays, store the commitment, emit an event.
    ///
    /// Phase 2 wires proof verification in front of this; Phase 0/1 keep the registry mechanics.
    pub fn submit(env: Env, commitment: BytesN<32>, nullifier: BytesN<32>) -> Result<(), Error> {
        let nullifier_key = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&nullifier_key) {
            return Err(Error::NullifierAlreadyUsed);
        }

        env.storage().persistent().set(&nullifier_key, &true);
        env.storage()
            .persistent()
            .set(&DataKey::Commitment(commitment.clone()), &true);

        env.events()
            .publish((symbol_short!("transfer"),), (commitment, nullifier));
        Ok(())
    }
}

mod test;
