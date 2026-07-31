//! Shield circuit — binds a public deposit to the private note it creates.
//!
//! **Why this exists.** `shield` is the one path where a commitment enters the pool without a spend
//! proof behind it: the user deposits tokens and hands the contract a commitment. Because the
//! contract cannot compute Poseidon (one on-chain permutation measured ~11M CPU against a 100M
//! budget), it has no way to check that the commitment actually commits to the amount deposited.
//! Without this proof a user could transfer 100 tokens while committing to 1,000,000, then unshield
//! the pool dry — the spend circuit would happily prove that forged note's membership, because by
//! then it is a perfectly ordinary leaf.
//!
//! Letting the *fold* circuit check it instead does not work: that would need the user's private
//! `rho`, which the folding server never sees. Hence a small dedicated proof, cheap enough to
//! generate on the phone.
//!
//! The deposit's note is also **encrypted to its owner and bound by this proof**, exactly as a
//! transfer's outputs are. A depositor knows their own note, so the immediate need is weaker — but a
//! wallet restored from seed alone discovers its money by scanning, and leaving shield as the one
//! unprotected case would mean a corrupted payload silently costs someone their deposit on restore.
//!
//! Public inputs, in verification order (`SHIELD_PUBLIC_INPUTS`):
//! `[commitment, amount, ownerPk, epkX, epkY, encAmount, encRho]`.
//! The contract checks `amount` against the tokens actually transferred, which is what closes the
//! hole. `ownerPk` is public because a shield is public by design — the anchor already knows the
//! deposit (§1 of `Docs/shielded-pool.md`); privacy is required in *transit*, which `transact`
//! provides.

use ark_bls12_381::Fr;
use ark_crypto_primitives::sponge::poseidon::PoseidonConfig;
use ark_ed_on_bls12_381::{constraints::EdwardsVar, EdwardsAffine, Fr as JubjubFr};
use ark_r1cs_std::{alloc::AllocVar, convert::ToBitsGadget, eq::EqGadget, fields::fp::FpVar};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};

use super::encryption::{self, EncryptedNote};
use super::gadgets;
use super::{note_commitment, AMOUNT_BITS};
use crate::credential;

/// A deposit and the note it produces.
#[derive(Clone)]
pub struct ShieldCircuit {
    pub cfg: PoseidonConfig<Fr>,
    /// Private: the note's fresh nonce. The only thing hidden here.
    pub rho: Option<Fr>,
    /// Private: the owner's note-encryption key, and this deposit's ephemeral secret.
    pub owner_enc_pk: Option<EdwardsAffine>,
    pub esk: Option<JubjubFr>,
    // --- public ---
    pub commitment: Option<Fr>,
    pub amount: Option<u64>,
    pub owner_pk: Option<Fr>,
    pub enc: Option<EncryptedNote>,
}

impl ShieldCircuit {
    pub fn new(
        cfg: PoseidonConfig<Fr>,
        amount: u64,
        owner_pk: Fr,
        rho: Fr,
        owner_enc_pk: EdwardsAffine,
        esk: JubjubFr,
    ) -> Self {
        // Slot 0: a deposit creates exactly one note, so there is no second slot to separate from.
        let enc = encryption::encrypt(&cfg, esk, &owner_enc_pk, Fr::from(amount), rho, 0);
        Self {
            commitment: Some(note_commitment(&cfg, Fr::from(amount), owner_pk, rho)),
            rho: Some(rho),
            amount: Some(amount),
            owner_pk: Some(owner_pk),
            owner_enc_pk: Some(owner_enc_pk),
            esk: Some(esk),
            enc: Some(enc),
            cfg,
        }
    }

    /// Public inputs in verification order:
    /// `[commitment, amount, ownerPk, epkX, epkY, encAmount, encRho]`.
    pub fn public_inputs(&self) -> Option<Vec<Fr>> {
        let enc = self.enc?;
        Some(vec![
            self.commitment?,
            Fr::from(self.amount?),
            self.owner_pk?,
            enc.epk.x,
            enc.epk.y,
            enc.c_amount,
            enc.c_rho,
        ])
    }
}

impl ConstraintSynthesizer<Fr> for ShieldCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        let commitment = FpVar::new_input(cs.clone(), || {
            self.commitment.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let amount = FpVar::new_input(cs.clone(), || {
            Ok(Fr::from(
                self.amount.ok_or(SynthesisError::AssignmentMissing)?,
            ))
        })?;
        let owner_pk = FpVar::new_input(cs.clone(), || {
            self.owner_pk.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let epk = EdwardsVar::new_input(cs.clone(), || {
            Ok(self.enc.ok_or(SynthesisError::AssignmentMissing)?.epk)
        })?;
        let enc_amount = FpVar::new_input(cs.clone(), || {
            Ok(self.enc.ok_or(SynthesisError::AssignmentMissing)?.c_amount)
        })?;
        let enc_rho = FpVar::new_input(cs.clone(), || {
            Ok(self.enc.ok_or(SynthesisError::AssignmentMissing)?.c_rho)
        })?;

        let rho = FpVar::new_witness(cs.clone(), || {
            self.rho.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let owner_enc_pk = EdwardsVar::new_witness(cs.clone(), || {
            self.owner_enc_pk.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let esk = FpVar::new_witness(cs.clone(), || {
            Ok(credential::scalar_to_field(
                self.esk.ok_or(SynthesisError::AssignmentMissing)?,
            ))
        })?;

        // The commitment really commits to this amount and this owner.
        let computed = gadgets::note_commitment(cs.clone(), &self.cfg, &amount, &owner_pk, &rho)?;
        computed.enforce_equal(&commitment)?;

        // Same u64 bound every other amount obeys, so a shielded note can never be a value the
        // spend circuit's conservation arithmetic cannot represent.
        gadgets::enforce_range(&amount, AMOUNT_BITS)?;

        // The owner's discovery message, computed here so the proof covers it — a wallet restored
        // from seed alone can find this deposit, and nobody can corrupt it in transit.
        let esk_bits = esk.to_bits_le()?;
        gadgets::ephemeral_pk(cs.clone(), &esk_bits)?.enforce_equal(&epk)?;
        let (c_amount, c_rho) =
            gadgets::encrypt_note(cs, &self.cfg, &esk_bits, &owner_enc_pk, &amount, &rho, 0)?;
        c_amount.enforce_equal(&enc_amount)?;
        c_rho.enforce_equal(&enc_rho)?;
        Ok(())
    }
}

/// A self-consistent dummy shield — used only for the trusted setup.
pub fn dummy_circuit(cfg: PoseidonConfig<Fr>) -> ShieldCircuit {
    use ark_std::rand::{rngs::StdRng, SeedableRng};
    let mut rng = StdRng::seed_from_u64(5);
    let enc = super::encryption::EncKey::generate(&mut rng);
    ShieldCircuit::new(
        cfg,
        1,
        Fr::from(2u64),
        Fr::from(3u64),
        enc.pk,
        JubjubFr::from(7u64),
    )
}
