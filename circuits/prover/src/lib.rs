//! Prova circuit + prover (arkworks, BLS12-381 Groth16). Circuit v2 (Phase 3, KYC-inclusive).
//!
//! Proves, without revealing the amount or identity:
//!   1. `1 <= amount <= MAX_AMOUNT`                       (range check via bit-decomposition)
//!   2. `commitment = Poseidon(amount, secret)`
//!   3. `nullifier  = Poseidon(secret, transferId)`       (anti-replay, unlinkable)
//!   4. the anchor signed `(user_id, kyc_level, expiry)`  (Jubjub EdDSA verified in-circuit; see
//!      `credential`), with `user_id = Poseidon(secret, domain)`, `expiry >= currentTime`, and
//!      `kyc_level >= MIN_KYC_LEVEL`.
//!
//! Public inputs (in order): `[commitment, nullifier, anchorPk.x, anchorPk.y, currentTime]`.
//! Everything else (amount, secret, transferId, kyc_level, expiry, signature) is a private witness.

use ark_bls12_381::Fr;
use ark_crypto_primitives::sponge::{
    constraints::CryptographicSpongeVar,
    poseidon::{
        constraints::PoseidonSpongeVar, find_poseidon_ark_and_mds, PoseidonConfig, PoseidonSponge,
    },
    Absorb, CryptographicSponge, FieldBasedCryptographicSponge,
};
use ark_ec::AffineRepr;
use ark_ed_on_bls12_381::{constraints::EdwardsVar, EdwardsAffine, Fr as JubjubFr};
use ark_ff::PrimeField;
use ark_r1cs_std::{
    alloc::AllocVar, convert::ToBitsGadget, eq::EqGadget, fields::fp::FpVar, fields::FieldVar,
    groups::CurveVar,
};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef, SynthesisError};

pub mod credential;
pub mod pool;
pub mod ffi;
#[cfg(target_os = "android")]
pub mod jni_bridge;

/// Seed for the deterministic (testnet-grade) trusted setup. Mainnet uses the public ceremony.
pub const SETUP_SEED: u64 = 42;

/// Bit width for timestamp differences in the expiry check (unix seconds fit well under 2^40).
pub const TIME_BITS: usize = 40;
/// Bit width for the kyc-level margin (levels are tiny).
pub const KYC_BITS: usize = 8;

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
    poseidon_hash_n(cfg, &[a, b])
}

/// Native variable-arity Poseidon hash (absorb all inputs, squeeze one), matching the sponge gadget.
pub fn poseidon_hash_n<F: PrimeField + Absorb>(cfg: &PoseidonConfig<F>, inputs: &[F]) -> F {
    let mut sponge = PoseidonSponge::new(cfg);
    for x in inputs {
        sponge.absorb(x);
    }
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
    pub kyc_level: Option<u64>,
    pub expiry: Option<u64>,
    pub sig_r: Option<EdwardsAffine>,
    pub sig_s: Option<JubjubFr>,
    // Public inputs.
    pub commitment: Option<Fr>,
    pub nullifier: Option<Fr>,
    pub anchor_pk: Option<EdwardsAffine>,
    pub current_time: Option<u64>,
}

impl TransferCircuit {
    /// Build a fully-assigned circuit from private inputs + an anchor-attested credential.
    ///
    /// The credential MUST have been issued for `user_id = credential::user_id(cfg, secret)` by the
    /// anchor whose public key is `anchor_pk`, or the in-circuit signature check will fail.
    pub fn new(
        cfg: PoseidonConfig<Fr>,
        amount: Fr,
        secret: Fr,
        transfer_id: Fr,
        cred: &credential::Credential,
        anchor_pk: EdwardsAffine,
        current_time: u64,
    ) -> Self {
        let commitment = commitment_of(&cfg, amount, secret);
        let nullifier = nullifier_of(&cfg, secret, transfer_id);
        Self {
            cfg,
            max_amount: MAX_AMOUNT,
            amount: Some(amount),
            secret: Some(secret),
            transfer_id: Some(transfer_id),
            kyc_level: Some(cred.kyc_level),
            expiry: Some(cred.expiry),
            sig_r: Some(cred.sig.r),
            sig_s: Some(cred.sig.s),
            commitment: Some(commitment),
            nullifier: Some(nullifier),
            anchor_pk: Some(anchor_pk),
            current_time: Some(current_time),
        }
    }

    /// The public inputs in verification order: `[commitment, nullifier, pk.x, pk.y, current_time]`.
    pub fn public_inputs(&self) -> Option<Vec<Fr>> {
        let pk = self.anchor_pk?;
        Some(vec![
            self.commitment?,
            self.nullifier?,
            pk.x,
            pk.y,
            Fr::from(self.current_time?),
        ])
    }
}

