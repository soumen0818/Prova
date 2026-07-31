//! Spend circuit (v3) — the proof a wallet makes to move money.
//!
//! Proves, revealing neither the amount nor the parties:
//!
//! > *"I own a note that is somewhere in the pool's Merkle tree, here is its nullifier so it cannot
//! > be spent twice, the two notes I am creating carry exactly its value, and I hold a valid
//! > anchor-signed KYC credential."*
//!
//! The anonymity set is every note in the tree: membership is proved against a root, never against a
//! position. One circuit serves both operations — `publicAmount == 0` is a private transfer,
//! `publicAmount > 0` is an unshield of that much to `destination`.
//!
//! Public inputs, in verification order (`POOL_PUBLIC_INPUTS` in `shared/src/pool.ts`):
//!
//! ```text
//! [merkleRoot, nullifier, outCommitment1, outCommitment2, publicAmount, destination,
//!  anchorPkX, anchorPkY, currentTime,
//!  epkX, epkY, enc1Amount, enc1Rho, enc2Amount, enc2Rho]
//! ```
//!
//! Everything else — the input note, its path, the output notes, the credential — is a private
//! witness.
//!
//! The trailing six inputs are the **encrypted notes** (see [`super::encryption`]). They are computed
//! by this circuit rather than attached alongside it, which is what makes them tamper-proof: a relayer
//! that corrupts a recipient's discovery message invalidates the proof instead of silently making
//! their money unfindable.

use ark_bls12_381::Fr;
use ark_crypto_primitives::sponge::poseidon::PoseidonConfig;
use ark_ed_on_bls12_381::{constraints::EdwardsVar, EdwardsAffine, Fr as JubjubFr};
use ark_r1cs_std::{
    alloc::AllocVar, convert::ToBitsGadget, eq::EqGadget, fields::fp::FpVar, fields::FieldVar,
    R1CSVar,
};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};

use super::encryption::{self, EncryptedNote};
use super::gadgets;
use super::tree::MerklePath;
use super::{note_nullifier, owner_pk, Note, AMOUNT_BITS, DEPTH};
use crate::{credential, verify_signature, KYC_BITS, TIME_BITS};

/// One note being created, plus the key its recipient will discover it with.
///
/// `enc_pk` is the recipient's **note-encryption** key (Jubjub), not their spending key. It only
/// lets them find the note; it cannot move it.
#[derive(Clone, Copy, Debug)]
pub struct SpendOutput {
    pub note: Note,
    pub enc_pk: EdwardsAffine,
}

impl SpendOutput {
    pub fn new(note: Note, enc_pk: EdwardsAffine) -> Self {
        Self { note, enc_pk }
    }
}

/// A fully-assigned spend.
#[derive(Clone)]
pub struct SpendCircuit {
    pub cfg: PoseidonConfig<Fr>,

    // --- private: the note being spent ---
    pub in_amount: Option<u64>,
    pub in_rho: Option<Fr>,
    pub owner_sk: Option<Fr>,
    pub leaf_index: Option<u64>,
    /// Exactly [`DEPTH`] siblings, bottom-up.
    pub siblings: Option<Vec<Fr>>,

    // --- private: the notes being created ---
    pub out1: Option<Note>,
    pub out2: Option<Note>,
    /// Recipients' note-encryption keys.
    pub out1_enc_pk: Option<EdwardsAffine>,
    pub out2_enc_pk: Option<EdwardsAffine>,
    /// Ephemeral secret for this transfer's ECDH. **Must be fresh per transaction** — reusing it
    /// across transfers would repeat the one-time pad and expose both payloads.
    pub esk: Option<JubjubFr>,

    // --- private: the KYC credential ---
    pub kyc_level: Option<u64>,
    pub expiry: Option<u64>,
    pub sig_r: Option<EdwardsAffine>,
    pub sig_s: Option<JubjubFr>,

