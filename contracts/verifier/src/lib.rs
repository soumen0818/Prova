#![no_std]
// The Soroban `#[contractimpl]` macros regenerate the multi-input `verify`/`submit` signatures for
// the client + args types, so `too_many_arguments` must be allowed crate-wide, not per-function.
#![allow(clippy::too_many_arguments)]
//! Prova on-chain verifier (circuit v2, KYC-inclusive).
//!
//! Verifies a BLS12-381 Groth16 proof against the embedded verification key using Soroban's native
//! `bls12_381` host functions (`g1_msm` + `pairing_check`). The proof asserts, without revealing the
//! amount or identity: amount in range, commitment + nullifier are correct, and the sender holds an
//! anchor-signed KYC credential (verified in-circuit) that is unexpired and of sufficient level.
//!
//! Public inputs (order): `[commitment, nullifier, anchorPk.x, anchorPk.y, currentTime]`.
//! `submit` verifies the proof, rejects replays, records the commitment + nullifier, and emits an
//! event; `verify` is the pure proof check.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bls12_381::{Fr, G1Affine, G2Affine},
    symbol_short, vec, BytesN, Env, U256,
};

/// Frozen circuit-v2 (KYC) verifying key, in Soroban BLS12-381 encoding, from the prova-prover CLI:
/// `alpha(96) ‖ -beta(192) ‖ -gamma(192) ‖ -delta(192) ‖ IC0..IC5(96 each)`.
/// beta/gamma/delta are pre-negated so verification is a single `pairing_check`.
/// Public inputs (order): `[commitment, nullifier, anchorPk.x, anchorPk.y, currentTime]`.
static VK: &[u8] = include_bytes!("verifying_key.bin");

// Byte offsets into VK.
const ALPHA: usize = 0;
const NEG_BETA: usize = 96;
const NEG_GAMMA: usize = 288;
const NEG_DELTA: usize = 480;
const IC0: usize = 672; // constant term
const IC1: usize = 768; // commitment
const IC2: usize = 864; // nullifier
const IC3: usize = 960; // anchor pk.x
const IC4: usize = 1056; // anchor pk.y
const IC5: usize = 1152; // current time

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

/// Public inputs for circuit v2, in verification order.
struct PublicInputs {
    commitment: BytesN<32>,
    nullifier: BytesN<32>,
    anchor_pk_x: BytesN<32>,
    anchor_pk_y: BytesN<32>,
    current_time: BytesN<32>,
}

/// Core Groth16 check, shared by the pure `verify` view and the stateful `submit`.
///
/// Reduces the Groth16 equation to a single pairing check:
///   `e(A,B) · e(alpha, -beta) · e(vk_x, -gamma) · e(C, -delta) == 1`
/// where `vk_x = IC0 + commitment·IC1 + nullifier·IC2 + pkx·IC3 + pky·IC4 + time·IC5`.
fn verify_proof(
    env: &Env,
    proof_a: BytesN<96>,
    proof_b: BytesN<192>,
    proof_c: BytesN<96>,
    pi: &PublicInputs,
) -> bool {
    let bls = env.crypto().bls12_381();

    let a = G1Affine::from_bytes(proof_a);
    let b = G2Affine::from_bytes(proof_b);
    let c = G1Affine::from_bytes(proof_c);

    let alpha = vk_g1(env, ALPHA);
    let neg_beta = vk_g2(env, NEG_BETA);
    let neg_gamma = vk_g2(env, NEG_GAMMA);
    let neg_delta = vk_g2(env, NEG_DELTA);

    // vk_x = IC0·1 + IC1·commitment + IC2·nullifier + IC3·pkx + IC4·pky + IC5·time  (G1 MSM)
    let one = Fr::from_u256(U256::from_u32(env, 1));
    let ic = vec![
        env,
        vk_g1(env, IC0),
        vk_g1(env, IC1),
        vk_g1(env, IC2),
        vk_g1(env, IC3),
        vk_g1(env, IC4),
        vk_g1(env, IC5),
    ];
    let scalars = vec![
        env,
        one,
        Fr::from_bytes(pi.commitment.clone()),
        Fr::from_bytes(pi.nullifier.clone()),
        Fr::from_bytes(pi.anchor_pk_x.clone()),
        Fr::from_bytes(pi.anchor_pk_y.clone()),
        Fr::from_bytes(pi.current_time.clone()),
    ];
    let vk_x = bls.g1_msm(ic, scalars);

    let vp1 = vec![env, a, alpha, vk_x, c];
    let vp2 = vec![env, b, neg_beta, neg_gamma, neg_delta];
    bls.pairing_check(vp1, vp2)
}

#[contractimpl]
impl Verifier {
    /// Pure proof check (no state change). Returns true iff the KYC-inclusive proof is valid.
    ///
    /// Public inputs: `commitment`, `nullifier`, the anchor public key (`anchor_pk_x`,
    /// `anchor_pk_y`) the credential was signed by, and `current_time` used for the expiry check.
    pub fn verify(
        env: Env,
        proof_a: BytesN<96>,
        proof_b: BytesN<192>,
        proof_c: BytesN<96>,
        commitment: BytesN<32>,
        nullifier: BytesN<32>,
        anchor_pk_x: BytesN<32>,
        anchor_pk_y: BytesN<32>,
        current_time: BytesN<32>,
    ) -> bool {
        let pi = PublicInputs {
            commitment,
            nullifier,
            anchor_pk_x,
            anchor_pk_y,
            current_time,
        };
        verify_proof(&env, proof_a, proof_b, proof_c, &pi)
    }

    /// Submit one private transfer: verify the KYC proof, reject replays, record the commitment +
    /// nullifier, and emit an event the indexer consumes.
    ///
    /// Errors: `InvalidProof` if the proof fails; `NullifierAlreadyUsed` if the nullifier is spent.
    /// The contract never sees the amount or identity — only the commitment and nullifier.
    pub fn submit(
        env: Env,
        proof_a: BytesN<96>,
        proof_b: BytesN<192>,
        proof_c: BytesN<96>,
        commitment: BytesN<32>,
        nullifier: BytesN<32>,
        anchor_pk_x: BytesN<32>,
        anchor_pk_y: BytesN<32>,
        current_time: BytesN<32>,
    ) -> Result<(), Error> {
        // 1. Reject replays first (cheap) — anti-replay / double-spend.
        let nullifier_key = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&nullifier_key) {
            return Err(Error::NullifierAlreadyUsed);
        }

        // 2. Verify the proof before recording anything.
        let pi = PublicInputs {
            commitment: commitment.clone(),
            nullifier: nullifier.clone(),
            anchor_pk_x,
            anchor_pk_y,
            current_time,
        };
        if !verify_proof(&env, proof_a, proof_b, proof_c, &pi) {
            return Err(Error::InvalidProof);
        }

        // 3. Record nullifier (spent) + commitment, then emit the transfer event.
        env.storage().persistent().set(&nullifier_key, &true);
        env.storage()
            .persistent()
            .set(&DataKey::Commitment(commitment.clone()), &true);
        env.events()
            .publish((symbol_short!("transfer"),), (commitment, nullifier));
        Ok(())
    }

    /// Has this nullifier already been spent?
    pub fn is_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier))
    }

    /// Is this commitment recorded on-chain?
    pub fn is_committed(env: Env, commitment: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Commitment(commitment))
    }
}

mod test;
