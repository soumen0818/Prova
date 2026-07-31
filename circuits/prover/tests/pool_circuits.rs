//! Pool v3 circuit tests.
//!
//! The must-fail cases are the point. A suite that only proves the happy path says nothing about a
//! value-bearing circuit: every assertion below corresponds to a way money could be stolen, minted or
//! lost, and each is listed in `Docs/shielded-pool.md` §10.3.

use ark_bls12_381::{Bls12_381, Fr};
use ark_ff::Field;
use ark_groth16::Groth16;
use ark_r1cs_std::{alloc::AllocVar, fields::fp::FpVar};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem};
use ark_snark::SNARK;
use ark_std::rand::{rngs::StdRng, SeedableRng};

use prova_prover::credential;
use ark_ed_on_bls12_381::Fr as JubjubFr;
use prova_prover::pool::{
    encryption::{self, EncKey},
    fold::FoldCircuit,
    gadgets,
    owner_pk,
    shield::ShieldCircuit,
    spend::{SpendCircuit, SpendOutput},
    tree::{root_from_path, MerkleTree},
    Note, AMOUNT_BITS, BATCH, DEPTH,
};
use prova_prover::poseidon_config;

const NOW: u64 = 1_700_000_000;
const LATER: u64 = 2_000_000_000;

fn satisfied<C: ConstraintSynthesizer<Fr>>(circuit: C) -> bool {
    let cs = ConstraintSystem::<Fr>::new_ref();
    circuit.generate_constraints(cs.clone()).unwrap();
    cs.is_satisfied().unwrap()
}

/// A funded wallet: one note of `amount` sitting in the tree, with a valid KYC credential.
struct Scenario {
    cfg: ark_crypto_primitives::sponge::poseidon::PoseidonConfig<Fr>,
    anchor: credential::AnchorKey,
    cred: credential::Credential,
    owner_sk: Fr,
    owner_pk: Fr,
    rho: Fr,
    amount: u64,
    tree: MerkleTree,
    /// The recipient's note-encryption key. Same wallet here, which is also the case that most
    /// stresses the encryption (both outputs to one person share an ephemeral key).
    enc: EncKey,
}

impl Scenario {
    fn new(seed: u64, amount: u64) -> Self {
        let cfg = poseidon_config::<Fr>();
        let mut rng = StdRng::seed_from_u64(seed);
        let anchor = credential::AnchorKey::generate(&mut rng);
        let owner_sk = Fr::from(1234567u64 + seed);
        let pk = owner_pk(&cfg, owner_sk);
        let rho = Fr::from(999u64 + seed);

        // Surround the spendable note with others, so membership is proved against a real tree
        // rather than a single-leaf degenerate case.
        let mut tree = MerkleTree::new(&cfg);
        tree.insert(Fr::from(4242u64));
        tree.insert(Note::new(amount, pk, rho).commitment(&cfg));
        tree.insert(Fr::from(7777u64));

        let uid = credential::user_id(&cfg, owner_sk);
        let cred = credential::issue(&cfg, &anchor, uid, 2, LATER, &mut rng);
        let enc = EncKey::generate(&mut rng);

        Self {
            cfg,
            anchor,
            cred,
            owner_sk,
            owner_pk: pk,
            rho,
            amount,
            tree,
            enc,
        }
    }

    /// The spendable note's index (it is inserted second).
    fn leaf_index(&self) -> u64 {
        1
    }

    /// A valid spend splitting the note into `out1 + out2 + public_amount`.
    fn spend(&self, out1: u64, out2: u64, public_amount: u64, destination: Fr) -> SpendCircuit {
        let path = self.tree.path(self.leaf_index());
        SpendCircuit::new(
            self.cfg.clone(),
            self.amount,
            self.rho,
            self.owner_sk,
            &path,
            SpendOutput::new(Note::new(out1, self.owner_pk, Fr::from(101u64)), self.enc.pk),
            SpendOutput::new(Note::new(out2, self.owner_pk, Fr::from(202u64)), self.enc.pk),
            JubjubFr::from(0xE55u64),
            public_amount,
            destination,
            &self.cred,
            self.anchor.pk,
            NOW,
        )
    }
}

// =====================================================================================
// Spend circuit — happy paths
// =====================================================================================

#[test]
fn private_transfer_satisfies() {
    let s = Scenario::new(1, 1000);
    assert!(
        satisfied(s.spend(700, 300, 0, Fr::from(0u64))),
        "a valid private transfer must satisfy"
    );
}

#[test]
fn unshield_satisfies() {
    let s = Scenario::new(2, 1000);
    // 400 leaves the pool to a destination, 600 stays as change.
    assert!(
        satisfied(s.spend(0, 600, 400, Fr::from(0xABCDEFu64))),
        "a valid unshield must satisfy"
    );
}

