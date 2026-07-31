#![cfg(test)]

use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{token, Address, BytesN, Env};

use super::*;

// =====================================================================================
// Part 1 — the V1.0 gate. Kept executable so the finding can be re-checked, not trusted.
// =====================================================================================

mod gate_measurements {
    use super::*;
    use crate::gate::{Gate, GateClient};
    use crate::poseidon::{FULL_ROUNDS, PARTIAL_ROUNDS, ROUNDS, WIDTH};

    fn setup() -> (Env, GateClient<'static>) {
        let env = Env::default();
        let id = env.register(Gate, ());
        let client = GateClient::new(&env, &id);
        (env, client)
    }

    fn fr_hex(env: &Env, s: &str) -> BytesN<32> {
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).expect("hex");
        }
        BytesN::from_array(env, &out)
    }

    fn u64_fr(env: &Env, v: u64) -> BytesN<32> {
        let mut out = [0u8; 32];
        out[24..].copy_from_slice(&v.to_be_bytes());
        BytesN::from_array(env, &out)
    }

    fn measure(env: &Env, label: &str, f: impl FnOnce()) -> u64 {
        env.cost_estimate().budget().reset_default();
        f();
        let cpu = env.cost_estimate().budget().cpu_instruction_cost();
        let mem = env.cost_estimate().budget().memory_bytes_cost();
        std::println!("PROVA_V1_0_GATE {label} cpu_insns={cpu} mem_bytes={mem}");
        cpu
    }

    /// Vectors produced by the circuit itself (`prova-prover poseidon-hash2`). The reference
    /// implementation is correct — it simply cannot be afforded on-chain, which is the next test.
    #[test]
    fn hash2_matches_circuit_vectors() {
        let (env, client) = setup();
        assert_eq!(
            client.hash2(&u64_fr(&env, 1), &u64_fr(&env, 2)),
            fr_hex(
                &env,
                "51f3e312c95343a896cfd8945ea82ba956c1118ce9b9859b6ea56637b4b1ddc4"
            ),
            "Poseidon(1, 2) must match the circuit"
        );
        assert_eq!(
            client.hash2(&u64_fr(&env, 0), &u64_fr(&env, 0)),
            fr_hex(
                &env,
                "10a9e48afc92bd4669b3a8c08c8c99d4144632da67c6cb9bb19cc8facaf8ed3e"
            ),
            "Poseidon(0, 0) — the empty-subtree seed — must match the circuit"
        );
    }

    #[test]
    fn hash2_is_order_sensitive() {
        let (env, client) = setup();
        let ab = client.hash2(&u64_fr(&env, 1), &u64_fr(&env, 2));
        let ba = client.hash2(&u64_fr(&env, 2), &u64_fr(&env, 1));
        assert_ne!(ab, ba, "left/right ordering must matter, or paths are forgeable");
    }

    /// Where the CPU actually goes. `fr_add`, `fr_mul` and `fr_pow` costing the same is the tell:
    /// the arithmetic is not what is paid for, the per-host-call boundary is.
    #[test]
    fn cost_breakdown() {
        let (env, client) = setup();
        let params = measure(&env, "params_decode_only", || {
            client.params_only();
        });
        let mul0 = measure(&env, "fr_mul_x0", || {
            client.fr_mul_loop(&0);
        });
        let mul100 = measure(&env, "fr_mul_x100", || {
            client.fr_mul_loop(&100);
        });
        let add0 = measure(&env, "fr_add_x0", || {
            client.fr_add_loop(&0);
        });
        let add100 = measure(&env, "fr_add_x100", || {
            client.fr_add_loop(&100);
        });
        let pow0 = measure(&env, "fr_pow_x0", || {
            client.fr_pow_loop(&0);
        });
        let pow100 = measure(&env, "fr_pow_x100", || {
            client.fr_pow_loop(&100);
        });
        let one = measure(&env, "hash2_total", || {
            client.hash2(&u64_fr(&env, 1), &u64_fr(&env, 2));
        });

        let ops_add = ROUNDS * (WIDTH + 2);
        let ops_mul = ROUNDS * WIDTH;
        let ops_pow = FULL_ROUNDS * WIDTH + PARTIAL_ROUNDS;
        std::println!(
            "PROVA_V1_0_GATE breakdown params={params} per_fr_add={} per_fr_mul={} per_fr_pow={} \
             permutation_only={} ops/perm add={ops_add} mul={ops_mul} pow={ops_pow}",
            (add100 - add0) / 100,
            (mul100 - mul0) / 100,
            (pow100 - pow0) / 100,
            one.saturating_sub(params)
        );
    }

    /// Prices the two ways a fold proof could be bound to the queued commitments. A public input
    /// costs ~120× a `sha256`, but SHA-256 costs ~42,000 constraints per block *in-circuit* against
    /// 240 for a Poseidon hash — so public inputs win, and the batch size is what pays for it.
    #[test]
    fn binding_cost_breakdown() {
        let (env, client) = setup();
        let msm8 = measure(&env, "msm_x8", || {
            client.msm_loop(&8);
        });
        let msm40 = measure(&env, "msm_x40", || {
            client.msm_loop(&40);
        });
        let sha0 = measure(&env, "sha_chain_x0", || {
            client.sha_chain(&0);
        });
        let sha32 = measure(&env, "sha_chain_x32", || {
            client.sha_chain(&32);
        });
        let store0 = measure(&env, "store_x0", || {
            client.store_loop(&0);
        });
        let store32 = measure(&env, "store_x32", || {
            client.store_loop(&32);
        });
        std::println!(
            "PROVA_BINDING per_msm_point={} per_sha256={} per_store={}",
            (msm40 - msm8) / 32,
            (sha32 - sha0) / 32,
            (store32 - store0) / 32
        );
    }

    /// **The gate — and it fails.** One permutation costs ~11M CPU, so a depth-20 append (20 of
    /// them) cannot run to completion inside the 100M budget, let alone leave room for the ~49M
    /// verify. This asserts the *negative* result: if Soroban's scalar ops ever get cheap enough for
    /// it to pass, the assertion fires and the batched design is worth revisiting.
    #[test]
    fn gate_onchain_merkle_does_not_fit_cpu_budget() {
        let (env, client) = setup();
        let a = u64_fr(&env, 1);
        let b = u64_fr(&env, 2);

        let one = measure(&env, "one_permutation", || {
            client.hash2(&a, &b);
        });

        const VERIFY: u64 = 49_048_967; // measured, prova-verifier
        const BUDGET: u64 = 100_000_000;
        let append = one * DEPTH as u64;
        std::println!(
            "PROVA_V1_0_GATE verdict one_permutation={one} append_depth20~{append} \
             transact~{} +verify~{} vs budget={BUDGET} => FAILS",
            append * 2,
            append * 2 + VERIFY
        );
        assert!(
            append + VERIFY > BUDGET,
            "on-chain Poseidon now fits the CPU budget — revisit the batched tree update"
        );

        // The extrapolation is linear, so confirm it against a depth that actually fits. Past ~8
        // levels the budget is exhausted outright (an uncatchable host abort), which is why the real
        // depth-20 append cannot be measured at all.
        let depth8 = measure(&env, "merkle_append_depth8", || {
            client.hash_path(&a, &b, &8);
        });
        let ceiling = BUDGET / one;
        std::println!(
            "PROVA_V1_0_GATE ceiling depth8={depth8} max_permutations_per_invocation={ceiling} \
             (need {} for a transact)",
            DEPTH * 2
        );
        assert!(
            ceiling < DEPTH as u64,
            "a single append now fits — revisit the batched tree update"
        );
    }
}

