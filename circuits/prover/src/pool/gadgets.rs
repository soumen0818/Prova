//! In-circuit counterparts of the native primitives in [`super`] and [`super::tree`].
//!
//! Every function here has a native twin that must produce identical results — the tests in
//! `spend.rs` and `fold.rs` assert exactly that. A divergence would not fail loudly at runtime; it
//! would silently make notes unspendable, so the pairing of gadget and native function is the thing
//! to preserve when touching this file.

use ark_bls12_381::Fr;
use ark_crypto_primitives::sponge::poseidon::PoseidonConfig;
use ark_r1cs_std::{
    boolean::Boolean, eq::EqGadget, fields::fp::FpVar, fields::FieldVar,
    select::CondSelectGadget,
};
use ark_ec::AffineRepr;
use ark_ed_on_bls12_381::{constraints::EdwardsVar, EdwardsAffine};
use ark_r1cs_std::{alloc::AllocVar, groups::CurveVar};
use ark_relations::r1cs::{ConstraintSystemRef, SynthesisError};

use super::encryption::{MASK_AMOUNT, MASK_RHO};
use super::{DEPTH, OWNER_DOMAIN};
use crate::poseidon_sponge;

/// In-circuit `Poseidon(a, b)` — the 2→1 compression every tree node uses.
pub fn hash2(
    cs: ConstraintSystemRef<Fr>,
    cfg: &PoseidonConfig<Fr>,
    a: &FpVar<Fr>,
    b: &FpVar<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    poseidon_sponge(cs, cfg, &[a, b])
}

/// In-circuit `Poseidon(a, b, c)` — used for note commitments.
pub fn hash3(
    cs: ConstraintSystemRef<Fr>,
    cfg: &PoseidonConfig<Fr>,
    a: &FpVar<Fr>,
    b: &FpVar<Fr>,
    c: &FpVar<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    poseidon_sponge(cs, cfg, &[a, b, c])
}

/// `ownerPk = Poseidon(ownerSk, OWNER_DOMAIN)`. Native twin: [`super::owner_pk`].
pub fn owner_pk(
    cs: ConstraintSystemRef<Fr>,
    cfg: &PoseidonConfig<Fr>,
    owner_sk: &FpVar<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    let domain = FpVar::constant(Fr::from(OWNER_DOMAIN));
    hash2(cs, cfg, owner_sk, &domain)
}

/// `commitment = Poseidon(amount, ownerPk, rho)`. Native twin: [`super::note_commitment`].
pub fn note_commitment(
    cs: ConstraintSystemRef<Fr>,
    cfg: &PoseidonConfig<Fr>,
    amount: &FpVar<Fr>,
    owner_pk: &FpVar<Fr>,
    rho: &FpVar<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    hash3(cs, cfg, amount, owner_pk, rho)
}

/// `nullifier = Poseidon(ownerSk, rho)`. Native twin: [`super::note_nullifier`].
pub fn note_nullifier(
    cs: ConstraintSystemRef<Fr>,
    cfg: &PoseidonConfig<Fr>,
    owner_sk: &FpVar<Fr>,
    rho: &FpVar<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    hash2(cs, cfg, owner_sk, rho)
}

/// Enforce `0 <= value < 2^bits` by bit-decomposition.
///
/// Without this, value conservation is meaningless: amounts live in a ~255-bit field, so an attacker
/// could pick outputs that sum to the input *modulo the field order* and mint money out of the
/// wrap-around.
pub fn enforce_range(value: &FpVar<Fr>, bits: usize) -> Result<(), SynthesisError> {
    let _ = value.to_bits_le_with_top_bits_zero(bits)?;
    Ok(())
}

/// Recompute a Merkle root from a leaf, its sibling path, and its index bits.
///
/// `index_bits[i]` selects the ordering at level `i`: `false` = the running node is the **left**
/// child, `true` = the **right**. Getting this backwards would let a forged path pass, which is why
/// [`super::tree::root_from_path`] mirrors it exactly and the tests compare the two.
pub fn merkle_root_from_path(
    cs: ConstraintSystemRef<Fr>,
    cfg: &PoseidonConfig<Fr>,
    leaf: &FpVar<Fr>,
    siblings: &[FpVar<Fr>],
    index_bits: &[Boolean<Fr>],
) -> Result<FpVar<Fr>, SynthesisError> {
    assert_eq!(siblings.len(), DEPTH);
    assert_eq!(index_bits.len(), DEPTH);

    let mut cur = leaf.clone();
    for level in 0..DEPTH {
        let bit = &index_bits[level];
        let sib = &siblings[level];
        // bit = 1 → cur is the right child, so the sibling goes on the left.
        let left = FpVar::conditionally_select(bit, sib, &cur)?;
        let right = FpVar::conditionally_select(bit, &cur, sib)?;
        cur = hash2(cs.clone(), cfg, &left, &right)?;
    }
    Ok(cur)
}

