//! Fold circuit — proves a batch of queued commitments appends correctly to the tree.
//!
//! This is what replaces on-chain hashing. The contract cannot maintain the Merkle tree itself (one
//! Poseidon permutation costs ~11M CPU against a 100M budget, and a depth-20 append needs 20), so
//! new commitments are *queued* and a permissionless `update_root` call folds them in by verifying
//! this proof. Verification is a fixed cost regardless of the hashing it represents, which is the
//! whole reason the design works.
//!
//! Public inputs, in verification order (`FOLD_PUBLIC_INPUTS`):
//!
//! ```text
//! [oldRoot, newRoot, startIndex, count, leaf0 … leaf7]
//! ```
//!
//! The leaves are public **on purpose**: the contract passes the commitments *it* queued, which is
//! precisely what stops a folder inserting notes of its own invention. (They reveal nothing — a
//! commitment is already public once emitted.)
//!
//! ### Why witnessing the frontier is safe
//!
//! Appending needs the tree's frontier (`filled_subtrees`), which the contract does not store. The
//! circuit takes it as a private witness and proves it is consistent with the public `oldRoot` at
//! `startIndex`. A second frontier matching the same root would be a Merkle collision, so the
//! witness is bound as tightly as if it had been passed in.
//!
//! ### Trust
//!
//! The folder can neither mint, steal, nor spend: a wrong frontier, a wrong leaf, a wrong index or a
//! wrong resulting root all produce a proof that fails verification. Its only power is to stop
//! working, which delays new notes becoming spendable and puts no custodied funds at risk.

use ark_bls12_381::Fr;
use ark_ff::Field;
use ark_crypto_primitives::sponge::poseidon::PoseidonConfig;
use ark_r1cs_std::{
    alloc::AllocVar, boolean::Boolean, eq::EqGadget, fields::fp::FpVar, fields::FieldVar,
    select::CondSelectGadget, R1CSVar,
};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};

use super::gadgets;
use super::tree::MerkleTree;
use super::{empty_leaf, zero_hashes, BATCH, DEPTH};

/// A batch fold: `count` leaves appended at `start_index`, taking `old_root` to `new_root`.
#[derive(Clone)]
pub struct FoldCircuit {
    pub cfg: PoseidonConfig<Fr>,
    /// Private: the tree's frontier before the batch, bound by `old_root`.
    pub frontier: Option<[Fr; DEPTH]>,
    // --- public ---
    pub old_root: Option<Fr>,
    pub new_root: Option<Fr>,
    pub start_index: Option<u64>,
    pub count: Option<u64>,
    /// Exactly [`BATCH`] slots; entries at or past `count` are ignored and conventionally zero.
    pub leaves: Option<[Fr; BATCH]>,
}

impl FoldCircuit {
    /// Raw constructor — performs no consistency check, so must-fail tests can build invalid folds.
    pub fn new(
        cfg: PoseidonConfig<Fr>,
        frontier: [Fr; DEPTH],
        old_root: Fr,
        new_root: Fr,
        start_index: u64,
        count: u64,
        leaves: [Fr; BATCH],
    ) -> Self {
        Self {
            cfg,
            frontier: Some(frontier),
            old_root: Some(old_root),
            new_root: Some(new_root),
            start_index: Some(start_index),
            count: Some(count),
            leaves: Some(leaves),
        }
    }