// =====================================================================================
// Part 2 — the pool itself, against proofs generated from the real circuits.
// =====================================================================================

mod harness {
    //! Builds real proofs so the contract is exercised against the actual circuits.
    //!
    //! Replaying pre-generated fixtures would let the circuit and the contract drift apart silently;
    //! generating here means a mismatch in public-input order, encoding or semantics fails in CI
    //! rather than on testnet. Proving keys are built once and shared — setup dominates the runtime.

    use std::sync::OnceLock;
    use std::vec::Vec as StdVec;

    use ark_bls12_381::{Bls12_381, Fr};
    use ark_groth16::{Groth16, ProvingKey};
    use ark_snark::SNARK;
    use ark_std::rand::{rngs::StdRng, SeedableRng};
    use ark_ed_on_bls12_381::Fr as JubjubFr;
    use prova_prover::pool::{
        encryption::EncKey,
        fold::FoldCircuit,
        owner_pk, setup,
        shield::ShieldCircuit,
        spend::{SpendCircuit, SpendOutput},
        tree::MerkleTree,
        Note,
    };
    use prova_prover::{credential, poseidon_config, soroban_ser};
    use soroban_sdk::{BytesN, Env};

    /// Must match the seed `pool-artifacts` used for the embedded verifying keys.
    pub const SEED: u64 = 42;
    pub const NOW: u64 = 1_700_000_000;

    pub struct Keys {
        pub spend: ProvingKey<Bls12_381>,
        pub shield: ProvingKey<Bls12_381>,
        pub fold: ProvingKey<Bls12_381>,
    }

    pub fn keys() -> &'static Keys {
        static KEYS: OnceLock<Keys> = OnceLock::new();
        KEYS.get_or_init(|| Keys {
            spend: setup::spend(SEED).0,
            shield: setup::shield(SEED).0,
            fold: setup::fold(SEED).0,
        })
    }

    /// Re-exported so the harness hands the contract exactly the type its entrypoints take.
    pub use crate::Proof;

    fn to_soroban(env: &Env, p: &ark_groth16::Proof<Bls12_381>) -> Proof {
        Proof {
            a: BytesN::from_array(env, &soroban_ser::g1_bytes(&p.a)),
            b: BytesN::from_array(env, &soroban_ser::g2_bytes(&p.b)),
            c: BytesN::from_array(env, &soroban_ser::g1_bytes(&p.c)),
        }
    }

    pub fn fr_bytes(env: &Env, f: &Fr) -> BytesN<32> {
        BytesN::from_array(env, &soroban_ser::fr_bytes(f))
    }

    /// A funded, KYC'd user plus the wallet's view of the tree.
    pub struct Wallet {
        pub cfg: ark_crypto_primitives::sponge::poseidon::PoseidonConfig<Fr>,
        pub anchor: credential::AnchorKey,
        pub cred: credential::Credential,
        pub owner_sk: Fr,
        pub owner_pk: Fr,
        pub tree: MerkleTree,
        pub enc: EncKey,
    }

    impl Wallet {
        pub fn new() -> Self {
            Self::with_anchor_seed(SEED)
        }

        /// Same owner key, different anchor. Lets a test rotate the KYC signing key while the notes
        /// already in the tree stay spendable by the same person.
        pub fn with_anchor_seed(seed: u64) -> Self {
            let cfg = poseidon_config::<Fr>();
            let mut rng = StdRng::seed_from_u64(seed);
            let anchor = credential::AnchorKey::generate(&mut rng);
            let owner_sk = Fr::from(1234567u64);
            let pk = owner_pk(&cfg, owner_sk);
            let uid = credential::user_id(&cfg, owner_sk);
            let cred = credential::issue(&cfg, &anchor, uid, 2, 2_000_000_000, &mut rng);
            let tree = MerkleTree::new(&cfg);
            let enc = EncKey::generate(&mut rng);
            Self {
                cfg,
                anchor,
                cred,
                owner_sk,
                owner_pk: pk,
                tree,
                enc,
            }
        }

        pub fn note(&self, amount: u64, rho: u64) -> Note {
            Note::new(amount, self.owner_pk, Fr::from(rho))
        }

        /// Prove a deposit's commitment binds its amount, and encrypt the note to its owner.
        pub fn shield(&self, env: &Env, note: &Note) -> (Proof, crate::ShieldNote) {
            let c = ShieldCircuit::new(
                self.cfg.clone(),
                note.amount,
                note.owner_pk,
                note.rho,
                self.enc.pk,
                JubjubFr::from(0xE0u64 + note.amount),
            );
            let public = c.public_inputs().unwrap();
            let mut rng = StdRng::seed_from_u64(SEED + note.amount);
            let proof = Groth16::<Bls12_381>::prove(&keys().shield, c, &mut rng).unwrap();
            (
                to_soroban(env, &proof),
                crate::ShieldNote {
                    commitment: fr_bytes(env, &public[0]),
                    owner_pk: fr_bytes(env, &public[2]),
                    epk_x: fr_bytes(env, &public[3]),
                    epk_y: fr_bytes(env, &public[4]),
                    enc_amount: fr_bytes(env, &public[5]),
                    enc_rho: fr_bytes(env, &public[6]),
                },
            )
        }

        /// Prove that appending `leaves` advances the tree, and adopt the result.
        pub fn fold(&mut self, env: &Env, leaves: &[Fr]) -> (Proof, BytesN<32>, u32) {
            let (circuit, next) = FoldCircuit::from_tree(&self.cfg, &self.tree, leaves);
            let new_root = circuit.new_root.unwrap();
            let mut rng = StdRng::seed_from_u64(SEED + self.tree.next_index() + 7);
            let proof = Groth16::<Bls12_381>::prove(&keys().fold, circuit, &mut rng).unwrap();
            self.tree = next;
            (
                to_soroban(env, &proof),
                fr_bytes(env, &new_root),
                leaves.len() as u32,
            )
        }

        /// Prove a spend of the note at `leaf_index`.
        #[allow(clippy::too_many_arguments)]
        pub fn spend(
            &self,
            env: &Env,
            leaf_index: u64,
            in_note: &Note,
            out1: Note,
            out2: Note,
            public_amount: u64,
            destination: Fr,
        ) -> (Proof, StdVec<BytesN<32>>) {
            let path = self.tree.path(leaf_index);
            let circuit = SpendCircuit::new(
                self.cfg.clone(),
                in_note.amount,
                in_note.rho,
                self.owner_sk,
                &path,
                SpendOutput::new(out1, self.enc.pk),
                SpendOutput::new(out2, self.enc.pk),
                JubjubFr::from(0xE55u64 + leaf_index),
                public_amount,
                destination,
                &self.cred,
                self.anchor.pk,
                NOW,
            );
            let public = circuit.public_inputs().unwrap();
            let mut rng = StdRng::seed_from_u64(SEED + leaf_index + 13);
            let proof = Groth16::<Bls12_381>::prove(&keys().spend, circuit, &mut rng).unwrap();
            (
                to_soroban(env, &proof),
                public.iter().map(|f| fr_bytes(env, f)).collect(),
            )
        }

        /// Read back the field element the contract binds a payout address to, so the proof is
        /// built against exactly what the contract will check. See `Pool::destination_field`.
        pub fn destination(&self, field: &BytesN<32>) -> Fr {
            use ark_ff::PrimeField;
            Fr::from_be_bytes_mod_order(&field.to_array())
        }
    }
}