    // --- public ---
    pub merkle_root: Option<Fr>,
    pub nullifier: Option<Fr>,
    pub out_c1: Option<Fr>,
    pub out_c2: Option<Fr>,
    pub public_amount: Option<u64>,
    pub destination: Option<Fr>,
    pub anchor_pk: Option<EdwardsAffine>,
    pub current_time: Option<u64>,
    /// Encrypted notes: shared ephemeral public key, then each output's masked `(amount, rho)`.
    pub epk: Option<EdwardsAffine>,
    pub enc1: Option<EncryptedNote>,
    pub enc2: Option<EncryptedNote>,
}

impl SpendCircuit {
    /// Build a spend from the note being consumed, its membership path, and the notes being created.
    ///
    /// Deliberately performs **no** native validity check: value conservation, membership and
    /// credential validity are the circuit's job, and the must-fail tests need to be able to
    /// construct invalid instances.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cfg: PoseidonConfig<Fr>,
        in_amount: u64,
        in_rho: Fr,
        owner_sk: Fr,
        path: &MerklePath,
        out1: SpendOutput,
        out2: SpendOutput,
        esk: JubjubFr,
        public_amount: u64,
        destination: Fr,
        cred: &credential::Credential,
        anchor_pk: EdwardsAffine,
        current_time: u64,
    ) -> Self {
        // Encrypt each output to its recipient. Slot 0/1 keeps the two masks independent even when
        // both notes go to the same person (see `encryption`).
        let enc1 = encryption::encrypt(
            &cfg,
            esk,
            &out1.enc_pk,
            Fr::from(out1.note.amount),
            out1.note.rho,
            0,
        );
        let enc2 = encryption::encrypt(
            &cfg,
            esk,
            &out2.enc_pk,
            Fr::from(out2.note.amount),
            out2.note.rho,
            1,
        );
        Self {
            out_c1: Some(out1.note.commitment(&cfg)),
            out_c2: Some(out2.note.commitment(&cfg)),
            nullifier: Some(note_nullifier(&cfg, owner_sk, in_rho)),
            merkle_root: Some(path.root),
            in_amount: Some(in_amount),
            in_rho: Some(in_rho),
            owner_sk: Some(owner_sk),
            leaf_index: Some(path.leaf_index),
            siblings: Some(path.siblings.clone()),
            out1: Some(out1.note),
            out2: Some(out2.note),
            out1_enc_pk: Some(out1.enc_pk),
            out2_enc_pk: Some(out2.enc_pk),
            esk: Some(esk),
            epk: Some(enc1.epk),
            enc1: Some(enc1),
            enc2: Some(enc2),
            kyc_level: Some(cred.kyc_level),
            expiry: Some(cred.expiry),
            sig_r: Some(cred.sig.r),
            sig_s: Some(cred.sig.s),
            public_amount: Some(public_amount),
            destination: Some(destination),
            anchor_pk: Some(anchor_pk),
            current_time: Some(current_time),
            cfg,
        }
    }

    /// The public inputs in verification order. Must match `POOL_PUBLIC_INPUTS` exactly, or the
    /// contract's IC layout is wrong and every proof fails.
    pub fn public_inputs(&self) -> Option<Vec<Fr>> {
        let pk = self.anchor_pk?;
        Some(vec![
            self.merkle_root?,
            self.nullifier?,
            self.out_c1?,
            self.out_c2?,
            Fr::from(self.public_amount?),
            self.destination?,
            pk.x,
            pk.y,
            Fr::from(self.current_time?),
            self.epk?.x,
            self.epk?.y,
            self.enc1?.c_amount,
            self.enc1?.c_rho,
            self.enc2?.c_amount,
            self.enc2?.c_rho,
        ])
    }
}

fn witness_fr(
    cs: &ConstraintSystemRef<Fr>,
    v: Option<Fr>,
) -> Result<FpVar<Fr>, SynthesisError> {
    FpVar::new_witness(cs.clone(), || v.ok_or(SynthesisError::AssignmentMissing))
}

