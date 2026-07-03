#![no_std]
//! Prova on-chain verifier (skeleton).
//!
//! Responsibilities (proposal.md §4.1):
//!   - verify the Groth16 proof via a BN254 pairing check  (Phase 1 — TODO below)
//!   - reject replayed nullifiers (anti-replay / double-spend)
//!   - record commitments, emit an event the indexer consumes
//!
//! Phase 0 ships the nullifier registry + commitment store + events. The pairing check is wired in
//! Phase 1 once the circuit's verification key is frozen in `@prova/shared`.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, BytesN, Env};

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

#[contractimpl]
impl Verifier {
    /// Submit one private transfer: verify, reject replays, record commitment, emit event.
    pub fn submit(
        env: Env,
        commitment: BytesN<32>,
        nullifier: BytesN<32>,
    ) -> Result<(), Error> {
        let nullifier_key = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&nullifier_key) {
            return Err(Error::NullifierAlreadyUsed);
        }

        // TODO(Phase 1): verify the Groth16 proof here (BN254 pairing) before recording anything.
        // Return Err(Error::InvalidProof) on failure.

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
}

mod test;