use harness::{Wallet, NOW};

struct Fixture {
    env: Env,
    pool: PoolClient<'static>,
    token: token::Client<'static>,
    user: Address,
    admin: Address,
}

const START_BALANCE: i128 = 1_000_000;

fn fixture() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let token_admin = Address::generate(&env);
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin).address();
    token::StellarAssetClient::new(&env, &token_id).mint(&user, &START_BALANCE);

    let wallet = Wallet::new();
    let pool_id = env.register(Pool, ());
    let pool = PoolClient::new(&env, &pool_id);
    pool.initialize(
        &admin,
        &token_id,
        &harness::fr_bytes(&env, &wallet.anchor.pk.x),
        &harness::fr_bytes(&env, &wallet.anchor.pk.y),
    );
    let token = token::Client::new(&env, &token_id);

    Fixture {
        env,
        pool,
        token,
        user,
        admin,
    }
}

/// Build the contract's `Outputs` from a spend's public inputs.
///
/// The encrypted payloads are *produced by the circuit*, so the test must pass exactly what the
/// proof committed to — which is the whole property being relied on. Indices follow the frozen
/// order: 2,3 = commitments; 9,10 = ephemeral key; 11..14 = the two masked payloads.
fn outputs(pi: &[BytesN<32>]) -> Outputs {
    Outputs {
        c1: pi[2].clone(),
        c2: pi[3].clone(),
        epk_x: pi[9].clone(),
        epk_y: pi[10].clone(),
        enc1_amount: pi[11].clone(),
        enc1_rho: pi[12].clone(),
        enc2_amount: pi[13].clone(),
        enc2_rho: pi[14].clone(),
    }
}

fn zero_fr() -> ark_bls12_381::Fr {
    ark_bls12_381::Fr::from(0u64)
}

/// Shield a note and fold it in, leaving it spendable at leaf 0. The starting point for most tests.
fn funded(f: &Fixture, w: &mut Wallet, amount: u64) -> prova_prover::pool::Note {
    let note = w.note(amount, 1001);
    let (p, note_data) = w.shield(&f.env, &note);
    f.pool.shield(&f.user, &(amount as i128), &note_data, &p);
    let (p, new_root, count) = w.fold(&f.env, &[note.commitment(&w.cfg)]);
    f.pool.update_root(&p, &new_root, &count);
    note
}

// ---- happy path ----