#[test]
fn public_inputs_are_in_the_frozen_order() {
    let s = Scenario::new(3, 500);
    let c = s.spend(200, 300, 0, Fr::from(0u64));
    let pi = c.public_inputs().unwrap();
    assert_eq!(pi.len(), 15, "POOL_PUBLIC_INPUT_COUNT is 15");
    assert_eq!(pi[0], s.tree.root(), "[0] merkleRoot");
    assert_eq!(pi[4], Fr::from(0u64), "[4] publicAmount");
    assert_eq!(pi[5], Fr::from(0u64), "[5] destination");
    assert_eq!(pi[6], s.anchor.pk.x, "[6] anchorPkX");
    assert_eq!(pi[7], s.anchor.pk.y, "[7] anchorPkY");
    assert_eq!(pi[8], Fr::from(NOW), "[8] currentTime");
    // The encrypted notes — inputs, not attachments, which is what makes them tamper-proof.
    assert_eq!(pi[9], c.epk.unwrap().x, "[9] epkX");
    assert_eq!(pi[10], c.epk.unwrap().y, "[10] epkY");
    assert_eq!(pi[11], c.enc1.unwrap().c_amount, "[11] enc1Amount");
    assert_eq!(pi[12], c.enc1.unwrap().c_rho, "[12] enc1Rho");
    assert_eq!(pi[13], c.enc2.unwrap().c_amount, "[13] enc2Amount");
    assert_eq!(pi[14], c.enc2.unwrap().c_rho, "[14] enc2Rho");
}

// =====================================================================================
// Note encryption — the recipient can find their money, and nobody can stop them.
// =====================================================================================

/// End to end: the circuit encrypts, and the recipient's own key opens the result and reconstructs a
/// spendable note. If this ever broke, money would arrive and be invisible to its owner.
#[test]
fn recipient_can_open_the_notes_the_circuit_produced() {
    let s = Scenario::new(40, 1000);
    let c = s.spend(600, 400, 0, Fr::from(0u64));

    let found1 = encryption::try_open(
        &s.cfg,
        s.enc.sk,
        s.owner_pk,
        c.out_c1.unwrap(),
        &c.enc1.unwrap(),
        0,
    )
    .expect("recipient must find output 1");
    assert_eq!(found1.amount, 600);

    let found2 = encryption::try_open(
        &s.cfg,
        s.enc.sk,
        s.owner_pk,
        c.out_c2.unwrap(),
        &c.enc2.unwrap(),
        1,
    )
    .expect("recipient must find output 2");
    assert_eq!(found2.amount, 400);

    // ...and the recovered note really is the one on-chain, so it can actually be spent.
    assert_eq!(found1.commitment(&s.cfg), c.out_c1.unwrap());
    assert_eq!(found2.commitment(&s.cfg), c.out_c2.unwrap());
}

#[test]
fn a_stranger_cannot_open_the_notes() {
    let s = Scenario::new(41, 1000);
    let c = s.spend(600, 400, 0, Fr::from(0u64));
    let stranger = EncKey::generate(&mut StdRng::seed_from_u64(1234));
    assert!(
        encryption::try_open(
            &s.cfg,
            stranger.sk,
            s.owner_pk,
            c.out_c1.unwrap(),
            &c.enc1.unwrap(),
            0
        )
        .is_none(),
        "scanning must reveal nothing to anyone but the owner"
    );
}

/// **The whole point of moving encryption in-circuit.**
///
/// A relayer that corrupts a recipient's discovery message must invalidate the proof, not silently
/// strand their money. Each element of the encrypted payload is checked separately, because a fix
/// that covered only some of them would leave the same hole.
#[test]
fn tampering_with_any_encrypted_field_invalidates_the_proof() {
    let mut rng = StdRng::seed_from_u64(77);
    let setup = Scenario::new(42, 1).spend(1, 0, 0, Fr::from(0u64));
    let (pk, vk) = Groth16::<Bls12_381>::circuit_specific_setup(setup, &mut rng).unwrap();

    let s = Scenario::new(43, 1000);
    let circuit = s.spend(600, 400, 0, Fr::from(0u64));
    let public = circuit.public_inputs().unwrap();
    let proof = Groth16::<Bls12_381>::prove(&pk, circuit, &mut rng).unwrap();
    assert!(Groth16::<Bls12_381>::verify(&vk, &public, &proof).unwrap());

    for (index, field) in [
        (9, "ephemeral key x"),
        (10, "ephemeral key y"),
        (11, "output 1 amount ciphertext"),
        (12, "output 1 rho ciphertext"),
        (13, "output 2 amount ciphertext"),
        (14, "output 2 rho ciphertext"),
    ] {
        let mut tampered = public.clone();
        tampered[index] += Fr::from(1u64);
        assert!(
            !Groth16::<Bls12_381>::verify(&vk, &tampered, &proof).unwrap(),
            "corrupting the {field} must invalidate the proof — otherwise a relayer could make the \
             recipient's money permanently unfindable"
        );
    }
}

