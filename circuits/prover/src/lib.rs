//! Prova Phase 1 circuit + prover (arkworks, BLS12-381 Groth16).
//!
//! Circuit v1 proves, without revealing the amount:
//!   1. `1 <= amount <= MAX_AMOUNT`                       (range check via bit-decomposition)
//!   2. `commitment = Poseidon(amount, secret)`
//!   3. `nullifier  = Poseidon(secret, transferId)`       (anti-replay, unlinkable)
//!
//! Public inputs (in order): `[commitment, nullifier]`. Everything else is a private witness.
//! The KYC/EdDSA check is Phase 3 and intentionally not here.

use ark_bls12_381::Fr;
use ark_crypto_primitives::sponge::{
    constraints::CryptographicSpongeVar,
    poseidon::{
        constraints::PoseidonSpongeVar, find_poseidon_ark_and_mds, PoseidonConfig, PoseidonSponge,
    },
    Absorb, CryptographicSponge, FieldBasedCryptographicSponge,
};
use ark_ff::PrimeField;
use ark_r1cs_std::{alloc::AllocVar, eq::EqGadget, fields::fp::FpVar, fields::FieldVar};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};

/// UAE within-limit ceiling (FEMA/UAE placeholder). Frozen for circuit v1.
pub const MAX_AMOUNT: u64 = 9999;

/// Bit width for the range-check differences. `MAX_AMOUNT` (9999) < 2^14, so 14 bits suffice.
const RANGE_BITS: usize = 14;

/// Deterministic Poseidon parameters for a 2->1 hash (rate = 2, capacity = 1) over field `F`.
///
/// Parameters are derived deterministically from the field via the Grain LFSR, so the circuit,
/// the native prover, and any re-derivation agree. Frozen for circuit v1.
pub fn poseidon_config<F: PrimeField>() -> PoseidonConfig<F> {
    let full_rounds: u64 = 8;
    let partial_rounds: u64 = 57;
    let alpha: u64 = 5;
    let rate: usize = 2;
    let capacity: usize = 1;
    let prime_bits = F::MODULUS_BIT_SIZE as u64;
    let (ark, mds) =
        find_poseidon_ark_and_mds::<F>(prime_bits, rate, full_rounds, partial_rounds, 0);
    PoseidonConfig::new(
        full_rounds as usize,
        partial_rounds as usize,
        alpha,
        mds,
        ark,
        rate,
        capacity,
    )
}

/// Native 2->1 Poseidon hash, matching the in-circuit gadget exactly.
pub fn poseidon_hash2<F: PrimeField + Absorb>(cfg: &PoseidonConfig<F>, a: F, b: F) -> F {
    let mut sponge = PoseidonSponge::new(cfg);
    sponge.absorb(&a);
    sponge.absorb(&b);
    sponge.squeeze_native_field_elements(1)[0]
}

/// `commitment = Poseidon(amount, secret)` (native).
pub fn commitment_of(cfg: &PoseidonConfig<Fr>, amount: Fr, secret: Fr) -> Fr {
    poseidon_hash2(cfg, amount, secret)
}

/// `nullifier = Poseidon(secret, transfer_id)` (native).
pub fn nullifier_of(cfg: &PoseidonConfig<Fr>, secret: Fr, transfer_id: Fr) -> Fr {
    poseidon_hash2(cfg, secret, transfer_id)
}

/// The Prova transfer circuit (BLS12-381 scalar field).
#[derive(Clone)]
pub struct TransferCircuit {
    pub cfg: PoseidonConfig<Fr>,
    pub max_amount: u64,
    // Private witnesses.
    pub amount: Option<Fr>,
    pub secret: Option<Fr>,
    pub transfer_id: Option<Fr>,
    // Public inputs.
    pub commitment: Option<Fr>,
    pub nullifier: Option<Fr>,
}

impl TransferCircuit {
    /// Build a fully-assigned circuit from private inputs, computing the public outputs natively.
    pub fn from_inputs(cfg: PoseidonConfig<Fr>, amount: Fr, secret: Fr, transfer_id: Fr) -> Self {
        let commitment = commitment_of(&cfg, amount, secret);
        let nullifier = nullifier_of(&cfg, secret, transfer_id);
        Self {
            cfg,
            max_amount: MAX_AMOUNT,
            amount: Some(amount),
            secret: Some(secret),
            transfer_id: Some(transfer_id),
            commitment: Some(commitment),
            nullifier: Some(nullifier),
        }
    }

    /// A circuit shape with no assignments — used for the trusted setup.
    pub fn empty(cfg: PoseidonConfig<Fr>) -> Self {
        Self {
            cfg,
            max_amount: MAX_AMOUNT,
            amount: None,
            secret: None,
            transfer_id: None,
            commitment: None,
            nullifier: None,
        }
    }

    /// The public inputs in verification order: `[commitment, nullifier]`.
    pub fn public_inputs(&self) -> Option<[Fr; 2]> {
        Some([self.commitment?, self.nullifier?])
    }
}