/// The full product flow: deposit → make it spendable → send privately → cash out.
#[test]
fn shield_fold_transact_fold_unshield_end_to_end() {
    let f = fixture();
    let mut w = Wallet::new();
    let pool_addr = f.pool.address.clone();

    // 1. Shield 1000. Tokens really move; the note is queued, not yet spendable.
    let note0 = w.note(1000, 1001);
    let (p, note_data) = w.shield(&f.env, &note0);
    f.pool
        .shield(&f.user, &1000, &note_data, &p);
    assert_eq!(f.token.balance(&f.user), START_BALANCE - 1000);
    assert_eq!(f.token.balance(&pool_addr), 1000, "pool custodies the deposit");
    assert_eq!(f.pool.queue_depth(), 1);
    assert_eq!(f.pool.next_index(), 0, "queued, not yet folded");

    // 2. Fold it in — only now is it a leaf, and only now is it spendable.
    let (p, new_root, count) = w.fold(&f.env, &[note0.commitment(&w.cfg)]);
    f.pool.update_root(&p, &new_root, &count);
    assert_eq!(f.pool.next_index(), 1);
    assert_eq!(f.pool.queue_depth(), 0);
    assert_eq!(f.pool.root(), Some(new_root.clone()));

    // 3. Private transfer: 1000 → 600 + 400. No tokens move; nothing about it is public.
    let out1 = w.note(600, 2001);
    let out2 = w.note(400, 2002);
    let (p, pi) = w.spend(&f.env, 0, &note0, out1, out2, 0, zero_fr());
    f.pool.transact(
        &p,
        &pi[0],
        &pi[1],
        &outputs(&pi),
        &NOW,
    );
    assert!(f.pool.is_spent(&pi[1]), "the input note is now nullified");
    assert_eq!(f.pool.queue_depth(), 2);
    assert_eq!(
        f.token.balance(&pool_addr),
        1000,
        "a private transfer moves no tokens"
    );

    // 4. Fold both outputs.
    let (p, new_root, count) =
        w.fold(&f.env, &[out1.commitment(&w.cfg), out2.commitment(&w.cfg)]);
    f.pool.update_root(&p, &new_root, &count);
    assert_eq!(f.pool.next_index(), 3);

    // 5. Unshield the 600 note to a public destination.
    let payout = Address::generate(&f.env);
    let dest = w.destination(&f.pool.destination_field(&payout));
    let (p, pi) = w.spend(&f.env, 1, &out1, w.note(0, 3001), w.note(0, 3002), 600, dest);
    f.pool.unshield(
        &p,
        &pi[0],
        &pi[1],
        &outputs(&pi),
        &600,
        &payout,
        &NOW,
    );

    assert_eq!(f.token.balance(&payout), 600, "the payout landed");
    assert_eq!(
        f.token.balance(&pool_addr),
        400,
        "the pool still custodies exactly the unspent 400"
    );
    assert_eq!(
        f.token.balance(&f.user) + f.token.balance(&payout) + f.token.balance(&pool_addr),
        START_BALANCE,
        "no value created or destroyed anywhere in the run"
    );
}

// ---- must-fail: double-spend, theft, and folder misbehaviour ----

/// The core anti-double-spend rule.
#[test]
fn replayed_nullifier_is_rejected() {
    let f = fixture();
    let mut w = Wallet::new();
    let note0 = funded(&f, &mut w, 1000);

    let out1 = w.note(600, 2001);
    let out2 = w.note(400, 2002);
    let (p, pi) = w.spend(&f.env, 0, &note0, out1, out2, 0, zero_fr());
    let out = outputs(&pi);
    f.pool.transact(&p, &pi[0], &pi[1], &out, &NOW);

    // Exactly the same proof again — the note is already spent.
    let err = f
        .pool
        .try_transact(&p, &pi[0], &pi[1], &out, &NOW)
        .expect_err("a replayed spend must be rejected");
    assert_eq!(err, Ok(Error::NullifierAlreadyUsed));
}

/// A note cannot be spent before the fold that puts it in the tree — there is no root to prove
/// against. This is the ordering rule wallets must respect.
#[test]
fn spending_before_the_fold_is_rejected() {
    let f = fixture();
    let w = Wallet::new();

    let note0 = w.note(1000, 1001);
    let (p, note_data) = w.shield(&f.env, &note0);
    f.pool
        .shield(&f.user, &1000, &note_data, &p);

    // Build a spend against the root the note *would* produce, without folding it in.
    let mut speculative = Wallet::new();
    speculative.tree.insert(note0.commitment(&w.cfg));
    let (p, pi) = speculative.spend(
        &f.env,
        0,
        &note0,
        w.note(600, 2001),
        w.note(400, 2002),
        0,
        zero_fr(),
    );
    let err = f
        .pool
        .try_transact(&p, &pi[0], &pi[1], &outputs(&pi), &NOW)
        .expect_err("an unfolded note has no accepted root");
    assert_eq!(err, Ok(Error::UnknownRoot));
}

/// A proof built against a root that has since advanced must still land. Without this, two people
/// transferring at the same moment would collide and one would always fail — the whole reason the
/// 32-root window exists.
#[test]
fn stale_but_in_window_root_is_accepted() {
    let f = fixture();
    let mut w = Wallet::new();
    let note0 = funded(&f, &mut w, 1000);
    let root_at_build = f.pool.root().unwrap();

    // The wallet builds its spend against the current root...
    let (p, pi) = w.spend(
        &f.env,
        0,
        &note0,
        w.note(600, 2001),
        w.note(400, 2002),
        0,
        zero_fr(),
    );

    // ...but three other deposits land and fold first, advancing the root three times.
    for i in 0..3u64 {
        let other = w.note(10 + i, 5000 + i);
        let (sp, other_data) = w.shield(&f.env, &other);
        f.pool.shield(&f.user, &(other.amount as i128), &other_data, &sp);
        let (fp, new_root, count) = w.fold(&f.env, &[other.commitment(&w.cfg)]);
        f.pool.update_root(&fp, &new_root, &count);
    }
    assert_ne!(f.pool.root().unwrap(), root_at_build, "the root moved on");

    // The in-flight spend still verifies against its now-stale root.
    f.pool.transact(
        &p,
        &pi[0],
        &pi[1],
        &outputs(&pi),
        &NOW,
    );
    assert!(f.pool.is_spent(&pi[1]));
}

/// The other side of the window: once a root has been pushed out of the 32-slot ring, proofs against
/// it must stop being accepted.
#[test]
fn evicted_root_is_rejected() {
    let f = fixture();
    let mut w = Wallet::new();
    let note0 = funded(&f, &mut w, 1000);

    let (p, pi) = w.spend(
        &f.env,
        0,
        &note0,
        w.note(600, 2001),
        w.note(400, 2002),
        0,
        zero_fr(),
    );
    let stale_root = pi[0].clone();
    assert!(f.pool.is_known_root(&stale_root));

    // Advance past the whole history window.
    for i in 0..(ROOT_HISTORY as u64 + 1) {
        let other = w.note(10 + i, 6000 + i);
        let (sp, other_data) = w.shield(&f.env, &other);
        f.pool.shield(&f.user, &(other.amount as i128), &other_data, &sp);
        let (fp, new_root, count) = w.fold(&f.env, &[other.commitment(&w.cfg)]);
        f.pool.update_root(&fp, &new_root, &count);
    }

    assert!(
        !f.pool.is_known_root(&stale_root),
        "the root should have aged out of the ring"
    );
    let err = f
        .pool
        .try_transact(&p, &pi[0], &pi[1], &outputs(&pi), &NOW)
        .expect_err("a proof against an evicted root must be rejected");
    assert_eq!(err, Ok(Error::UnknownRoot));
}