/// The in-circuit membership gadget and the native tree must agree. If they ever diverge, notes
/// silently become unspendable — nothing would fail loudly at runtime.
#[test]
fn merkle_gadget_matches_the_native_tree() {
    let cfg = poseidon_config::<Fr>();
    let mut tree = MerkleTree::new(&cfg);
    for i in 0..6u64 {
        tree.insert(Fr::from(500 + i));
    }
    for leaf_index in 0..6u64 {
        let path = tree.path(leaf_index);
        let native = root_from_path(&cfg, Fr::from(500 + leaf_index), &path);
        assert_eq!(native, tree.root());

        let cs = ConstraintSystem::<Fr>::new_ref();
        let leaf = FpVar::new_witness(cs.clone(), || Ok(Fr::from(500 + leaf_index))).unwrap();
        let idx = FpVar::new_witness(cs.clone(), || Ok(Fr::from(leaf_index))).unwrap();
        let bits = gadgets::to_index_bits(&idx, DEPTH).unwrap();
        let sibs: Vec<FpVar<Fr>> = path
            .siblings
            .iter()
            .map(|s| FpVar::new_witness(cs.clone(), || Ok(*s)).unwrap())
            .collect();
        let got = gadgets::merkle_root_from_path(cs.clone(), &cfg, &leaf, &sibs, &bits).unwrap();
        assert_eq!(
            ark_r1cs_std::R1CSVar::value(&got).unwrap(),
            tree.root(),
            "gadget must reproduce the native root for leaf {leaf_index}"
        );
    }
}

/// Spending the same note twice produces the same nullifier — which is exactly what lets the
/// contract reject the replay. Unlinkability is preserved: the nullifier reveals no note identity.
#[test]
fn nullifier_is_deterministic_per_note() {
    let s = Scenario::new(4, 800);
    let a = s.spend(500, 300, 0, Fr::from(0u64));
    let b = s.spend(100, 700, 0, Fr::from(0u64));
    assert_eq!(
        a.nullifier.unwrap(),
        b.nullifier.unwrap(),
        "the same note must always nullify to the same value, or double-spending is undetectable"
    );
}

// =====================================================================================
// Spend circuit — must-fail. Each is a way money could be stolen or minted.
// =====================================================================================

#[test]
fn value_inflation_fails() {
    let s = Scenario::new(10, 1000);
    // 700 + 400 > 1000 — printing 100 out of nothing.
    assert!(
        !satisfied(s.spend(700, 400, 0, Fr::from(0u64))),
        "outputs exceeding the input must fail"
    );
}

#[test]
fn value_destruction_also_fails() {
    let s = Scenario::new(11, 1000);
    // Conservation is an equality, not an inequality — under-spending is rejected too, so value can
    // never be silently burned into an unaccounted balance.
    assert!(
        !satisfied(s.spend(400, 400, 0, Fr::from(0u64))),
        "outputs summing to less than the input must fail"
    );
}

#[test]
fn unshield_amount_must_be_covered_by_the_input() {
    let s = Scenario::new(12, 1000);
    assert!(
        !satisfied(s.spend(600, 600, 500, Fr::from(1u64))),
        "publicAmount must be part of conservation, not extra"
    );
}

#[test]
fn wrong_root_fails() {
    let s = Scenario::new(13, 1000);
    let mut c = s.spend(600, 400, 0, Fr::from(0u64));
    c.merkle_root = Some(Fr::from(0xDEADBEEFu64));
    assert!(!satisfied(c), "a proof against an unknown root must fail");
}

#[test]
fn forged_note_not_in_the_tree_fails() {
    let s = Scenario::new(14, 1000);
    let path = s.tree.path(s.leaf_index());
    // A note the owner never had — same secrets, invented amount, so its commitment is not a leaf.
    let c = SpendCircuit::new(
        s.cfg.clone(),
        999_999,
        s.rho,
        s.owner_sk,
        &path,
        SpendOutput::new(Note::new(999_999, s.owner_pk, Fr::from(1u64)), s.enc.pk),
        SpendOutput::new(Note::new(0, s.owner_pk, Fr::from(2u64)), s.enc.pk),
        JubjubFr::from(0xE55u64),
        0,
        Fr::from(0u64),
        &s.cred,
        s.anchor.pk,
        NOW,
    );
    assert!(!satisfied(c), "a note absent from the tree must fail");
}

#[test]
fn wrong_leaf_index_fails() {
    let s = Scenario::new(15, 1000);
    let mut c = s.spend(600, 400, 0, Fr::from(0u64));
    c.leaf_index = Some(0); // path belongs to index 1
    assert!(!satisfied(c), "a path used at the wrong index must fail");
}

#[test]
fn tampered_output_commitment_fails() {
    let s = Scenario::new(16, 1000);
    let mut c = s.spend(600, 400, 0, Fr::from(0u64));
    c.out_c1 = Some(Fr::from(1234u64));
    assert!(
        !satisfied(c),
        "a published commitment that does not match its note must fail"
    );
}