impl ConstraintSynthesizer<Fr> for TransferCircuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fr>) -> Result<(), SynthesisError> {
        // Public inputs (order matters: must match the verifier / VK IC layout).
        let commitment = FpVar::new_input(cs.clone(), || {
            self.commitment.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let nullifier = FpVar::new_input(cs.clone(), || {
            self.nullifier.ok_or(SynthesisError::AssignmentMissing)
        })?;
        // Anchor public key (x, y) — 2 public inputs, so the contract can check the trusted set.
        let anchor_pk = EdwardsVar::new_input(cs.clone(), || {
            self.anchor_pk.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let current_time = FpVar::new_input(cs.clone(), || {
            Ok(Fr::from(
                self.current_time.ok_or(SynthesisError::AssignmentMissing)?,
            ))
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
        let kyc_level = FpVar::new_witness(cs.clone(), || {
            Ok(Fr::from(
                self.kyc_level.ok_or(SynthesisError::AssignmentMissing)?,
            ))
        })?;
        let expiry = FpVar::new_witness(cs.clone(), || {
            Ok(Fr::from(
                self.expiry.ok_or(SynthesisError::AssignmentMissing)?,
            ))
        })?;
        let sig_r = EdwardsVar::new_witness(cs.clone(), || {
            self.sig_r.ok_or(SynthesisError::AssignmentMissing)
        })?;
        let sig_s = FpVar::new_witness(cs.clone(), || {
            Ok(credential::scalar_to_field(
                self.sig_s.ok_or(SynthesisError::AssignmentMissing)?,
            ))
        })?;

        // --- 1. Range check: 1 <= amount <= max_amount (two non-negative RANGE_BITS-bounded diffs).
        let one = FpVar::constant(Fr::from(1u64));
        let max = FpVar::constant(Fr::from(self.max_amount));
        let _ = (&amount - &one).to_bits_le_with_top_bits_zero(RANGE_BITS)?;
        let _ = (&max - &amount).to_bits_le_with_top_bits_zero(RANGE_BITS)?;

        // --- 2. commitment = Poseidon(amount, secret)
        let computed_commitment = poseidon_sponge(cs.clone(), &self.cfg, &[&amount, &secret])?;
        computed_commitment.enforce_equal(&commitment)?;

        // --- 3. nullifier = Poseidon(secret, transfer_id)
        let computed_nullifier = poseidon_sponge(cs.clone(), &self.cfg, &[&secret, &transfer_id])?;
        computed_nullifier.enforce_equal(&nullifier)?;

        // --- 4. KYC credential: the anchor signed (user_id, kyc_level, expiry), verified in-circuit.
        // user_id = Poseidon(secret, USER_ID_DOMAIN) — binds the credential to THIS transfer's secret.
        let domain = FpVar::constant(Fr::from(credential::USER_ID_DOMAIN_CONST));
        let user_id = poseidon_sponge(cs.clone(), &self.cfg, &[&secret, &domain])?;
        // m = Poseidon(user_id, kyc_level, expiry)
        let m = poseidon_sponge(cs.clone(), &self.cfg, &[&user_id, &kyc_level, &expiry])?;
        // Verify the Schnorr/EdDSA signature over Jubjub: s·G == R + e·pk, e = Poseidon(R,pk,m).
        verify_signature(cs.clone(), &self.cfg, &anchor_pk, &sig_r, &sig_s, &m)?;

        // --- 5. expiry >= current_time  (expiry - current_time is a non-negative TIME_BITS value).
        let _ = (&expiry - &current_time).to_bits_le_with_top_bits_zero(TIME_BITS)?;

        // --- 6. kyc_level >= MIN_KYC_LEVEL.
        let min_level = FpVar::constant(Fr::from(credential::MIN_KYC_LEVEL));
        let _ = (&kyc_level - &min_level).to_bits_le_with_top_bits_zero(KYC_BITS)?;

        Ok(())
    }
}

/// A self-consistent dummy circuit instance — used only for the (value-independent) trusted setup.
pub fn dummy_circuit(cfg: PoseidonConfig<Fr>) -> TransferCircuit {
    use ark_std::rand::{rngs::StdRng, SeedableRng};
    let mut rng = StdRng::seed_from_u64(1);
    let anchor = credential::AnchorKey::generate(&mut rng);
    let secret = Fr::from(1u64);
    let uid = credential::user_id(&cfg, secret);
    let cred = credential::issue(&cfg, &anchor, uid, 2, 2_000_000_000, &mut rng);
    TransferCircuit::new(
        cfg,
        Fr::from(1u64),
        secret,
        Fr::from(1u64),
        &cred,
        anchor.pk,
        1,
    )
}

/// Deterministic Groth16 keys for circuit v2 (matches the deployed VK when seeded with `SETUP_SEED`).
pub fn setup_keys(
    seed: u64,
) -> (
    ark_groth16::ProvingKey<ark_bls12_381::Bls12_381>,
    ark_groth16::VerifyingKey<ark_bls12_381::Bls12_381>,
) {
    use ark_snark::SNARK;
    use ark_std::rand::{rngs::StdRng, SeedableRng};
    let cfg = poseidon_config::<Fr>();
    let mut rng = StdRng::seed_from_u64(seed);
    ark_groth16::Groth16::<ark_bls12_381::Bls12_381>::circuit_specific_setup(
        dummy_circuit(cfg),
        &mut rng,
    )
    .expect("setup")
}

/// Poseidon sponge over field-var inputs (absorb all, squeeze one) — the in-circuit hash.
pub fn poseidon_sponge(
    cs: ConstraintSystemRef<Fr>,
    cfg: &PoseidonConfig<Fr>,
    inputs: &[&FpVar<Fr>],
) -> Result<FpVar<Fr>, SynthesisError> {
    let mut sponge = PoseidonSpongeVar::new(cs, cfg);
    for x in inputs {
        sponge.absorb(*x)?;
    }
    Ok(sponge.squeeze_field_elements(1)?[0].clone())
}

/// In-circuit Schnorr/EdDSA verification over Jubjub: enforces `s·G == R + e·pk`, where
/// `e = Poseidon(R.x, R.y, pk.x, pk.y, m)`. Native counterpart: `credential::verify`.
pub fn verify_signature(
    cs: ConstraintSystemRef<Fr>,
    cfg: &PoseidonConfig<Fr>,
    pk: &EdwardsVar,
    r: &EdwardsVar,
    s: &FpVar<Fr>,
    m: &FpVar<Fr>,
) -> Result<(), SynthesisError> {
    let e = poseidon_sponge(cs.clone(), cfg, &[&r.x, &r.y, &pk.x, &pk.y, m])?;
    let e_bits = e.to_bits_le()?;
    let s_bits = s.to_bits_le()?;
    let generator = EdwardsVar::new_constant(cs, EdwardsAffine::generator())?;
    let lhs = generator.scalar_mul_le(s_bits.iter())?; // s·G
    let e_pk = pk.scalar_mul_le(e_bits.iter())?; // e·pk
    let rhs = r + &e_pk; // R + e·pk
    lhs.enforce_equal(&rhs)
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
    /// `A(96) ‖ B(192) ‖ C(96) ‖ public_inputs(32 each)`.
    /// Circuit v2 public inputs: `[commitment, nullifier, anchorPk.x, anchorPk.y, currentTime]`.
    pub fn proof_blob(proof: &Proof<ark_bls12_381::Bls12_381>, public_inputs: &[Fr]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&g1_bytes(&proof.a));
        v.extend_from_slice(&g2_bytes(&proof.b));
        v.extend_from_slice(&g1_bytes(&proof.c));
        for pi in public_inputs {
            v.extend_from_slice(&fr_bytes(pi));
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_relations::r1cs::ConstraintSystem;
    use ark_std::rand::{rngs::StdRng, SeedableRng};

    const NOW: u64 = 1_700_000_000;
    const LATER: u64 = 2_000_000_000;

    /// Build a fully valid circuit: a credential issued by `anchor` for `user_id(secret)`.
    fn valid_circuit(seed: u64, amount: u64) -> (TransferCircuit, credential::AnchorKey) {
        let cfg = poseidon_config::<Fr>();
        let mut rng = StdRng::seed_from_u64(seed);
        let anchor = credential::AnchorKey::generate(&mut rng);
        let secret = Fr::from(987654321u64 + seed);
        let uid = credential::user_id(&cfg, secret);
        let cred = credential::issue(&cfg, &anchor, uid, 2, LATER, &mut rng);
        let circuit = TransferCircuit::new(
            cfg,
            Fr::from(amount),
            secret,
            Fr::from(555u64),
            &cred,
            anchor.pk,
            NOW,
        );
        (circuit, anchor)
    }

    fn satisfied(circuit: TransferCircuit) -> bool {
        let cs = ConstraintSystem::<Fr>::new_ref();
        circuit.generate_constraints(cs.clone()).unwrap();
        cs.is_satisfied().unwrap()
    }

    #[test]
    fn valid_kyc_transfer_satisfies() {
        let (circuit, _) = valid_circuit(1, 500);
        assert!(satisfied(circuit), "valid KYC transfer must satisfy");
    }

    #[test]
    fn out_of_range_amount_fails() {
        let (circuit, _) = valid_circuit(2, 10_000); // > MAX_AMOUNT
        assert!(!satisfied(circuit), "out-of-range amount must fail");
    }

    #[test]
    fn zero_amount_fails() {
        let (circuit, _) = valid_circuit(3, 0);
        assert!(!satisfied(circuit), "zero amount must fail");
    }

    #[test]
    fn expired_credential_fails() {
        let cfg = poseidon_config::<Fr>();
        let mut rng = StdRng::seed_from_u64(4);
        let anchor = credential::AnchorKey::generate(&mut rng);
        let secret = Fr::from(111u64);
        let uid = credential::user_id(&cfg, secret);
        // expiry is BEFORE current time.
        let cred = credential::issue(&cfg, &anchor, uid, 2, NOW - 1, &mut rng);
        let circuit = TransferCircuit::new(
            cfg,
            Fr::from(100u64),
            secret,
            Fr::from(9u64),
            &cred,
            anchor.pk,
            NOW,
        );
        assert!(!satisfied(circuit), "expired credential must fail");
    }

    #[test]
    fn forged_signature_fails() {
        let cfg = poseidon_config::<Fr>();
        let mut rng = StdRng::seed_from_u64(5);
        let real_anchor = credential::AnchorKey::generate(&mut rng);
        let attacker = credential::AnchorKey::generate(&mut rng);
        let secret = Fr::from(222u64);
        let uid = credential::user_id(&cfg, secret);
        // Signed by the attacker but checked against the real anchor's public key.
        let cred = credential::issue(&cfg, &attacker, uid, 2, LATER, &mut rng);
        let circuit = TransferCircuit::new(
            cfg,
            Fr::from(100u64),
            secret,
            Fr::from(9u64),
            &cred,
            real_anchor.pk,
            NOW,
        );
        assert!(!satisfied(circuit), "forged signature must fail");
    }

    #[test]
    fn wrong_user_credential_fails() {
        // A credential issued for a DIFFERENT user's secret must not prove this transfer.
        let cfg = poseidon_config::<Fr>();
        let mut rng = StdRng::seed_from_u64(6);
        let anchor = credential::AnchorKey::generate(&mut rng);
        let other_uid = credential::user_id(&cfg, Fr::from(999u64));
        let cred = credential::issue(&cfg, &anchor, other_uid, 2, LATER, &mut rng);
        let circuit = TransferCircuit::new(
            cfg,
            Fr::from(100u64),
            Fr::from(222u64), // different secret than the credential's user
            Fr::from(9u64),
            &cred,
            anchor.pk,
            NOW,
        );
        assert!(
            !satisfied(circuit),
            "credential bound to another user must fail"
        );
    }

    #[test]
    fn groth16_end_to_end_verifies_and_rejects_tampering() {
        use ark_bls12_381::Bls12_381;
        use ark_groth16::Groth16;
        use ark_snark::SNARK;

        let mut rng = StdRng::seed_from_u64(42);
        let (setup_circuit, _) = valid_circuit(10, 1);
        let (pk, vk) =
            Groth16::<Bls12_381>::circuit_specific_setup(setup_circuit, &mut rng).unwrap();

        let (circuit, _) = valid_circuit(11, 4200);
        let public = circuit.public_inputs().unwrap();
        let proof = Groth16::<Bls12_381>::prove(&pk, circuit, &mut rng).unwrap();

        assert!(Groth16::<Bls12_381>::verify(&vk, &public, &proof).unwrap());

        // Tampered public input (wrong commitment) must be rejected.
        let mut tampered = public.clone();
        tampered[0] += Fr::from(1u64);
        assert!(!Groth16::<Bls12_381>::verify(&vk, &tampered, &proof).unwrap());
    }
}

#[cfg(test)]
mod bench_v2 {
    use super::*;
    use ark_relations::r1cs::ConstraintSystem;
    #[test]
    fn constraint_count() {
        let cfg = poseidon_config::<Fr>();
        let cs = ConstraintSystem::<Fr>::new_ref();
        dummy_circuit(cfg).generate_constraints(cs.clone()).unwrap();
        std::println!("PROVA_V2_CONSTRAINTS num_constraints={} num_witness={} num_instance={}",
            cs.num_constraints(), cs.num_witness_variables(), cs.num_instance_variables());
    }
}
