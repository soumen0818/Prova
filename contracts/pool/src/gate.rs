//! Test-only contract that keeps the V1.0 gate measurements executable.
//!
//! The production [`crate::Pool`] deliberately contains **no** Poseidon and no hashing — that is the
//! whole finding. But the measurement that forced the design must stay runnable, or it degrades into
//! folklore that nobody can re-check. So the permutation and the cost probes live here, compiled
//! only for tests, and `crate::test` asserts the *negative* result: if Soroban's scalar host
//! functions ever get cheap enough for an on-chain tree to fit, those assertions fail and the
//! architecture is worth revisiting.

use soroban_sdk::{contract, contractimpl, crypto::bls12_381::Fr, Bytes, BytesN, Env, Vec};

use crate::poseidon;

#[contract]
pub struct Gate;

#[contractimpl]
impl Gate {
    /// `Poseidon(a, b)` — the 2→1 compression a Merkle node would need.
    pub fn hash2(env: Env, a: BytesN<32>, b: BytesN<32>) -> BytesN<32> {
        let p = poseidon::Poseidon::new(&env);
        p.hash2(&env, &Fr::from_bytes(a), &Fr::from_bytes(b))
            .to_bytes()
    }

    /// Decode the round constants and nothing else — isolates setup cost from permutation cost.
    pub fn params_only(env: Env) -> u32 {
        let _ = poseidon::Poseidon::new(&env);
        0
    }

    /// `n` raw `fr_mul` host calls — isolates the per-host-call overhead of the SDK's `Fr` wrapper.
    pub fn fr_mul_loop(env: Env, n: u32) -> BytesN<32> {
        let bls = env.crypto().bls12_381();
        let x = Fr::from_bytes(BytesN::from_array(&env, &[3u8; 32]));
        let mut acc = x.clone();
        for _ in 0..n {
            acc = bls.fr_mul(&acc, &x);
        }
        acc.to_bytes()
    }

    /// `n` raw `fr_add` host calls.
    pub fn fr_add_loop(env: Env, n: u32) -> BytesN<32> {
        let bls = env.crypto().bls12_381();
        let x = Fr::from_bytes(BytesN::from_array(&env, &[3u8; 32]));
        let mut acc = x.clone();
        for _ in 0..n {
            acc = bls.fr_add(&acc, &x);
        }
        acc.to_bytes()
    }

    /// `n` raw `fr_pow(5)` host calls — the Poseidon S-box.
    pub fn fr_pow_loop(env: Env, n: u32) -> BytesN<32> {
        let bls = env.crypto().bls12_381();
        let x = Fr::from_bytes(BytesN::from_array(&env, &[3u8; 32]));
        let mut acc = x.clone();
        for _ in 0..n {
            acc = bls.fr_pow(&acc, 5);
        }
        acc.to_bytes()
    }

    /// Fold `leaf` up `depth` levels — the work one tree append would perform on-chain.
    pub fn hash_path(env: Env, leaf: BytesN<32>, sibling: BytesN<32>, depth: u32) -> BytesN<32> {
        let p = poseidon::Poseidon::new(&env);
        let sib = Fr::from_bytes(sibling);
        let mut acc = Fr::from_bytes(leaf);
        for _ in 0..depth {
            acc = p.hash2(&env, &acc, &sib);
        }
        acc.to_bytes()
    }

    /// `g1_msm` over `n` points — the marginal cost of one more Groth16 public input, which is what
    /// caps the fold batch size.
    pub fn msm_loop(env: Env, n: u32) -> BytesN<96> {
        let bls = env.crypto().bls12_381();
        let dst = Bytes::from_slice(&env, b"PROVA-MEASURE");
        let p = bls.hash_to_g1(&Bytes::from_slice(&env, b"p"), &dst);
        let s = Fr::from_bytes(BytesN::from_array(&env, &[3u8; 32]));
        let mut vp = Vec::new(&env);
        let mut vs = Vec::new(&env);
        for _ in 0..n {
            vp.push_back(p.clone());
            vs.push_back(s.clone());
        }
        if n == 0 {
            return p.to_bytes();
        }
        bls.g1_msm(vp, vs).to_bytes()
    }

    /// `n` chained `sha256` calls — the binding alternative that was measured and rejected.
    pub fn sha_chain(env: Env, n: u32) -> BytesN<32> {
        let mut acc = BytesN::from_array(&env, &[0u8; 32]);
        for _ in 0..n {
            let mut buf = Bytes::new(&env);
            buf.append(&acc.clone().into());
            buf.append(&Bytes::from_slice(&env, &[7u8; 32]));
            acc = env.crypto().sha256(&buf).to_bytes();
        }
        acc
    }

    /// `n` persistent-storage writes — what queueing `n` commitments actually costs.
    pub fn store_loop(env: Env, n: u32) {
        for i in 0..n {
            env.storage().persistent().set(&i, &[7u8; 32]);
        }
    }
}