/// `count` must match what was actually queued, or the queue head would run past real commitments
/// and the notes in them would be lost.
#[test]
fn folding_more_than_the_queue_holds_is_rejected() {
    let f = fixture();
    let mut w = Wallet::new();

    let note0 = w.note(1000, 1001);
    let (p, note_data) = w.shield(&f.env, &note0);
    f.pool
        .shield(&f.user, &1000, &note_data, &p);

    let (p, new_root, _) = w.fold(&f.env, &[note0.commitment(&w.cfg)]);
    let err = f
        .pool
        .try_update_root(&p, &new_root, &2)
        .expect_err("only one commitment is queued");
    assert_eq!(err, Ok(Error::InvalidBatch));
}

#[test]
fn empty_and_oversized_folds_are_rejected() {
    let f = fixture();
    let mut w = Wallet::new();
    let (p, new_root, _) = w.fold(&f.env, &[ark_bls12_381::Fr::from(1u64)]);

    assert_eq!(
        f.pool
            .try_update_root(&p, &new_root, &0)
            .expect_err("a zero-count fold is meaningless"),
        Ok(Error::InvalidBatch)
    );
    assert_eq!(
        f.pool
            .try_update_root(&p, &new_root, &(BATCH + 1))
            .expect_err("a batch larger than BATCH cannot be proved"),
        Ok(Error::InvalidBatch)
    );
}

/// A fold claiming a root the circuit did not prove must not advance the tree.
#[test]
fn fold_with_a_forged_root_is_rejected() {
    let f = fixture();
    let mut w = Wallet::new();

    let note0 = w.note(1000, 1001);
    let (p, note_data) = w.shield(&f.env, &note0);
    f.pool
        .shield(&f.user, &1000, &note_data, &p);

    let (p, _real_root, count) = w.fold(&f.env, &[note0.commitment(&w.cfg)]);
    let forged = BytesN::from_array(&f.env, &[0x11; 32]);
    let err = f
        .pool
        .try_update_root(&p, &forged, &count)
        .expect_err("a forged root must not verify");
    assert_eq!(err, Ok(Error::InvalidProof));
    assert_eq!(f.pool.next_index(), 0, "the tree did not move");
}

/// Shielding while committing to more than was deposited is the attack the shield circuit exists to
/// stop: without it the pool could be drained by depositing 1000 and committing to a million.
#[test]
fn shield_commitment_must_bind_the_transferred_amount() {
    let f = fixture();
    let w = Wallet::new();

    let inflated = w.note(1_000_000, 1001);
    let (p, inflated_data) = w.shield(&f.env, &inflated);
    let err = f
        .pool
        .try_shield(&f.user, &1000, &inflated_data, &p)
        .expect_err("the commitment must bind the amount actually deposited");
    assert_eq!(err, Ok(Error::InvalidProof));
    assert_eq!(f.token.balance(&f.user), START_BALANCE, "no tokens moved");
    assert_eq!(f.pool.queue_depth(), 0, "nothing was queued");
}

#[test]
fn shield_rejects_non_positive_and_oversized_amounts() {
    let f = fixture();
    let w = Wallet::new();
    let note0 = w.note(1000, 1001);
    let (p, note_data) = w.shield(&f.env, &note0);

    for bad in [0i128, -1i128, (u64::MAX as i128) + 1] {
        let err = f
            .pool
            .try_shield(&f.user, &bad, &note_data, &p)
            .expect_err("amount must be a positive u64");
        assert_eq!(err, Ok(Error::InvalidAmount));
    }
}

/// The theft the `destination` public input was added to prevent: lift a valid unshield proof out of
/// the mempool and resubmit it naming your own address.
#[test]
fn unshield_to_a_substituted_destination_is_rejected() {
    let f = fixture();
    let mut w = Wallet::new();
    let note0 = funded(&f, &mut w, 1000);

    let payout = Address::generate(&f.env);
    let dest = w.destination(&f.pool.destination_field(&payout));
    let (p, pi) = w.spend(
        &f.env,
        0,
        &note0,
        w.note(0, 3001),
        w.note(400, 3002),
        600,
        dest,
    );

    let attacker = Address::generate(&f.env);
    let err = f
        .pool
        .try_unshield(
            &p,
            &pi[0],
            &pi[1],
            &outputs(&pi),
            &600,
            &attacker,
            &NOW,
        )
        .expect_err("redirecting an unshield must fail");
    assert_eq!(err, Ok(Error::InvalidProof));
    assert_eq!(f.token.balance(&attacker), 0, "nothing was stolen");

    // The legitimate destination still works, so the rejection was specific, not incidental.
    f.pool.unshield(
        &p,
        &pi[0],
        &pi[1],
        &outputs(&pi),
        &600,
        &payout,
        &NOW,
    );
    assert_eq!(f.token.balance(&payout), 600);
}

/// The amount released must be the amount proved, or the pool can be over-drawn.
#[test]
fn unshield_with_a_substituted_amount_is_rejected() {
    let f = fixture();
    let mut w = Wallet::new();
    let note0 = funded(&f, &mut w, 1000);

    let payout = Address::generate(&f.env);
    let dest = w.destination(&f.pool.destination_field(&payout));
    let (p, pi) = w.spend(
        &f.env,
        0,
        &note0,
        w.note(0, 3001),
        w.note(400, 3002),
        600,
        dest,
    );

    let err = f
        .pool
        .try_unshield(
            &p,
            &pi[0],
            &pi[1],
            &outputs(&pi),
            &900, // proved 600
            &payout,
            &NOW,
        )
        .expect_err("claiming more than was proved must fail");
    assert_eq!(err, Ok(Error::InvalidProof));
    assert_eq!(f.token.balance(&payout), 0);
}