    /// Build a valid fold by actually appending `leaves` to a copy of `tree` — so the witness can
    /// never drift from the native tree the indexer and wallet use.
    ///
    /// Returns the circuit and the resulting tree; the caller keeps the tree as the new state.
    pub fn from_tree(
        cfg: &PoseidonConfig<Fr>,
        tree: &MerkleTree,
        leaves: &[Fr],
    ) -> (Self, MerkleTree) {
        assert!(
            !leaves.is_empty() && leaves.len() <= BATCH,
            "a fold carries 1..={BATCH} leaves, got {}",
            leaves.len()
        );
        let frontier = tree.frontier();
        let old_root = tree.root();
        let start_index = tree.next_index();

        let mut next = tree.clone();
        for leaf in leaves {
            next.insert(*leaf);
        }

        let mut slots = [empty_leaf(); BATCH];
        slots[..leaves.len()].copy_from_slice(leaves);

        (
            Self::new(
                cfg.clone(),
                frontier,
                old_root,
                next.root(),
                start_index,
                leaves.len() as u64,
                slots,
            ),
            next,
        )
    }

    /// Public inputs in verification order: `[oldRoot, newRoot, startIndex, count, leaf0…leaf7]`.
    pub fn public_inputs(&self) -> Option<Vec<Fr>> {
        let leaves = self.leaves?;
        let mut v = vec![
            self.old_root?,
            self.new_root?,
            Fr::from(self.start_index?),
            Fr::from(self.count?),
        ];
        v.extend(leaves.iter().copied());
        Some(v)
    }
}