#[test]
fn tampered_nullifier_fails() {
    let s = Scenario::new(17, 1000);
    let mut c = s.spend(600, 400, 0, Fr::from(0u64));
    c.nullifier = Some(Fr::from(4321u64));
    assert!(
        !satisfied(c),
        "publishing a nullifier other than the note's own would allow double-spending"
    );
}

#[test]
fn spending_someone_elses_note_fails() {
    let s = Scenario::new(18, 1000);
    let path = s.tree.path(s.leaf_index());
    // Right note, wrong secret: ownership derives ownerPk from ownerSk, so the commitment no longer
    // matches the leaf.
    let c = SpendCircuit::new(
        s.cfg.clone(),
        s.amount,
        s.rho,
        Fr::from(4242u64),
        &path,
        SpendOutput::new(Note::new(600, s.owner_pk, Fr::from(1u64)), s.enc.pk),
        SpendOutput::new(Note::new(400, s.owner_pk, Fr::from(2u64)), s.enc.pk),
        JubjubFr::from(0xE55u64),
        0,
        Fr::from(0u64),
        &s.cred,
        s.anchor.pk,
        NOW,
    );
    assert!(!satisfied(c), "a note can only be spent by its owner");
}

#[test]
fn private_transfer_with_a_destination_fails() {
    let s = Scenario::new(19, 1000);
    // publicAmount == 0 means nothing leaves the pool, so naming a payout address is incoherent —
    // and allowing it would leave `destination` unconstrained on the private path.
    assert!(
        !satisfied(s.spend(600, 400, 0, Fr::from(0x1234u64))),
        "a private transfer must not carry a destination"
    );
}

#[test]
fn expired_credential_fails() {
    let cfg = poseidon_config::<Fr>();
    let mut rng = StdRng::seed_from_u64(20);
    let anchor = credential::AnchorKey::generate(&mut rng);
    let owner_sk = Fr::from(555u64);
    let pk = owner_pk(&cfg, owner_sk);
    let rho = Fr::from(77u64);
    let mut tree = MerkleTree::new(&cfg);
    tree.insert(Note::new(1000, pk, rho).commitment(&cfg));
    let enc_pk = EncKey::generate(&mut rng).pk;

    let uid = credential::user_id(&cfg, owner_sk);
    let cred = credential::issue(&cfg, &anchor, uid, 2, NOW - 1, &mut rng); // already expired

    let c = SpendCircuit::new(
        cfg.clone(),
        1000,
        rho,
        owner_sk,
        &tree.path(0),
        SpendOutput::new(Note::new(600, pk, Fr::from(1u64)), enc_pk),
        SpendOutput::new(Note::new(400, pk, Fr::from(2u64)), enc_pk),
        JubjubFr::from(0xE55u64),
        0,
        Fr::from(0u64),
        &cred,
        anchor.pk,
        NOW,
    );
    assert!(!satisfied(c), "an expired credential must fail");
}

#[test]
fn forged_anchor_signature_fails() {
    let cfg = poseidon_config::<Fr>();
    let mut rng = StdRng::seed_from_u64(21);
    let real = credential::AnchorKey::generate(&mut rng);
    let attacker = credential::AnchorKey::generate(&mut rng);
    let owner_sk = Fr::from(556u64);
    let pk = owner_pk(&cfg, owner_sk);
    let rho = Fr::from(78u64);
    let mut tree = MerkleTree::new(&cfg);
    tree.insert(Note::new(1000, pk, rho).commitment(&cfg));
    let enc_pk = EncKey::generate(&mut rng).pk;

    let uid = credential::user_id(&cfg, owner_sk);
    let cred = credential::issue(&cfg, &attacker, uid, 2, LATER, &mut rng);

    let c = SpendCircuit::new(
        cfg.clone(),
        1000,
        rho,
        owner_sk,
        &tree.path(0),
        SpendOutput::new(Note::new(600, pk, Fr::from(1u64)), enc_pk),
        SpendOutput::new(Note::new(400, pk, Fr::from(2u64)), enc_pk),
        JubjubFr::from(0xE55u64),
        0,
        Fr::from(0u64),
        &cred,
        real.pk, // checked against the real anchor
        NOW,
    );
    assert!(
        !satisfied(c),
        "a credential signed by anyone but the anchor must fail"
    );
}

#[test]
fn credential_issued_to_another_user_fails() {
    let cfg = poseidon_config::<Fr>();
    let mut rng = StdRng::seed_from_u64(22);
    let anchor = credential::AnchorKey::generate(&mut rng);
    let owner_sk = Fr::from(557u64);
    let pk = owner_pk(&cfg, owner_sk);
    let rho = Fr::from(79u64);
    let mut tree = MerkleTree::new(&cfg);
    tree.insert(Note::new(1000, pk, rho).commitment(&cfg));
    let enc_pk = EncKey::generate(&mut rng).pk;

    // Issued for a different user's id — a borrowed credential must not authorise this spend.
    let other = credential::user_id(&cfg, Fr::from(90909u64));
    let cred = credential::issue(&cfg, &anchor, other, 2, LATER, &mut rng);

    let c = SpendCircuit::new(
        cfg.clone(),
        1000,
        rho,
        owner_sk,
        &tree.path(0),
        SpendOutput::new(Note::new(600, pk, Fr::from(1u64)), enc_pk),
        SpendOutput::new(Note::new(400, pk, Fr::from(2u64)), enc_pk),
        JubjubFr::from(0xE55u64),
        0,
        Fr::from(0u64),
        &cred,
        anchor.pk,
        NOW,
    );
    assert!(!satisfied(c), "a credential bound to another user must fail");
}