/// A transact proof cannot be re-aimed at `unshield` to pull tokens out: the private path proves
/// `publicAmount = 0`, and `unshield` checks a non-zero amount against the same public input.
#[test]
fn a_private_transfer_proof_cannot_be_used_to_withdraw() {
    let f = fixture();
    let mut w = Wallet::new();
    let note0 = funded(&f, &mut w, 1000);

    let (p, pi) = w.spend(
        &f.env,
        0,
        &note0,
        w.note(600, 2001),
        w.note(400, 2002),
        0,
        zero_fr(),
    );
    let attacker = Address::generate(&f.env);
    let err = f
        .pool
        .try_unshield(
            &p,
            &pi[0],
            &pi[1],
            &outputs(&pi),
            &1000,
            &attacker,
            &NOW,
        )
        .expect_err("a private-transfer proof must not authorise a withdrawal");
    assert_eq!(err, Ok(Error::InvalidProof));
    assert_eq!(f.token.balance(&attacker), 0);
}

// ---- housekeeping ----

#[test]
fn initialize_is_one_shot() {
    let f = fixture();
    let z = BytesN::from_array(&f.env, &[0u8; 32]);
    let err = f
        .pool
        .try_initialize(&f.admin, &f.pool.address, &z, &z)
        .expect_err("re-initialising would let the token or anchor be swapped");
    assert_eq!(err, Ok(Error::AlreadyInitialized));
}

#[test]
fn empty_tree_root_is_seeded_into_history() {
    let f = fixture();
    let empty = BytesN::from_array(&f.env, EMPTY_ROOT);
    assert_eq!(f.pool.root(), Some(empty.clone()));
    assert!(
        f.pool.is_known_root(&empty),
        "the first fold proves against the empty root, so it must be accepted"
    );
    assert!(
        !f.pool.is_known_root(&BytesN::from_array(&f.env, &[0u8; 32])),
        "the all-zero root must never be accepted"
    );
}

/// Every on-chain path must fit Soroban's 100M CPU budget — the constraint that shaped the design.
#[test]
fn all_operations_fit_the_cpu_budget() {
    let f = fixture();
    let mut w = Wallet::new();

    let note0 = w.note(1000, 1001);
    let (p, note_data) = w.shield(&f.env, &note0);
    f.env.cost_estimate().budget().reset_default();
    f.pool
        .shield(&f.user, &1000, &note_data, &p);
    let shield_cpu = f.env.cost_estimate().budget().cpu_instruction_cost();

    let (p, new_root, count) = w.fold(&f.env, &[note0.commitment(&w.cfg)]);
    f.env.cost_estimate().budget().reset_default();
    f.pool.update_root(&p, &new_root, &count);
    let fold_cpu = f.env.cost_estimate().budget().cpu_instruction_cost();

    let (p, pi) = w.spend(
        &f.env,
        0,
        &note0,
        w.note(600, 2001),
        w.note(400, 2002),
        0,
        zero_fr(),
    );
    f.env.cost_estimate().budget().reset_default();
    f.pool.transact(
        &p,
        &pi[0],
        &pi[1],
        &outputs(&pi),
        &NOW,
    );
    let transact_cpu = f.env.cost_estimate().budget().cpu_instruction_cost();

    std::println!(
        "PROVA_V3_ONCHAIN shield_cpu={shield_cpu} fold_cpu={fold_cpu} \
         transact_cpu={transact_cpu} budget=100000000 ceiling={SAFETY_CEILING}"
    );
    for (name, cpu) in [
        ("shield", shield_cpu),
        ("fold", fold_cpu),
        ("transact", transact_cpu),
    ] {
        assert!(
            cpu < SAFETY_CEILING,
            "{name} used {cpu}, over the {SAFETY_CEILING} safety ceiling ({}% of the 100M budget). \
             There is no runtime escape hatch — see SAFETY_CEILING.",
            cpu * 100 / 100_000_000
        );
    }
}

/// A tripwire well below Soroban's real 100M limit, so cost growth is caught in CI rather than by a
/// failing transaction on-chain.
///
/// It sits this far back because **the pool has no way to shed cost at runtime**. `fold_cost_by_batch_size`
/// shows a fold costs the same whether it carries 1 commitment or 8 (59.72M vs 59.85M — 93% of it is
/// the fixed proof check). So the obvious recovery, "fold fewer at a time", does nothing. If an
/// entrypoint ever exceeded the real budget, the only fix would be a new circuit, a new trusted setup
/// and a redeployed contract. Twenty-five points of margin is what buys the time to do that calmly.
const SAFETY_CEILING: u64 = 75_000_000;

/// How does a fold's cost actually scale with batch size?
///
/// This decides `BATCH`. If most of the cost is the fixed pairing check, shrinking the batch buys
/// very little safety margin while halving throughput — and, just as importantly, it shows the
/// **degradation path**: `count` is chosen per call, so if a fold ever became too expensive the
/// folder can drop to a smaller batch instead of the pool stalling. That is what makes the parameter
/// safe rather than load-bearing.
#[test]
fn fold_cost_by_batch_size() {
    std::println!("PROVA_BATCH_SCALING count,cpu,pct_of_budget");
    let mut costs = std::vec::Vec::new();
    for n in 1..=BATCH {
        let f = fixture();
        let mut w = Wallet::new();

        let mut leaves = std::vec::Vec::new();
        for i in 0..n {
            let note = w.note(100 + i as u64, 4000 + i as u64);
            let (p, note_data) = w.shield(&f.env, &note);
            f.pool.shield(&f.user, &(note.amount as i128), &note_data, &p);
            leaves.push(note.commitment(&w.cfg));
        }

        let (p, new_root, count) = w.fold(&f.env, &leaves);
        f.env.cost_estimate().budget().reset_default();
        f.pool.update_root(&p, &new_root, &count);
        let cpu = f.env.cost_estimate().budget().cpu_instruction_cost();
        std::println!("PROVA_BATCH_SCALING {n},{cpu},{}", cpu * 100 / 100_000_000);
        costs.push(cpu);
    }

    let fixed = costs[0] - (costs[BATCH as usize - 1] - costs[0]) / (BATCH as u64 - 1);
    let marginal = (costs[BATCH as usize - 1] - costs[0]) / (BATCH as u64 - 1);
    std::println!(
        "PROVA_BATCH_SCALING fixed~{fixed} marginal_per_leaf~{marginal} \
         (shrinking the batch only saves the marginal part)"
    );
}