impl ConstraintSynthesizer<Fr> for TransferCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        // Public inputs (order matters: must match verifier).
        let commitment = FpVar::new_input(cs.clone(), || {
            self.commitment.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let nullifier = FpVar::new_input(cs.clone(), || {
            self.nullifier.ok_or(SynthesisError::AssignmentMissing)
        })?;

        // Private witnesses.
        let amount = FpVar::new_witness(cs.clone(), || {
            self.amount.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let secret = FpVar::new_witness(cs.clone(), || {
            self.secret.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let transfer_id = FpVar::new_witness(cs.clone(), || {
            self.transfer_id.ok_or(SynthesisError::AssignmentMissing)
        })?;

        // Range check: 1 <= amount <= max_amount.
        //
        // Enforced as two non-negative differences that must each fit in RANGE_BITS bits:
        //   lo = amount - 1        must be in [0, 2^RANGE_BITS)  => amount >= 1
        //   hi = max_amount - amount must be in [0, 2^RANGE_BITS) => amount <= max_amount
        // Because max_amount (9999) < 2^RANGE_BITS, any out-of-range or field-wrapped amount makes
        // one difference exceed RANGE_BITS bits and fails the top-bits-zero check.
        let one = FpVar::constant(Fr::from(1u64));
        let max = FpVar::constant(Fr::from(self.max_amount));
        let lo = &amount - &one;
        let hi = &max - &amount;
        let _ = lo.to_bits_le_with_top_bits_zero(RANGE_BITS)?;
        let _ = hi.to_bits_le_with_top_bits_zero(RANGE_BITS)?;

        // commitment = Poseidon(amount, secret)
        let mut sponge_c = PoseidonSpongeVar::new(cs.clone(), &self.cfg);
        sponge_c.absorb(&amount)?;
        sponge_c.absorb(&secret)?;
        let computed_commitment = sponge_c.squeeze_field_elements(1)?;
        computed_commitment[0].enforce_equal(&commitment)?;

        // nullifier = Poseidon(secret, transfer_id)
        let mut sponge_n = PoseidonSpongeVar::new(cs.clone(), &self.cfg);
        sponge_n.absorb(&secret)?;
        sponge_n.absorb(&transfer_id)?;
        let computed_nullifier = sponge_n.squeeze_field_elements(1)?;
        computed_nullifier[0].enforce_equal(&nullifier)?;

        Ok(())
    }
}

/// Serialization to the exact byte layout Soroban's BLS12-381 host functions expect.
///
/// Soroban encoding (soroban-sdk 22 `crypto/bls12_381.rs`):
///   - `Fp`  = 48 bytes, big-endian.
///   - `G1`  = 96 bytes, uncompressed: `x(48) ‖ y(48)`.
///   - `Fp2` = 96 bytes: `c1(48) ‖ c0(48)` (imaginary part first, EIP-2537 convention).
///   - `G2`  = 192 bytes, uncompressed: `x(96) ‖ y(96)`.
///
/// The Groth16 verification equation is rearranged so the contract needs a single `pairing_check`:
///   `e(A,B) · e(alpha, -beta) · e(vk_x, -gamma) · e(C, -delta) == 1`
/// so beta/gamma/delta are **pre-negated here** (off-chain) and embedded in the VK.
pub mod soroban_ser {
    use ark_bls12_381::{Fq, Fq2, Fr, G1Affine, G2Affine};
    use ark_ff::{BigInteger, PrimeField};
    use ark_groth16::{Proof, VerifyingKey};

    pub const G1_LEN: usize = 96;
    pub const G2_LEN: usize = 192;
    pub const FR_LEN: usize = 32;

    fn fq_be(f: &Fq) -> [u8; 48] {
        let bytes = f.into_bigint().to_bytes_be(); // big-endian, minimal length
        let mut out = [0u8; 48];
        out[48 - bytes.len()..].copy_from_slice(&bytes);
        out
    }

    fn fq2_be(f: &Fq2) -> [u8; 96] {
        // Soroban/EIP-2537 order the Fp2 element as c1 ‖ c0 (imaginary part first).
        let mut out = [0u8; 96];
        out[0..48].copy_from_slice(&fq_be(&f.c1));
        out[48..96].copy_from_slice(&fq_be(&f.c0));
        out
    }

    /// G1 affine -> 96 bytes `x‖y` (panics on the point at infinity; Groth16 points are affine).
    pub fn g1_bytes(p: &G1Affine) -> [u8; G1_LEN] {
        assert!(!p.infinity, "unexpected G1 point at infinity");
        let mut out = [0u8; G1_LEN];
        out[0..48].copy_from_slice(&fq_be(&p.x));
        out[48..96].copy_from_slice(&fq_be(&p.y));
        out
    }

    /// G2 affine -> 192 bytes `x‖y`.
    pub fn g2_bytes(p: &G2Affine) -> [u8; G2_LEN] {
        assert!(!p.infinity, "unexpected G2 point at infinity");
        let mut out = [0u8; G2_LEN];
        out[0..96].copy_from_slice(&fq2_be(&p.x));
        out[96..192].copy_from_slice(&fq2_be(&p.y));
        out
    }

    /// Scalar field element -> 32 bytes big-endian (Soroban `Fr`).
    pub fn fr_bytes(f: &Fr) -> [u8; FR_LEN] {
        let bytes = f.into_bigint().to_bytes_be();
        let mut out = [0u8; FR_LEN];
        out[FR_LEN - bytes.len()..].copy_from_slice(&bytes);
        out
    }

    /// Verifying-key blob the contract embeds:
    /// `alpha(96) ‖ neg_beta(192) ‖ neg_gamma(192) ‖ neg_delta(192) ‖ IC[0..](96 each)`.
    pub fn verifying_key_blob(vk: &VerifyingKey<ark_bls12_381::Bls12_381>) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&g1_bytes(&vk.alpha_g1));
        v.extend_from_slice(&g2_bytes(&(-vk.beta_g2)));
        v.extend_from_slice(&g2_bytes(&(-vk.gamma_g2)));
        v.extend_from_slice(&g2_bytes(&(-vk.delta_g2)));
        for ic in &vk.gamma_abc_g1 {
            v.extend_from_slice(&g1_bytes(ic));
        }
        v
    }

    /// Proof + public-input blob for the test vector:
    /// `A(96) ‖ B(192) ‖ C(96) ‖ commitment(32) ‖ nullifier(32)`.
    pub fn proof_blob(
        proof: &Proof<ark_bls12_381::Bls12_381>,
        commitment: &Fr,
        nullifier: &Fr,
    ) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&g1_bytes(&proof.a));
        v.extend_from_slice(&g2_bytes(&proof.b));
        v.extend_from_slice(&g1_bytes(&proof.c));
        v.extend_from_slice(&fr_bytes(commitment));
        v.extend_from_slice(&fr_bytes(nullifier));
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_relations::r1cs::ConstraintSystem;

    #[test]
    fn valid_witness_satisfies_constraints() {
        let cfg = poseidon_config::<Fr>();
        let circuit =
            TransferCircuit::from_inputs(cfg, Fr::from(500u64), Fr::from(1234u64), Fr::from(99u64));
        let cs = ConstraintSystem::<Fr>::new_ref();
        circuit.generate_constraints(cs.clone()).unwrap();
        assert!(cs.is_satisfied().unwrap(), "valid witness must satisfy");
    }

    #[test]
    fn out_of_range_amount_fails() {
        let cfg = poseidon_config::<Fr>();
        // amount = 10000 > MAX_AMOUNT (9999)
        let circuit =
            TransferCircuit::from_inputs(cfg, Fr::from(10000u64), Fr::from(1u64), Fr::from(2u64));
        let cs = ConstraintSystem::<Fr>::new_ref();
        circuit.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap(), "out-of-range amount must fail");
    }

    #[test]
    fn zero_amount_fails() {
        let cfg = poseidon_config::<Fr>();
        let circuit =
            TransferCircuit::from_inputs(cfg, Fr::from(0u64), Fr::from(1u64), Fr::from(2u64));
        let cs = ConstraintSystem::<Fr>::new_ref();
        circuit.generate_constraints(cs.clone()).unwrap();
        assert!(!cs.is_satisfied().unwrap(), "zero amount must fail");
    }

    #[test]
    fn groth16_end_to_end_verifies_and_rejects_tampering() {
        use ark_bls12_381::Bls12_381;
        use ark_groth16::Groth16;
        use ark_snark::SNARK;
        use ark_std::rand::{rngs::StdRng, SeedableRng};

        let cfg = poseidon_config::<Fr>();
        let mut rng = StdRng::seed_from_u64(42);

        // Trusted setup uses a valid dummy assignment (structure is value-independent).
        let setup_circuit = TransferCircuit::from_inputs(
            cfg.clone(),
            Fr::from(1u64),
            Fr::from(1u64),
            Fr::from(1u64),
        );
        let (pk, vk) =
            Groth16::<Bls12_381>::circuit_specific_setup(setup_circuit, &mut rng).unwrap();

        // Prove a real transfer.
        let circuit = TransferCircuit::from_inputs(
            cfg.clone(),
            Fr::from(4200u64),
            Fr::from(987654321u64),
            Fr::from(555u64),
        );
        let public = circuit.public_inputs().unwrap();
        let proof = Groth16::<Bls12_381>::prove(&pk, circuit, &mut rng).unwrap();

        // Valid proof + correct public inputs must verify.
        assert!(Groth16::<Bls12_381>::verify(&vk, &public, &proof).unwrap());

        // Tampered public input (wrong commitment) must be rejected.
        let tampered = [public[0] + Fr::from(1u64), public[1]];
        assert!(!Groth16::<Bls12_381>::verify(&vk, &tampered, &proof).unwrap());
    }
}
