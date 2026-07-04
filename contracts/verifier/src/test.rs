#![cfg(test)]
extern crate std;

use super::{Error, Verifier, VerifierClient};
use soroban_sdk::{BytesN, Env};

fn setup() -> (Env, VerifierClient<'static>) {
    let env = Env::default();
    let contract_id = env.register(Verifier, ());
    let client = VerifierClient::new(&env, &contract_id);
    (env, client)
}

// A valid proof + public inputs produced by prova-prover, in Soroban BLS12-381 encoding:
// A(96) | B(192) | C(96) | commitment(32) | nullifier(32) = 448 bytes.
static SAMPLE_PROOF: &[u8] = include_bytes!("testdata/sample_proof.bin");

fn parse_proof(env: &Env) -> (BytesN<96>, BytesN<192>, BytesN<96>, BytesN<32>, BytesN<32>) {
    let a = BytesN::from_array(env, SAMPLE_PROOF[0..96].try_into().unwrap());
    let b = BytesN::from_array(env, SAMPLE_PROOF[96..288].try_into().unwrap());
    let c = BytesN::from_array(env, SAMPLE_PROOF[288..384].try_into().unwrap());
    let commitment = BytesN::from_array(env, SAMPLE_PROOF[384..416].try_into().unwrap());
    let nullifier = BytesN::from_array(env, SAMPLE_PROOF[416..448].try_into().unwrap());
    (a, b, c, commitment, nullifier)
}

#[test]
fn verifies_valid_proof() {
    let (env, client) = setup();
    let (a, b, c, commitment, nullifier) = parse_proof(&env);
    assert!(
        client.verify(&a, &b, &c, &commitment, &nullifier),
        "a valid proof must verify"
    );
}

#[test]
fn rejects_tampered_public_input() {
    let (env, client) = setup();
    let (a, b, c, _commitment, nullifier) = parse_proof(&env);
    // Flip one bit of the commitment — the proof no longer matches its public inputs.
    let mut bad = [0u8; 32];
    bad.copy_from_slice(&SAMPLE_PROOF[384..416]);
    bad[31] ^= 1;
    let bad_commitment = BytesN::from_array(&env, &bad);
    assert!(
        !client.verify(&a, &b, &c, &bad_commitment, &nullifier),
        "a tampered public input must be rejected"
    );
}

#[test]
fn measure_verify_cost() {
    let (env, client) = setup();
    let (a, b, c, commitment, nullifier) = parse_proof(&env);
    // Measure just the verify call.
    env.cost_estimate().budget().reset_default();
    let ok = client.verify(&a, &b, &c, &commitment, &nullifier);
    assert!(ok);
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let mem = env.cost_estimate().budget().memory_bytes_cost();
    std::println!("PROVA_VERIFY_COST cpu_insns={cpu} mem_bytes={mem}");
    // Soroban's per-transaction CPU ceiling is 100_000_000 instructions; one verify must fit well
    // under it (native measurement underestimates wasm, so keep generous headroom).
    assert!(cpu < 100_000_000, "verify must fit the CPU budget");
}

#[test]
fn records_transfer_and_tracks_nullifier() {
    let (env, client) = setup();
    let commitment = BytesN::from_array(&env, &[1u8; 32]);
    let nullifier = BytesN::from_array(&env, &[2u8; 32]);

    assert!(!client.is_spent(&nullifier));
    client.submit(&commitment, &nullifier);
    assert!(client.is_spent(&nullifier));
}

#[test]
fn rejects_replayed_nullifier() {
    let (env, client) = setup();
    let commitment = BytesN::from_array(&env, &[1u8; 32]);
    let nullifier = BytesN::from_array(&env, &[2u8; 32]);

    client.submit(&commitment, &nullifier);
    let result = client.try_submit(&commitment, &nullifier);
    assert_eq!(result, Err(Ok(Error::NullifierAlreadyUsed)));
}