// =====================================================================================
// Admin controls.
//
// These exist because a deployed Soroban contract is immutable: without a recovery path, a bug
// found after launch would freeze every custodied token forever. The trade is a trusted key, so
// what matters is that its powers are bounded — above all that a pause can never trap anyone's
// money.
// =====================================================================================

#[test]
fn admin_is_recorded_and_pool_starts_unpaused() {
    let f = fixture();
    assert_eq!(f.pool.admin(), Some(f.admin.clone()));
    assert!(!f.pool.is_paused(), "a fresh pool must be open for business");
}

/// Every admin power must actually demand the admin's signature. Without `mock_all_auths`, an
/// unauthorised call has no auth entry and the host rejects it.
#[test]
fn admin_powers_require_authorisation() {
    let env = Env::default();
    let token_admin = Address::generate(&env);
    let admin = Address::generate(&env);

    env.mock_all_auths();
    let token_id = env.register_stellar_asset_contract_v2(token_admin).address();
    let w = Wallet::new();
    let pool = PoolClient::new(&env, &env.register(Pool, ()));
    pool.initialize(
        &admin,
        &token_id,
        &harness::fr_bytes(&env, &w.anchor.pk.x),
        &harness::fr_bytes(&env, &w.anchor.pk.y),
    );

    // Stop auto-approving; from here every `require_auth` must be satisfied for real.
    env.set_auths(&[]);
    let stranger = Address::generate(&env);
    let z = BytesN::from_array(&env, &[0u8; 32]);

    assert!(
        pool.try_set_paused(&true).is_err(),
        "anyone must not be able to halt the pool"
    );
    assert!(
        pool.try_set_anchor(&z, &z).is_err(),
        "anyone must not be able to swap the KYC signing key"
    );
    assert!(
        pool.try_set_admin(&stranger).is_err(),
        "anyone must not be able to seize the admin role"
    );
    assert!(
        pool.try_upgrade(&z).is_err(),
        "anyone must not be able to replace the contract code"
    );

    assert!(!pool.is_paused(), "no unauthorised call took effect");
    assert_eq!(pool.admin(), Some(admin));
}

/// A pause halts new value entering the pool.
#[test]
fn pause_halts_deposits_and_private_transfers() {
    let f = fixture();
    let mut w = Wallet::new();
    let note0 = funded(&f, &mut w, 1000);

    f.pool.set_paused(&true);
    assert!(f.pool.is_paused());

    // Deposits stop.
    let another = w.note(500, 7001);
    let (sp, another_data) = w.shield(&f.env, &another);
    assert_eq!(
        f.pool
            .try_shield(&f.user, &500, &another_data, &sp)
            .expect_err("deposits must halt while paused"),
        Ok(Error::Paused)
    );

    // Private transfers stop.
    let (p, pi) = w.spend(
        &f.env,
        0,
        &note0,
        w.note(600, 2001),
        w.note(400, 2002),
        0,
        zero_fr(),
    );
    assert_eq!(
        f.pool
            .try_transact(&p, &pi[0], &pi[1], &outputs(&pi), &NOW)
            .expect_err("private transfers must halt while paused"),
        Ok(Error::Paused)
    );

    // ...and resuming restores normal service.
    f.pool.set_paused(&false);
    assert!(!f.pool.is_paused());
    f.pool
        .transact(&p, &pi[0], &pi[1], &outputs(&pi), &NOW);
    assert!(f.pool.is_spent(&pi[1]));
}

/// **The property that makes the pause safe to have at all.**
///
/// A stop button that could strand people's money would be worse than no stop button. Withdrawals
/// must keep working while paused, and so must folding — because a note has to be in the tree before
/// it can be withdrawn, so pausing that would strand exactly the users trying to leave.
#[test]
fn withdrawals_and_folding_still_work_while_paused() {
    let f = fixture();
    let mut w = Wallet::new();
    let note0 = funded(&f, &mut w, 1000);
    let pool_addr = f.pool.address.clone();

    // A transfer lands, leaving two notes queued but not yet folded...
    let out1 = w.note(600, 2001);
    let out2 = w.note(400, 2002);
    let (p, pi) = w.spend(&f.env, 0, &note0, out1, out2, 0, zero_fr());
    f.pool
        .transact(&p, &pi[0], &pi[1], &outputs(&pi), &NOW);
    assert_eq!(f.pool.queue_depth(), 2);

    // ...and *then* the emergency pause hits.
    f.pool.set_paused(&true);

    // Folding continues, so the stranded notes become spendable.
    let (fp, new_root, count) =
        w.fold(&f.env, &[out1.commitment(&w.cfg), out2.commitment(&w.cfg)]);
    f.pool.update_root(&fp, &new_root, &count);
    assert_eq!(f.pool.next_index(), 3, "folding must not be blocked by a pause");

    // And the user can get their money out.
    let payout = Address::generate(&f.env);
    let dest = w.destination(&f.pool.destination_field(&payout));
    let (p, pi) = w.spend(&f.env, 1, &out1, w.note(0, 3001), w.note(0, 3002), 600, dest);
    f.pool.unshield(
        &p,
        &pi[0],
        &pi[1],
        &outputs(&pi),
        &600,
        &payout,
        &NOW,
    );

    assert_eq!(
        f.token.balance(&payout),
        600,
        "a paused pool must never hold a user's money hostage"
    );
    assert_eq!(f.token.balance(&pool_addr), 400);
    assert!(f.pool.is_paused(), "still paused throughout");
}