/// The range check is what makes value conservation sound: amounts live in a ~255-bit field, so
/// without it outputs could be chosen to sum to the input *modulo the field order*.
#[test]
fn range_check_rejects_values_above_2_to_the_64() {
    let cs = ConstraintSystem::<Fr>::new_ref();
    let too_big = Fr::from(u64::MAX) + Fr::ONE; // exactly 2^64
    let v = FpVar::new_witness(cs.clone(), || Ok(too_big)).unwrap();
    gadgets::enforce_range(&v, AMOUNT_BITS).unwrap();
    assert!(
        !cs.is_satisfied().unwrap(),
        "2^64 must not pass a 64-bit range check"
    );
}

// =====================================================================================
// Spend circuit — full Groth16, including the destination-binding property
// =====================================================================================

/// End-to-end proof, then the substitution attack that motivated adding `destination`.
///
/// A public input that appears in no constraint gets an all-zero IC entry in Groth16 and is
/// therefore **not bound** — the proof would verify against any value. This test is the guarantee
/// that `destination` is genuinely bound, not merely present in the input vector.
#[test]
fn groth16_verifies_and_rejects_a_substituted_destination() {
    let mut rng = StdRng::seed_from_u64(42);
    let setup = Scenario::new(30, 1).spend(1, 0, 0, Fr::from(0u64));
    let (pk, vk) = Groth16::<Bls12_381>::circuit_specific_setup(setup, &mut rng).unwrap();

    let s = Scenario::new(31, 1000);
    let payout = Fr::from(0xC0FFEEu64);
    let circuit = s.spend(0, 400, 600, payout);
    let public = circuit.public_inputs().unwrap();
    let proof = Groth16::<Bls12_381>::prove(&pk, circuit, &mut rng).unwrap();

    assert!(
        Groth16::<Bls12_381>::verify(&vk, &public, &proof).unwrap(),
        "a valid unshield must verify"
    );

    // The attack: same proof, attacker's address swapped in at index 5.
    let mut stolen = public.clone();
    stolen[5] = Fr::from(0xBADBADu64);
    assert!(
        !Groth16::<Bls12_381>::verify(&vk, &stolen, &proof).unwrap(),
        "substituting the destination must invalidate the proof — otherwise any unshield in the \
         mempool can be redirected and the payout stolen"
    );

    // Same for the amount leaving the pool.
    let mut inflated = public.clone();
    inflated[4] = Fr::from(999_999u64);
    assert!(
        !Groth16::<Bls12_381>::verify(&vk, &inflated, &proof).unwrap(),
        "substituting publicAmount must invalidate the proof"
    );
}

// =====================================================================================
// Shield circuit
// =====================================================================================

#[test]
fn valid_shield_satisfies() {
    let cfg = poseidon_config::<Fr>();
    assert!(satisfied(ShieldCircuit::new(cfg, 5_000, Fr::from(11u64), Fr::from(22u64), enc_pk(), JubjubFr::from(3u64))));
}

/// The whole reason the shield circuit exists: a commitment claiming more than was deposited must
/// not verify, or the pool can be drained by shielding 100 and committing to a million.
#[test]
fn shield_commitment_must_match_the_deposited_amount() {
    let cfg = poseidon_config::<Fr>();
    let mut c = ShieldCircuit::new(cfg, 100, Fr::from(11u64), Fr::from(22u64), enc_pk(), JubjubFr::from(3u64));
    c.amount = Some(1_000_000); // contract will pass the *actual* transferred amount
    assert!(
        !satisfied(c),
        "a commitment must bind the amount actually deposited"
    );
}

#[test]
fn shield_commitment_must_match_the_owner() {
    let cfg = poseidon_config::<Fr>();
    let mut c = ShieldCircuit::new(cfg, 100, Fr::from(11u64), Fr::from(22u64), enc_pk(), JubjubFr::from(3u64));
    c.owner_pk = Some(Fr::from(99u64));
    assert!(!satisfied(c), "a commitment must bind its stated owner");
}

#[test]
fn shield_public_inputs_are_in_the_frozen_order() {
    let cfg = poseidon_config::<Fr>();
    let c = ShieldCircuit::new(cfg.clone(), 777, Fr::from(11u64), Fr::from(22u64), enc_pk(), JubjubFr::from(3u64));
    let pi = c.public_inputs().unwrap();
    assert_eq!(pi.len(), 7, "SHIELD_PUBLIC_INPUT_COUNT is 7");
    assert_eq!(pi[1], Fr::from(777u64), "[1] amount");
    assert_eq!(pi[2], Fr::from(11u64), "[2] ownerPk");
}