fn witness_u64(
    cs: &ConstraintSystemRef<Fr>,
    v: Option<u64>,
) -> Result<FpVar<Fr>, SynthesisError> {
    FpVar::new_witness(cs.clone(), || {
        Ok(Fr::from(v.ok_or(SynthesisError::AssignmentMissing)?))
    })
}

impl ConstraintSynthesizer<Fr> for SpendCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        // ---------------------------------------------------------------------
        // Public inputs — allocation order IS the verification order.
        // ---------------------------------------------------------------------
        let merkle_root = FpVar::new_input(cs.clone(), || {
            self.merkle_root.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let nullifier = FpVar::new_input(cs.clone(), || {
            self.nullifier.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let out_c1 = FpVar::new_input(cs.clone(), || {
            self.out_c1.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let out_c2 = FpVar::new_input(cs.clone(), || {
            self.out_c2.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let public_amount = FpVar::new_input(cs.clone(), || {
            Ok(Fr::from(
                self.public_amount.ok_or(SynthesisError::AssignmentMissing)?,
            ))
        })?;
        let destination = FpVar::new_input(cs.clone(), || {
            self.destination.ok_or(SynthesisError::AssignmentMissing)
        })?;
        // Anchor public key (x, y) — two inputs, so the contract can check its trusted-anchor set.
        let anchor_pk = EdwardsVar::new_input(cs.clone(), || {
            self.anchor_pk.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let current_time = FpVar::new_input(cs.clone(), || {
            Ok(Fr::from(
                self.current_time.ok_or(SynthesisError::AssignmentMissing)?,
            ))
        })?;
        // Encrypted notes. Allocating them as inputs is the whole point: it puts the recipients'
        // discovery messages inside the proof, so they cannot be corrupted in transit.
        let epk = EdwardsVar::new_input(cs.clone(), || {
            self.epk.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let enc1_amount = FpVar::new_input(cs.clone(), || {
            Ok(self.enc1.ok_or(SynthesisError::AssignmentMissing)?.c_amount)
        })?;
        let enc1_rho = FpVar::new_input(cs.clone(), || {
            Ok(self.enc1.ok_or(SynthesisError::AssignmentMissing)?.c_rho)
        })?;
        let enc2_amount = FpVar::new_input(cs.clone(), || {
            Ok(self.enc2.ok_or(SynthesisError::AssignmentMissing)?.c_amount)
        })?;
        let enc2_rho = FpVar::new_input(cs.clone(), || {
            Ok(self.enc2.ok_or(SynthesisError::AssignmentMissing)?.c_rho)
        })?;

        // ---------------------------------------------------------------------
        // Private witnesses.
        // ---------------------------------------------------------------------
        let in_amount = witness_u64(&cs, self.in_amount)?;
        let in_rho = witness_fr(&cs, self.in_rho)?;
        let owner_sk = witness_fr(&cs, self.owner_sk)?;
        let leaf_index = witness_u64(&cs, self.leaf_index)?;

        let siblings_val = self.siblings.clone();
        let mut siblings = Vec::with_capacity(DEPTH);
        for level in 0..DEPTH {
            siblings.push(witness_fr(
                &cs,
                siblings_val.as_ref().map(|s| s[level]),
            )?);
        }

        let out1_amount = witness_u64(&cs, self.out1.map(|n| n.amount))?;
        let out1_owner = witness_fr(&cs, self.out1.map(|n| n.owner_pk))?;
        let out1_rho = witness_fr(&cs, self.out1.map(|n| n.rho))?;
        let out2_amount = witness_u64(&cs, self.out2.map(|n| n.amount))?;
        let out2_owner = witness_fr(&cs, self.out2.map(|n| n.owner_pk))?;
        let out2_rho = witness_fr(&cs, self.out2.map(|n| n.rho))?;

        let esk = FpVar::new_witness(cs.clone(), || {
            Ok(credential::scalar_to_field(
                self.esk.ok_or(SynthesisError::AssignmentMissing)?,
            ))
        })?;
        let out1_enc_pk = EdwardsVar::new_witness(cs.clone(), || {
            self.out1_enc_pk.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let out2_enc_pk = EdwardsVar::new_witness(cs.clone(), || {
            self.out2_enc_pk.ok_or(SynthesisError::AssignmentMissing)
        })?;

        let kyc_level = witness_u64(&cs, self.kyc_level)?;
        let expiry = witness_u64(&cs, self.expiry)?;
        let sig_r = EdwardsVar::new_witness(cs.clone(), || {
            self.sig_r.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let sig_s = FpVar::new_witness(cs.clone(), || {
            Ok(credential::scalar_to_field(
                self.sig_s.ok_or(SynthesisError::AssignmentMissing)?,
            ))
        })?;

        // ---------------------------------------------------------------------
        // 1. Ownership — ownerPk is derived from the secret, so only its holder can spend.
        // ---------------------------------------------------------------------
        let owner_pk_var = gadgets::owner_pk(cs.clone(), &self.cfg, &owner_sk)?;

        // ---------------------------------------------------------------------
        // 2. Merkle membership — the input note's commitment is a leaf under `merkleRoot`.
        //    This is what hides *which* note is being spent: the proof says "somewhere in the tree".
        // ---------------------------------------------------------------------
        let in_commitment =
            gadgets::note_commitment(cs.clone(), &self.cfg, &in_amount, &owner_pk_var, &in_rho)?;
        let index_bits = gadgets::to_index_bits(&leaf_index, DEPTH)?;
        let computed_root = gadgets::merkle_root_from_path(
            cs.clone(),
            &self.cfg,
            &in_commitment,
            &siblings,
            &index_bits,
        )?;
        computed_root.enforce_equal(&merkle_root)?;

        // ---------------------------------------------------------------------
        // 3. Nullifier — deterministic per note, so a second spend collides and is rejected on-chain.
        //    It reveals nothing about which note was consumed.
        // ---------------------------------------------------------------------
        let computed_nullifier =
            gadgets::note_nullifier(cs.clone(), &self.cfg, &owner_sk, &in_rho)?;
        computed_nullifier.enforce_equal(&nullifier)?;

        // ---------------------------------------------------------------------
        // 4. Output commitments — each published leaf really commits to the note claimed.
        // ---------------------------------------------------------------------
        let c1 =
            gadgets::note_commitment(cs.clone(), &self.cfg, &out1_amount, &out1_owner, &out1_rho)?;
        c1.enforce_equal(&out_c1)?;
        let c2 =
            gadgets::note_commitment(cs.clone(), &self.cfg, &out2_amount, &out2_owner, &out2_rho)?;
        c2.enforce_equal(&out_c2)?;

        // ---------------------------------------------------------------------
        // 5. Range checks — BEFORE conservation, and load-bearing for it.
        //    Amounts live in a ~255-bit field; without these an attacker could choose outputs that
        //    sum to the input *modulo the field order* and mint money out of the wrap-around.
        // ---------------------------------------------------------------------
        gadgets::enforce_range(&in_amount, AMOUNT_BITS)?;
        gadgets::enforce_range(&out1_amount, AMOUNT_BITS)?;
        gadgets::enforce_range(&out2_amount, AMOUNT_BITS)?;
        gadgets::enforce_range(&public_amount, AMOUNT_BITS)?;

        // ---------------------------------------------------------------------
        // 6. Value conservation — in == out1 + out2 + public. Miss this and money is printed.
        // ---------------------------------------------------------------------
        let out_total = &out1_amount + &out2_amount + &public_amount;
        in_amount.enforce_equal(&out_total)?;

        // ---------------------------------------------------------------------
        // 7. Destination binding.
        //    `destination` must appear in a real constraint or Groth16 would leave its IC entry at
        //    infinity and the public input would not be bound at all — an unshield proof would then
        //    be replayable against any address. The rule enforced is also the product rule: a
        //    private transfer (publicAmount == 0) must not name a destination.
        // ---------------------------------------------------------------------
        let is_private = public_amount.is_zero()?;
        let is_private_f = FpVar::from(is_private);
        (&is_private_f * &destination).enforce_equal(&FpVar::zero())?;

        // ---------------------------------------------------------------------
        // 8. Note encryption — the recipients' discovery messages, computed here so the proof
        //    covers them. A relayer that corrupts a payload now invalidates the transaction rather
        //    than silently making the recipient's money unfindable.
        // ---------------------------------------------------------------------
        let esk_bits = esk.to_bits_le()?;
        let computed_epk = gadgets::ephemeral_pk(cs.clone(), &esk_bits)?;
        computed_epk.enforce_equal(&epk)?;

        let (c1_amount, c1_rho) = gadgets::encrypt_note(
            cs.clone(),
            &self.cfg,
            &esk_bits,
            &out1_enc_pk,
            &out1_amount,
            &out1_rho,
            0,
        )?;
        c1_amount.enforce_equal(&enc1_amount)?;
        c1_rho.enforce_equal(&enc1_rho)?;

        let (c2_amount, c2_rho) = gadgets::encrypt_note(
            cs.clone(),
            &self.cfg,
            &esk_bits,
            &out2_enc_pk,
            &out2_amount,
            &out2_rho,
            1,
        )?;
        c2_amount.enforce_equal(&enc2_amount)?;
        c2_rho.enforce_equal(&enc2_rho)?;

        // ---------------------------------------------------------------------
        // 9. KYC — carried over from v2, bound to *this* spender via ownerSk.
        // ---------------------------------------------------------------------
        let domain = FpVar::constant(Fr::from(credential::USER_ID_DOMAIN_CONST));
        let user_id = gadgets::hash2(cs.clone(), &self.cfg, &owner_sk, &domain)?;
        let m = crate::poseidon_sponge(cs.clone(), &self.cfg, &[&user_id, &kyc_level, &expiry])?;
        verify_signature(cs.clone(), &self.cfg, &anchor_pk, &sig_r, &sig_s, &m)?;

        // expiry >= current_time
        let _ = (&expiry - &current_time).to_bits_le_with_top_bits_zero(TIME_BITS)?;
        // kyc_level >= MIN_KYC_LEVEL
        let min_level = FpVar::constant(Fr::from(credential::MIN_KYC_LEVEL));
        let _ = (&kyc_level - &min_level).to_bits_le_with_top_bits_zero(KYC_BITS)?;

        // Silence the unused-variable warning for a value only read in tests.
        let _ = owner_pk_var.value();
        Ok(())
    }
}

/// A self-consistent dummy spend — used only for the (value-independent) trusted setup.
pub fn dummy_circuit(cfg: PoseidonConfig<Fr>) -> SpendCircuit {
    use super::tree::MerkleTree;
    use ark_std::rand::{rngs::StdRng, SeedableRng};

    let mut rng = StdRng::seed_from_u64(7);
    let anchor = credential::AnchorKey::generate(&mut rng);
    let owner_sk = Fr::from(3u64);
    let pk = owner_pk(&cfg, owner_sk);
    let rho = Fr::from(11u64);

    let note = Note::new(100, pk, rho);
    let mut tree = MerkleTree::new(&cfg);
    tree.insert(note.commitment(&cfg));
    let path = tree.path(0);

    let uid = credential::user_id(&cfg, owner_sk);
    let cred = credential::issue(&cfg, &anchor, uid, 2, 2_000_000_000, &mut rng);

    let enc = super::encryption::EncKey::generate(&mut rng);
    let esk = JubjubFr::from(9u64);
    SpendCircuit::new(
        cfg.clone(),
        100,
        rho,
        owner_sk,
        &path,
        SpendOutput::new(Note::new(70, pk, Fr::from(12u64)), enc.pk),
        SpendOutput::new(Note::new(30, pk, Fr::from(13u64)), enc.pk),
        esk,
        0,
        Fr::from(0u64),
        &cred,
        anchor.pk,
        1,
    )
}