/// Rotating the anchor key invalidates credentials signed by the old one — which is the whole point
/// if that key has leaked — and credentials from the new key work immediately.
#[test]
fn rotating_the_anchor_key_invalidates_old_credentials() {
    let f = fixture();
    let mut w = Wallet::new();
    let note0 = funded(&f, &mut w, 1000);

    // A spend proved against the *original* anchor.
    let (p, pi) = w.spend(
        &f.env,
        0,
        &note0,
        w.note(600, 2001),
        w.note(400, 2002),
        0,
        zero_fr(),
    );

    // The anchor's signing key is compromised, so it is rotated. Same owner, new anchor.
    let mut rotated = Wallet::with_anchor_seed(4242);
    rotated.tree = w.tree.clone();
    f.pool.set_anchor(
        &harness::fr_bytes(&f.env, &rotated.anchor.pk.x),
        &harness::fr_bytes(&f.env, &rotated.anchor.pk.y),
    );

    // The old credential is now worthless.
    assert_eq!(
        f.pool
            .try_transact(&p, &pi[0], &pi[1], &outputs(&pi), &NOW)
            .expect_err("a credential from the compromised key must stop working"),
        Ok(Error::InvalidProof)
    );

    // A credential from the new anchor works straight away — the same note, re-proved.
    let (p2, pi2) = rotated.spend(
        &f.env,
        0,
        &note0,
        rotated.note(600, 2001),
        rotated.note(400, 2002),
        0,
        zero_fr(),
    );
    f.pool.transact(
        &p2,
        &pi2[0],
        &pi2[1],
        &outputs(&pi2),
        &NOW,
    );
    assert!(f.pool.is_spent(&pi2[1]), "the rotated key is live");
}

/// The migration path to a multisig: hand the role over, and the old holder loses it.
#[test]
fn admin_role_can_be_handed_over() {
    let f = fixture();
    let successor = Address::generate(&f.env);

    f.pool.set_admin(&successor);
    assert_eq!(f.pool.admin(), Some(successor.clone()));

    // The new holder governs. (With auths mocked, this asserts the recorded role, not the signature
    // check — `admin_powers_require_authorisation` covers enforcement.)
    f.pool.set_paused(&true);
    assert!(f.pool.is_paused());
}

/// **The end-to-end proof that Risk B is closed.**
///
/// A recipient's discovery message is what tells their wallet "this leaf is yours". It used to ride
/// alongside the proof as opaque bytes, so whoever submitted the transaction could scramble it: the
/// money stayed on-chain and stayed theirs, but their wallet could never find it — indistinguishable
/// from losing it.
///
/// The payload is now computed by the spend circuit and carried as public inputs, so corrupting any
/// part of it invalidates the proof and the transaction is rejected outright. Every element is
/// checked separately, because covering only some of them would leave the same hole.
#[test]
fn corrupting_a_recipients_encrypted_note_is_rejected() {
    let f = fixture();
    let mut w = Wallet::new();
    let note0 = funded(&f, &mut w, 1000);

    let (p, pi) = w.spend(
        &f.env,
        0,
        &note0,
        w.note(600, 2001),
        w.note(400, 2002),
        0,
        zero_fr(),
    );

    let scramble = |b: &BytesN<32>| {
        let mut a = b.to_array();
        a[31] ^= 1;
        BytesN::from_array(&f.env, &a)
    };

    for (field, mutate) in [
        ("ephemeral key x", 0usize),
        ("ephemeral key y", 1),
        ("note 1 amount", 2),
        ("note 1 rho", 3),
        ("note 2 amount", 4),
        ("note 2 rho", 5),
    ] {
        let mut out = outputs(&pi);
        match mutate {
            0 => out.epk_x = scramble(&out.epk_x),
            1 => out.epk_y = scramble(&out.epk_y),
            2 => out.enc1_amount = scramble(&out.enc1_amount),
            3 => out.enc1_rho = scramble(&out.enc1_rho),
            4 => out.enc2_amount = scramble(&out.enc2_amount),
            _ => out.enc2_rho = scramble(&out.enc2_rho),
        }
        assert_eq!(
            f.pool
                .try_transact(&p, &pi[0], &pi[1], &out, &NOW)
                .expect_err("corrupting the {field} must be rejected"),
            Ok(Error::InvalidProof),
            "a relayer corrupting the {field} must fail, not silently strand the recipient's money"
        );
        assert!(
            !f.pool.is_spent(&pi[1]),
            "a rejected transaction must not consume the note"
        );
    }

    // The untouched payload still works, so the rejection is specific rather than incidental.
    f.pool
        .transact(&p, &pi[0], &pi[1], &outputs(&pi), &NOW);
    assert!(f.pool.is_spent(&pi[1]));
}

/// Every state change a wallet depends on must be observable from events alone.
///
/// The indexer rebuilds the tree, the note feed and the spent set purely by replaying events — it
/// has no privileged view. A missing event is therefore not a logging gap: a spend that emitted no
/// nullifier would leave a restored wallet showing already-spent notes as spendable balance, and a
/// note with no event would be money nobody could ever find.
#[test]
fn every_state_change_is_observable_from_events() {
    use soroban_sdk::{Symbol, TryFromVal};

    let f = fixture();
    let mut w = Wallet::new();

    // `env.events().all()` reports the most recent invocation only, so each operation is inspected
    // immediately after it runs.
    let count_topic = |name: &str| -> usize {
        let wanted = Symbol::new(&f.env, name);
        f.env
            .events()
            .all()
            .iter()
            .filter(|e| {
                e.1.get(0)
                    .and_then(|v| Symbol::try_from_val(&f.env, &v).ok())
                    .map(|s| s == wanted)
                    .unwrap_or(false)
            })
            .count()
    };

    let note0 = w.note(1000, 1001);
    let (p, note_data) = w.shield(&f.env, &note0);
    f.pool.shield(&f.user, &1000, &note_data, &p);
    assert_eq!(
        count_topic("note"),
        1,
        "shield must announce the note it queued, or the deposit is undiscoverable"
    );

    let (fp, new_root, count) = w.fold(&f.env, &[note0.commitment(&w.cfg)]);
    f.pool.update_root(&fp, &new_root, &count);
    assert_eq!(
        count_topic("root"),
        1,
        "a fold must announce the new root, or wallets cannot tell when a note became spendable"
    );

    let (sp, pi) = w.spend(
        &f.env,
        0,
        &note0,
        w.note(600, 2001),
        w.note(400, 2002),
        0,
        zero_fr(),
    );
    f.pool.transact(&sp, &pi[0], &pi[1], &outputs(&pi), &NOW);
    assert_eq!(
        count_topic("spend"),
        1,
        "a spend must publish its nullifier, or a restored wallet shows spent notes as balance"
    );
    assert_eq!(
        count_topic("note"),
        2,
        "a transfer creates exactly two notes and both must be announced"
    );
    assert!(f.pool.is_spent(&pi[1]));
}