// =====================================================================================
// Fold circuit
// =====================================================================================

/// A fixed note-encryption key for the shield tests, which do not otherwise need a wallet.
fn enc_pk() -> ark_ed_on_bls12_381::EdwardsAffine {
    EncKey::from_secret(JubjubFr::from(1234u64)).pk
}

fn leaves(n: usize) -> Vec<Fr> {
    (0..n).map(|i| Fr::from(9000 + i as u64)).collect()
}

#[test]
fn full_batch_fold_satisfies() {
    let cfg = poseidon_config::<Fr>();
    let tree = MerkleTree::new(&cfg);
    let (c, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(BATCH));
    assert!(satisfied(c), "a full batch must fold");
}

#[test]
fn partial_batch_fold_satisfies() {
    let cfg = poseidon_config::<Fr>();
    let tree = MerkleTree::new(&cfg);
    // A quiet period must not strand notes, so folds shorter than BATCH have to work — and must not
    // consume tree capacity for the unused slots.
    for n in 1..=BATCH {
        let (c, next) = FoldCircuit::from_tree(&cfg, &tree, &leaves(n));
        assert!(satisfied(c), "a fold of {n} leaves must satisfy");
        assert_eq!(next.next_index(), n as u64, "only {n} slots consumed");
    }
}

/// Folding on top of an existing tree — the realistic case, where the frontier is non-trivial.
#[test]
fn successive_folds_track_the_native_tree() {
    let cfg = poseidon_config::<Fr>();
    let mut tree = MerkleTree::new(&cfg);
    let mut all = Vec::new();
    for round in 0..3u64 {
        // Never zero: a zero leaf is the empty-leaf value, which the fold circuit rejects in an
        // active slot (see `fold.rs`). Real commitments are Poseidon outputs, so this matches reality.
        let batch: Vec<Fr> = (0..BATCH)
            .map(|i| Fr::from(100 * round + i as u64 + 1))
            .collect();
        let (c, next) = FoldCircuit::from_tree(&cfg, &tree, &batch);
        assert!(satisfied(c.clone()), "fold round {round} must satisfy");
        assert_eq!(
            c.new_root.unwrap(),
            next.root(),
            "the proved root must equal the native tree's root"
        );
        all.extend(batch);
        tree = next;
    }
    // Every folded leaf is provably in the tree afterwards.
    for (i, leaf) in all.iter().enumerate() {
        assert_eq!(root_from_path(&cfg, *leaf, &tree.path(i as u64)), tree.root());
    }
}

#[test]
fn fold_public_inputs_are_in_the_frozen_order() {
    let cfg = poseidon_config::<Fr>();
    let tree = MerkleTree::new(&cfg);
    let (c, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(3));
    let pi = c.public_inputs().unwrap();
    assert_eq!(pi.len(), 4 + BATCH, "FOLD_PUBLIC_INPUT_COUNT is 4 + BATCH");
    assert_eq!(pi[0], tree.root(), "[0] oldRoot");
    assert_eq!(pi[2], Fr::from(0u64), "[2] startIndex");
    assert_eq!(pi[3], Fr::from(3u64), "[3] count");
    assert_eq!(pi[4], Fr::from(9000u64), "[4] leaf0");
}

// ---- fold must-fail: each is a way a malicious folder could corrupt the tree ----

#[test]
fn fold_with_a_tampered_leaf_fails() {
    let cfg = poseidon_config::<Fr>();
    let tree = MerkleTree::new(&cfg);
    let (mut c, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(BATCH));
    let mut ls = c.leaves.unwrap();
    ls[3] = Fr::from(6666u64); // a note the contract never queued
    c.leaves = Some(ls);
    assert!(
        !satisfied(c),
        "inserting a leaf other than the queued one must fail — this is what stops a folder \
         minting notes"
    );
}

#[test]
fn fold_to_a_wrong_new_root_fails() {
    let cfg = poseidon_config::<Fr>();
    let tree = MerkleTree::new(&cfg);
    let (mut c, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(4));
    c.new_root = Some(Fr::from(0xFEEDu64));
    assert!(!satisfied(c), "an incorrect resulting root must fail");
}

#[test]
fn fold_with_a_forged_frontier_fails() {
    let cfg = poseidon_config::<Fr>();
    let mut tree = MerkleTree::new(&cfg);
    for i in 0..5u64 {
        tree.insert(Fr::from(i));
    }
    let (mut c, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(2));
    let mut f = c.frontier.unwrap();
    f[0] = Fr::from(0x1111u64);
    c.frontier = Some(f);
    assert!(
        !satisfied(c),
        "the frontier is bound by oldRoot — a forged one must fail"
    );
}