/// One incremental append, in-circuit: walk `leaf` up from position `index_bits`, updating the
/// frontier, and return the resulting frontier and root.
///
/// This is the exact mirror of [`super::tree::MerkleTree::insert`]. At each level the node is either
/// a **left** child — nothing to its right yet, so it pairs with `zeros[level]` and becomes that
/// level's filled subtree — or a **right** child, pairing with the remembered filled subtree.
///
/// Passing `zeros[0]` as the leaf and discarding the returned frontier yields the *current* root for
/// a tree whose next free slot is `index_bits`, which is how the fold circuit checks that a
/// witnessed frontier really belongs to the public `oldRoot`.
pub fn frontier_walk(
    cs: ConstraintSystemRef<Fr>,
    cfg: &PoseidonConfig<Fr>,
    frontier: &[FpVar<Fr>],
    index_bits: &[Boolean<Fr>],
    leaf: &FpVar<Fr>,
    zeros: &[FpVar<Fr>],
) -> Result<(Vec<FpVar<Fr>>, FpVar<Fr>), SynthesisError> {
    assert_eq!(frontier.len(), DEPTH);
    assert_eq!(index_bits.len(), DEPTH);

    let mut next = Vec::with_capacity(DEPTH);
    let mut cur = leaf.clone();
    for level in 0..DEPTH {
        let bit = &index_bits[level];
        // Left child (bit = 0): this node becomes the level's filled subtree. Right child (bit = 1):
        // the filled subtree is untouched. Either way `left` takes the same value, so one select
        // serves both.
        let left = FpVar::conditionally_select(bit, &frontier[level], &cur)?;
        let right = FpVar::conditionally_select(bit, &cur, &zeros[level])?;
        next.push(left.clone());
        cur = hash2(cs.clone(), cfg, &left, &right)?;
    }
    Ok((next, cur))
}

/// Decompose `value` into exactly `bits` little-endian booleans, enforcing `value < 2^bits`.
///
/// Returned bits are the ones the tree walk consumes, so this doubles as the guard that a leaf index
/// is inside the tree.
pub fn to_index_bits(value: &FpVar<Fr>, bits: usize) -> Result<Vec<Boolean<Fr>>, SynthesisError> {
    let (low, _) = value.to_bits_le_with_top_bits_zero(bits)?;
    Ok(low)
}

/// Enforce `a == b`, returning nothing. A thin wrapper so call sites read as assertions.
pub fn enforce_eq(a: &FpVar<Fr>, b: &FpVar<Fr>) -> Result<(), SynthesisError> {
    a.enforce_equal(b)
}

// ---------------------------------------------------------------------------
// Note encryption (see [`super::encryption`] for the scheme and why it lives in-circuit)
// ---------------------------------------------------------------------------

/// `epk = esk·G` — the ephemeral public key the recipient needs to derive the shared secret.
///
/// Precomputing the fixed-base powers of `G` was measured and saved only 252 constraints out of
/// ~24,700 (Edwards addition is unified, so the generic path is already close to optimal). Not worth
/// the extra machinery in code that has to be audited.
pub fn ephemeral_pk(
    cs: ConstraintSystemRef<Fr>,
    esk_bits: &[Boolean<Fr>],
) -> Result<EdwardsVar, SynthesisError> {
    let generator = EdwardsVar::new_constant(cs, EdwardsAffine::generator())?;
    generator.scalar_mul_le(esk_bits.iter())
}

/// Encrypt one output note's `(amount, rho)` to `recipient_pk`, in-circuit.
///
/// Native twin: [`super::encryption::encrypt`]. Because the ciphertext is *computed here* and then
/// published as a public input, it is covered by the proof — tampering with it invalidates the
/// transaction rather than silently losing the recipient's money.
///
/// `slot` domain-separates the two outputs so that two notes to the same recipient cannot share a
/// mask (which would leak the difference of their amounts to any observer).
pub fn encrypt_note(
    cs: ConstraintSystemRef<Fr>,
    cfg: &PoseidonConfig<Fr>,
    esk_bits: &[Boolean<Fr>],
    recipient_pk: &EdwardsVar,
    amount: &FpVar<Fr>,
    rho: &FpVar<Fr>,
    slot: u64,
) -> Result<(FpVar<Fr>, FpVar<Fr>), SynthesisError> {
    // ECDH: the same point the recipient reaches as encSk·epk.
    let shared = recipient_pk.scalar_mul_le(esk_bits.iter())?;
    let k = poseidon_sponge(
        cs.clone(),
        cfg,
        &[&shared.x, &shared.y, &FpVar::constant(Fr::from(slot))],
    )?;
    let mask_amount = hash2(cs.clone(), cfg, &k, &FpVar::constant(Fr::from(MASK_AMOUNT)))?;
    let mask_rho = hash2(cs, cfg, &k, &FpVar::constant(Fr::from(MASK_RHO)))?;
    Ok((amount + mask_amount, rho + mask_rho))
}
