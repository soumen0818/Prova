//! C ABI for the on-device prover (Phase 4). The Android native module calls these to generate a
//! Groth16 proof on a native thread, off the JS thread. iOS would bind the same functions.
//!
//! The proving key is derived once (deterministic, cached) to match the deployed verifying key.
//! Inputs/outputs are JSON/hex strings for simple JNI marshalling. The amount and secret stay on
//! the device — this function is exactly where privacy is preserved.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::sync::OnceLock;

use ark_bls12_381::{Bls12_381, Fr};
use ark_ed_on_bls12_381::{EdwardsAffine, Fr as JubjubFr};
use ark_ff::PrimeField;
use ark_groth16::{Groth16, ProvingKey};
use ark_snark::SNARK;
use ark_std::rand::rngs::OsRng;
use serde_json::Value;

use crate::{credential, poseidon_config, setup_keys, soroban_ser, TransferCircuit, SETUP_SEED};

/// Cached proving key (derived once via the deterministic setup, matching the deployed VK).
fn proving_key() -> &'static ProvingKey<Bls12_381> {
    static PK: OnceLock<ProvingKey<Bls12_381>> = OnceLock::new();
    PK.get_or_init(|| setup_keys(SETUP_SEED).0)
}

fn fr_hex(s: &str) -> Result<Fr, String> {
    let b = hex::decode(s).map_err(|_| "bad hex".to_string())?;
    Ok(Fr::from_be_bytes_mod_order(&b))
}
fn jfr_hex(s: &str) -> Result<JubjubFr, String> {
    let b = hex::decode(s).map_err(|_| "bad hex".to_string())?;
    Ok(JubjubFr::from_be_bytes_mod_order(&b))
}
fn str_field<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing field {k}"))
}
fn u64_field(v: &Value, k: &str) -> Result<u64, String> {
    let f = v.get(k).ok_or_else(|| format!("missing field {k}"))?;
    f.as_u64()
        .or_else(|| f.as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(|| format!("field {k} not a u64"))
}

/// Build the circuit from the JSON input and produce the 544-byte Soroban proof blob (hex).
/// Shared by the C ABI and the CLI's `prove-json` so both exercise the exact on-device path.
pub fn prove_json(input: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let cfg = poseidon_config::<Fr>();

    let amount = u64_field(&v, "amount")?;
    let secret = fr_hex(str_field(&v, "secret")?)?;
    let transfer_id = u64_field(&v, "transferId")?;
    let kyc_level = u64_field(&v, "kycLevel")?;
    let expiry = u64_field(&v, "expiry")?;
    let current_time = u64_field(&v, "currentTime")?;

    let sig = credential::Signature {
        r: EdwardsAffine::new_unchecked(
            fr_hex(str_field(&v, "sigRx")?)?,
            fr_hex(str_field(&v, "sigRy")?)?,
        ),
        s: jfr_hex(str_field(&v, "sigS")?)?,
    };
    let cred = credential::Credential {
        user_id: credential::user_id(&cfg, secret),
        kyc_level,
        expiry,
        sig,
    };
    let anchor_pk = EdwardsAffine::new_unchecked(
        fr_hex(str_field(&v, "anchorPkX")?)?,
        fr_hex(str_field(&v, "anchorPkY")?)?,
    );

    let circuit = TransferCircuit::new(
        cfg,
        Fr::from(amount),
        secret,
        Fr::from(transfer_id),
        &cred,
        anchor_pk,
        current_time,
    );
    let public = circuit.public_inputs().ok_or("no public inputs")?;

    let proof = Groth16::<Bls12_381>::prove(proving_key(), circuit, &mut OsRng)
        .map_err(|e| format!("prove: {e}"))?;
    Ok(hex::encode(soroban_ser::proof_blob(&proof, &public)))
}

/// Derive `user_id = Poseidon(secret, domain)` for the KYC handoff. Input/output are hex.
pub fn user_id_hex(secret_hex: &str) -> Result<String, String> {
    let cfg = poseidon_config::<Fr>();
    let secret = fr_hex(secret_hex)?;
    Ok(hex::encode(soroban_ser::fr_bytes(&credential::user_id(
        &cfg, secret,
    ))))
}

fn to_c_string(r: Result<String, String>) -> *mut c_char {
    let s = match r {
        Ok(hexstr) => hexstr,
        Err(e) => format!("error:{e}"),
    };
    CString::new(s).unwrap_or_default().into_raw()
}

/// Generate a proof. `input` is a JSON object (see `prove_json`); returns hex proof, or `error:...`.
///
/// # Safety
/// `input` must be a valid NUL-terminated C string. The returned pointer must be freed with
/// `prova_string_free`.
#[no_mangle]
pub unsafe extern "C" fn prova_prove_json(input: *const c_char) -> *mut c_char {
    if input.is_null() {
        return to_c_string(Err("null input".into()));
    }
    let s = match CStr::from_ptr(input).to_str() {
        Ok(s) => s,
        Err(_) => return to_c_string(Err("invalid utf8".into())),
    };
    to_c_string(prove_json(s))
}

/// Derive the user id from a secret. Returns hex, or `error:...`.
///
/// # Safety
/// `secret_hex` must be a valid NUL-terminated C string; free the result with `prova_string_free`.
#[no_mangle]
pub unsafe extern "C" fn prova_user_id(secret_hex: *const c_char) -> *mut c_char {
    if secret_hex.is_null() {
        return to_c_string(Err("null input".into()));
    }
    let s = match CStr::from_ptr(secret_hex).to_str() {
        Ok(s) => s,
        Err(_) => return to_c_string(Err("invalid utf8".into())),
    };
    to_c_string(user_id_hex(s))
}

/// Free a string returned by this library.
///
/// # Safety
/// `s` must be a pointer previously returned by this library (or null).
#[no_mangle]
pub unsafe extern "C" fn prova_string_free(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_std::rand::{rngs::StdRng, SeedableRng};

    fn fqx(f: &Fr) -> String {
        hex::encode(soroban_ser::fr_bytes(f))
    }

    #[test]
    fn user_id_matches_native() {
        let cfg = poseidon_config::<Fr>();
        let secret = Fr::from(123456u64);
        let expected = hex::encode(soroban_ser::fr_bytes(&credential::user_id(&cfg, secret)));
        assert_eq!(user_id_hex(&fqx(&secret)).unwrap(), expected);
    }

    // Full on-device prove path. Heavy (runs the trusted setup once) — run explicitly:
    //   cargo test --release ffi_prove_produces_valid_blob -- --ignored --nocapture
    #[test]
    #[ignore]
    fn ffi_prove_produces_valid_blob() {
        use ark_bls12_381::Bls12_381;
        use ark_groth16::Groth16;
        use ark_snark::SNARK;

        let cfg = poseidon_config::<Fr>();
        let mut rng = StdRng::seed_from_u64(9);
        let anchor = credential::AnchorKey::generate(&mut rng);
        let secret = Fr::from(424242u64);
        let uid = credential::user_id(&cfg, secret);
        let cred = credential::issue(&cfg, &anchor, uid, 2, 2_000_000_000, &mut rng);

        let input = serde_json::json!({
            "amount": "500", "secret": fqx(&secret), "transferId": "7",
            "kycLevel": "2", "expiry": "2000000000", "currentTime": "1700000000",
            "sigRx": fqx(&cred.sig.r.x), "sigRy": fqx(&cred.sig.r.y),
            "sigS": hex::encode({
                use ark_ff::BigInteger;
                let mut o = [0u8; 32];
                let b = cred.sig.s.into_bigint().to_bytes_be();
                o[32 - b.len()..].copy_from_slice(&b);
                o
            }),
            "anchorPkX": fqx(&anchor.pk.x), "anchorPkY": fqx(&anchor.pk.y),
        })
        .to_string();

        let out = prove_json(&input).expect("prove");
        assert_eq!(out.len(), 544 * 2, "proof blob must be 544 bytes");

        // Sanity: the same pk/vk verify a directly-built proof for these inputs.
        let (pk, vk) = setup_keys(SETUP_SEED);
        let circuit = TransferCircuit::new(
            cfg,
            Fr::from(500u64),
            secret,
            Fr::from(7u64),
            &cred,
            anchor.pk,
            1_700_000_000,
        );
        let public = circuit.public_inputs().unwrap();
        let proof = Groth16::<Bls12_381>::prove(&pk, circuit, &mut OsRng).unwrap();
        assert!(Groth16::<Bls12_381>::verify(&vk, &public, &proof).unwrap());
    }
}