impl ConstraintSynthesizer<Fr> for FoldCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        // ---------------------------------------------------------------------
        // Public inputs — allocation order IS the verification order.
        // ---------------------------------------------------------------------
        let old_root = FpVar::new_input(cs.clone(), || {
            self.old_root.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let new_root = FpVar::new_input(cs.clone(), || {
            self.new_root.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let start_index = FpVar::new_input(cs.clone(), || {
            Ok(Fr::from(
                self.start_index.ok_or(SynthesisError::AssignmentMissing)?,
            ))
        })?;
        let count = FpVar::new_input(cs.clone(), || {
            Ok(Fr::from(self.count.ok_or(SynthesisError::AssignmentMissing)?))
        })?;
        let mut leaves = Vec::with_capacity(BATCH);
        for i in 0..BATCH {
            leaves.push(FpVar::new_input(cs.clone(), || {
                Ok(self.leaves.ok_or(SynthesisError::AssignmentMissing)?[i])
            })?);
        }

        // ---------------------------------------------------------------------
        // Private witness: the frontier before this batch.
        // ---------------------------------------------------------------------
        let mut frontier = Vec::with_capacity(DEPTH);
        for level in 0..DEPTH {
            frontier.push(FpVar::new_witness(cs.clone(), || {
                Ok(self.frontier.ok_or(SynthesisError::AssignmentMissing)?[level])
            })?);
        }

        // Zero-subtree hashes are circuit constants — identical to `super::zero_hashes`.
        let zeros_native = zero_hashes(&self.cfg);
        let zeros: Vec<FpVar<Fr>> = zeros_native.iter().map(|z| FpVar::constant(*z)).collect();

        // ---------------------------------------------------------------------
        // 1. `count` must be a prefix of the batch: exactly `count` active slots, and an active slot
        //    can never follow an inactive one. Together with the sum this pins the active flags to
        //    [1]*count ++ [0]*(BATCH-count), so a folder cannot skip a queued leaf and insert a
        //    later one in its place.
        // ---------------------------------------------------------------------
        let count_val = self.count;
        let mut actives = Vec::with_capacity(BATCH);
        for i in 0..BATCH {
            actives.push(Boolean::new_witness(cs.clone(), || {
                Ok((i as u64) < count_val.ok_or(SynthesisError::AssignmentMissing)?)
            })?);
        }
        let mut active_sum = FpVar::<Fr>::zero();
        for a in &actives {
            active_sum += FpVar::from(a.clone());
        }
        active_sum.enforce_equal(&count)?;
        for i in 0..BATCH - 1 {
            // active[i+1] ⇒ active[i]
            let next = FpVar::from(actives[i + 1].clone());
            let cur = FpVar::from(actives[i].clone());
            (&next * (FpVar::one() - &cur)).enforce_equal(&FpVar::zero())?;
        }

        // Pin `count` to the number of non-zero leaves.
        //
        // Appending the empty leaf is indistinguishable from appending nothing — the tree already
        // reads unfilled positions as zero, so both produce the same root. Without the rule below, a
        // fold could claim `count = 5` while supplying three real commitments and two zeros, prove
        // the correct root, and make the contract advance its queue head by five — silently dropping
        // two queued notes and losing the money in them. So: an active slot must carry a non-zero
        // leaf, and an inactive slot must carry zero. A real commitment is a Poseidon output, which
        // is never zero in practice, so this costs honest folds nothing.
        for i in 0..BATCH {
            let active_f = FpVar::from(actives[i].clone());
            // inactive ⇒ leaf == 0
            ((FpVar::one() - &active_f) * &leaves[i]).enforce_equal(&FpVar::zero())?;
            // active ⇒ leaf != 0, shown by exhibiting an inverse.
            let inv = FpVar::new_witness(cs.clone(), || {
                Ok(leaves[i]
                    .value()
                    .unwrap_or(Fr::from(0u64))
                    .inverse()
                    .unwrap_or(Fr::from(0u64)))
            })?;
            (&active_f * (&leaves[i] * &inv - FpVar::one())).enforce_equal(&FpVar::zero())?;
        }

        // ---------------------------------------------------------------------
        // 2. Frontier consistency — walking an *empty* leaf in at `start_index` reproduces the tree
        //    as it stands, so this must equal `oldRoot`. This is what binds the witnessed frontier.
        // ---------------------------------------------------------------------
        let start_bits = gadgets::to_index_bits(&start_index, DEPTH)?;
        let empty = FpVar::constant(empty_leaf());
        let (_, root_before) = gadgets::frontier_walk(
            cs.clone(),
            &self.cfg,
            &frontier,
            &start_bits,
            &empty,
            &zeros,
        )?;
        root_before.enforce_equal(&old_root)?;

        // ---------------------------------------------------------------------
        // 3. Append each active leaf at `start_index + i`, threading the frontier through.
        //    Inactive slots recompute but discard, so a short batch costs the same and — crucially —
        //    consumes no tree capacity. (Padding instead would burn 8 slots per fold and exhaust the
        //    2^20 tree within days of idling.)
        // ---------------------------------------------------------------------
        let mut cur_frontier = frontier;
        let mut cur_root = old_root.clone();
        for (i, leaf) in leaves.iter().enumerate() {
            // Decomposing `start_index + i` also enforces it is inside the tree.
            let idx = &start_index + FpVar::constant(Fr::from(i as u64));
            let idx_bits = gadgets::to_index_bits(&idx, DEPTH)?;

            let (next_frontier, next_root) = gadgets::frontier_walk(
                cs.clone(),
                &self.cfg,
                &cur_frontier,
                &idx_bits,
                leaf,
                &zeros,
            )?;

            let active = &actives[i];
            let mut selected = Vec::with_capacity(DEPTH);
            for level in 0..DEPTH {
                selected.push(FpVar::conditionally_select(
                    active,
                    &next_frontier[level],
                    &cur_frontier[level],
                )?);
            }
            cur_frontier = selected;
            cur_root = FpVar::conditionally_select(active, &next_root, &cur_root)?;
        }

        // ---------------------------------------------------------------------
        // 4. The resulting root is the one the contract will store. With `count == 0` this collapses
        //    to `newRoot == oldRoot`.
        // ---------------------------------------------------------------------
        cur_root.enforce_equal(&new_root)?;
        Ok(())
    }
}

/// A self-consistent dummy fold — used only for the trusted setup.
pub fn dummy_circuit(cfg: PoseidonConfig<Fr>) -> FoldCircuit {
    let tree = MerkleTree::new(&cfg);
    let (circuit, _) = FoldCircuit::from_tree(&cfg, &tree, &[Fr::from(1u64)]);
    circuit
}