#[test]
fn fold_at_a_wrong_start_index_fails() {
    let cfg = poseidon_config::<Fr>();
    let mut tree = MerkleTree::new(&cfg);
    for i in 0..5u64 {
        tree.insert(Fr::from(i));
    }
    let (mut c, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(2));
    c.start_index = Some(9); // real next index is 5
    assert!(
        !satisfied(c),
        "appending anywhere but the tree's next free slot must fail — otherwise a folder could \
         overwrite existing notes"
    );
}

#[test]
fn fold_with_an_inflated_count_fails() {
    let cfg = poseidon_config::<Fr>();
    let tree = MerkleTree::new(&cfg);
    let (mut c, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(3));
    c.count = Some(5); // claims more leaves than were folded
    assert!(!satisfied(c), "count must match the leaves actually inserted");
}

#[test]
fn fold_with_a_deflated_count_fails() {
    let cfg = poseidon_config::<Fr>();
    let tree = MerkleTree::new(&cfg);
    let (mut c, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(5));
    c.count = Some(2); // silently drops queued notes
    assert!(
        !satisfied(c),
        "under-counting would drop queued notes and lose the money in them"
    );
}

/// Appending the empty leaf is indistinguishable from appending nothing, so without this rule a
/// fold could pad its batch with zeros, prove the correct root, and make the contract advance its
/// queue head past commitments that were never inserted — losing the money in them.
#[test]
fn fold_with_a_zero_leaf_in_an_active_slot_fails() {
    let cfg = poseidon_config::<Fr>();
    let tree = MerkleTree::new(&cfg);
    let (mut c, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(4));
    let mut ls = c.leaves.unwrap();
    ls[2] = Fr::from(0u64);
    c.leaves = Some(ls);
    assert!(
        !satisfied(c),
        "an active slot must carry a real commitment, never the empty leaf"
    );
}

/// The mirror rule: a slot past `count` must be zero, so the public-input vector the contract builds
/// is canonical and a folder cannot smuggle values into the unused slots.
#[test]
fn fold_with_a_nonzero_leaf_in_an_inactive_slot_fails() {
    let cfg = poseidon_config::<Fr>();
    let tree = MerkleTree::new(&cfg);
    let (mut c, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(3));
    let mut ls = c.leaves.unwrap();
    ls[6] = Fr::from(123u64);
    c.leaves = Some(ls);
    assert!(!satisfied(c), "inactive slots must be zero");
}

#[test]
fn fold_against_a_wrong_old_root_fails() {
    let cfg = poseidon_config::<Fr>();
    let mut tree = MerkleTree::new(&cfg);
    tree.insert(Fr::from(1u64));
    let (mut c, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(2));
    c.old_root = Some(Fr::from(0xAAAAu64));
    assert!(
        !satisfied(c),
        "a fold must start from the root the contract actually holds, or it could be replayed"
    );
}

// =====================================================================================
// Constraint-count benchmark — the proposal's #1 product risk is on-device proving time.
// =====================================================================================

#[test]
fn report_constraint_counts() {
    let cfg = poseidon_config::<Fr>();

    let cs = ConstraintSystem::<Fr>::new_ref();
    Scenario::new(50, 1000)
        .spend(600, 400, 0, Fr::from(0u64))
        .generate_constraints(cs.clone())
        .unwrap();
    println!(
        "PROVA_V3_CONSTRAINTS spend={} (v2 was 7758)",
        cs.num_constraints()
    );

    let cs = ConstraintSystem::<Fr>::new_ref();
    ShieldCircuit::new(cfg.clone(), 1, Fr::from(1u64), Fr::from(2u64), enc_pk(), JubjubFr::from(3u64))
        .generate_constraints(cs.clone())
        .unwrap();
    println!("PROVA_V3_CONSTRAINTS shield={}", cs.num_constraints());

    let cs = ConstraintSystem::<Fr>::new_ref();
    let tree = MerkleTree::new(&cfg);
    let (fold, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(BATCH));
    fold.generate_constraints(cs.clone()).unwrap();
    println!(
        "PROVA_V3_CONSTRAINTS fold={} (batch={BATCH}, server-side)",
        cs.num_constraints()
    );
}

