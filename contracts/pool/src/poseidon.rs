//! Poseidon over the BLS12-381 scalar field, on-chain.
//!
//! This must agree **bit-for-bit** with the circuit's hash (`prova_prover::poseidon_hash2`), which is
//! an arkworks `PoseidonSponge` with `rate = 2, capacity = 1, alpha = 5, 8 full + 57 partial rounds`.
//! The round constants and MDS matrix are not re-derived here — they are exported from the circuit by
//! `prova-prover poseidon-params` and embedded verbatim, so the two can never drift.
//!
//! Sponge reduction: absorbing two elements fills the rate exactly, and the first squeeze permutes
//! once and reads lane 1. So the whole sponge collapses to
//!
//! ```text
//! hash2(a, b) = permute([0, a, b])[1]
//! ```
//!
//! one permutation per Merkle node — which is what makes a depth-20 tree affordable on-chain.

use soroban_sdk::{crypto::bls12_381::Fr, BytesN, Env, U256};

/// `ark[65][3] ‖ mds[3][3]`, each element 32-byte big-endian. Exported from the circuit.
static PARAMS: &[u8] = include_bytes!("poseidon_params.bin");

pub const WIDTH: usize = 3;
pub const FULL_ROUNDS: usize = 8;
pub const PARTIAL_ROUNDS: usize = 57;
pub const ROUNDS: usize = FULL_ROUNDS + PARTIAL_ROUNDS;
/// Rounds 0..4 and 61..65 are full; everything between is partial.
const HALF_FULL: usize = FULL_ROUNDS / 2;
const ALPHA: u64 = 5;

const ARK_BYTES: usize = ROUNDS * WIDTH * 32;

/// Decoded round constants and MDS matrix.
///
/// Decoding costs ~200 host calls, so it is done **once per contract invocation** and shared across
/// every permutation — a `transact` performs 40 permutations against one `Poseidon`.
pub struct Poseidon {
    ark: [[Fr; WIDTH]; ROUNDS],
    mds: [[Fr; WIDTH]; WIDTH],
}

fn fr_at(env: &Env, offset: usize) -> Fr {
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&PARAMS[offset..offset + 32]);
    Fr::from_bytes(BytesN::from_array(env, &buf))
}

impl Poseidon {
    pub fn new(env: &Env) -> Self {
        debug_assert_eq!(PARAMS.len(), ARK_BYTES + WIDTH * WIDTH * 32);
        Self {
            ark: core::array::from_fn(|r| {
                core::array::from_fn(|i| fr_at(env, (r * WIDTH + i) * 32))
            }),
            mds: core::array::from_fn(|i| {
                core::array::from_fn(|j| fr_at(env, ARK_BYTES + (i * WIDTH + j) * 32))
            }),
        }
    }

    /// The Poseidon permutation on a width-3 state, in place.
    //
    // Indexed loops rather than iterators throughout: this mirrors the reference specification
    // round-for-round, and the circuit's gadget alongside it. Readability against the spec is worth
    // more here than idiom, because a divergence would not fail loudly — it would silently make
    // every note unspendable.
    #[allow(clippy::needless_range_loop, clippy::manual_range_contains)]
    pub fn permute(&self, env: &Env, state: &mut [Fr; WIDTH]) {
        let bls = env.crypto().bls12_381();
        for round in 0..ROUNDS {
            for i in 0..WIDTH {
                state[i] = bls.fr_add(&state[i], &self.ark[round][i]);
            }

            let is_full = round < HALF_FULL || round >= HALF_FULL + PARTIAL_ROUNDS;
            if is_full {
                for lane in state.iter_mut() {
                    *lane = bls.fr_pow(lane, ALPHA);
                }
            } else {
                state[0] = bls.fr_pow(&state[0], ALPHA);
            }

            let mixed: [Fr; WIDTH] = core::array::from_fn(|i| {
                let mut acc = bls.fr_mul(&self.mds[i][0], &state[0]);
                for j in 1..WIDTH {
                    acc = bls.fr_add(&acc, &bls.fr_mul(&self.mds[i][j], &state[j]));
                }
                acc
            });
            *state = mixed;
        }
    }

    /// The 2->1 compression used for every Merkle node. Matches `poseidon_hash2` in the circuit.
    pub fn hash2(&self, env: &Env, a: &Fr, b: &Fr) -> Fr {
        let mut state = [zero(env), a.clone(), b.clone()];
        self.permute(env, &mut state);
        state[1].clone()
    }
}

pub fn zero(env: &Env) -> Fr {
    Fr::from_u256(U256::from_u32(env, 0))
}