/// Wall-clock setup + proving time for each circuit, on this machine.
///
/// The proposal's #1 product risk is on-device proving time. A desktop number is not a phone number,
/// but it bounds the shape: the spend circuit is what runs on the handset, and the fold circuit runs
/// on a server where its size is deliberately not a constraint.
#[test]
fn report_proving_times() {
    use std::time::Instant;

    let cfg = poseidon_config::<Fr>();
    let mut rng = StdRng::seed_from_u64(99);

    let s = Scenario::new(60, 1000);
    let t = Instant::now();
    let (pk, vk) =
        Groth16::<Bls12_381>::circuit_specific_setup(s.spend(600, 400, 0, Fr::from(0u64)), &mut rng)
            .unwrap();
    let setup_ms = t.elapsed().as_millis();

    let circuit = s.spend(600, 400, 0, Fr::from(0u64));
    let public = circuit.public_inputs().unwrap();
    let t = Instant::now();
    let proof = Groth16::<Bls12_381>::prove(&pk, circuit, &mut rng).unwrap();
    let prove_ms = t.elapsed().as_millis();
    assert!(Groth16::<Bls12_381>::verify(&vk, &public, &proof).unwrap());
    println!("PROVA_V3_TIMING spend setup_ms={setup_ms} prove_ms={prove_ms}");

    let t = Instant::now();
    let (spk, svk) = Groth16::<Bls12_381>::circuit_specific_setup(
        ShieldCircuit::new(cfg.clone(), 1, Fr::from(1u64), Fr::from(2u64), enc_pk(), JubjubFr::from(3u64)),
        &mut rng,
    )
    .unwrap();
    let setup_ms = t.elapsed().as_millis();
    let sc = ShieldCircuit::new(cfg.clone(), 5000, Fr::from(11u64), Fr::from(22u64), enc_pk(), JubjubFr::from(3u64));
    let spub = sc.public_inputs().unwrap();
    let t = Instant::now();
    let sproof = Groth16::<Bls12_381>::prove(&spk, sc, &mut rng).unwrap();
    println!(
        "PROVA_V3_TIMING shield setup_ms={setup_ms} prove_ms={}",
        t.elapsed().as_millis()
    );
    assert!(Groth16::<Bls12_381>::verify(&svk, &spub, &sproof).unwrap());

    let tree = MerkleTree::new(&cfg);
    let (fold_setup, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(BATCH));
    let t = Instant::now();
    let (fpk, fvk) = Groth16::<Bls12_381>::circuit_specific_setup(fold_setup, &mut rng).unwrap();
    let setup_ms = t.elapsed().as_millis();
    let (fold, _) = FoldCircuit::from_tree(&cfg, &tree, &leaves(BATCH));
    let fpub = fold.public_inputs().unwrap();
    let t = Instant::now();
    let fproof = Groth16::<Bls12_381>::prove(&fpk, fold, &mut rng).unwrap();
    println!(
        "PROVA_V3_TIMING fold setup_ms={setup_ms} prove_ms={}",
        t.elapsed().as_millis()
    );
    assert!(Groth16::<Bls12_381>::verify(&fvk, &fpub, &fproof).unwrap());
}

/// Shield's encrypted payload must be bound to its proof, exactly as a transfer's outputs are.
///
/// A depositor knows their own note, so this matters less on the day — but a wallet restored from
/// seed alone rediscovers its money by scanning, and a corrupted deposit payload would silently cost
/// someone their whole deposit on restore. The spend circuit has the equivalent test; shield needs
/// its own or the guarantee only holds on one of the two paths a note can enter the pool by.
#[test]
fn shield_encrypted_payload_is_bound_to_the_proof() {
    let cfg = poseidon_config::<Fr>();
    let mut rng = StdRng::seed_from_u64(88);
    let (pk, vk) = Groth16::<Bls12_381>::circuit_specific_setup(
        ShieldCircuit::new(
            cfg.clone(),
            1,
            Fr::from(1u64),
            Fr::from(2u64),
            enc_pk(),
            JubjubFr::from(3u64),
        ),
        &mut rng,
    )
    .unwrap();

    let circuit = ShieldCircuit::new(
        cfg.clone(),
        5_000,
        Fr::from(11u64),
        Fr::from(22u64),
        enc_pk(),
        JubjubFr::from(3u64),
    );
    let public = circuit.public_inputs().unwrap();
    let proof = Groth16::<Bls12_381>::prove(&pk, circuit, &mut rng).unwrap();
    assert!(Groth16::<Bls12_381>::verify(&vk, &public, &proof).unwrap());

    for (index, field) in [
        (3, "ephemeral key x"),
        (4, "ephemeral key y"),
        (5, "encrypted amount"),
        (6, "encrypted rho"),
    ] {
        let mut tampered = public.clone();
        tampered[index] += Fr::from(1u64);
        assert!(
            !Groth16::<Bls12_381>::verify(&vk, &tampered, &proof).unwrap(),
            "corrupting the deposit's {field} must invalidate the proof — otherwise a restored \
             wallet could never rediscover this deposit"
        );
    }
}

/// ...and the depositor really can open it, which is the point of carrying it at all.
#[test]
fn depositor_can_open_their_own_shield_note() {
    let cfg = poseidon_config::<Fr>();
    let owner_pk = Fr::from(11u64);
    let enc = EncKey::from_secret(JubjubFr::from(1234u64));
    let circuit = ShieldCircuit::new(
        cfg.clone(),
        5_000,
        owner_pk,
        Fr::from(22u64),
        enc.pk,
        JubjubFr::from(3u64),
    );

    let found = encryption::try_open(
        &cfg,
        enc.sk,
        owner_pk,
        circuit.commitment.unwrap(),
        &circuit.enc.unwrap(),
        0,
    )
    .expect("a restored wallet must rediscover its own deposit by scanning");
    assert_eq!(found.amount, 5_000);
    assert_eq!(found.commitment(&cfg), circuit.commitment.unwrap());
}
