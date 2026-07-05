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

// A valid KYC proof + public inputs from prova-prover, in Soroban BLS12-381 encoding:
// A(96) | B(192) | C(96) | commitment(32) | nullifier(32) | pk.x(32) | pk.y(32) | time(32) = 544.
static SAMPLE_PROOF: &[u8] = include_bytes!("testdata/sample_proof.bin");

struct Proof {
    a: BytesN<96>,
    b: BytesN<192>,
    c: BytesN<96>,
    commitment: BytesN<32>,
    nullifier: BytesN<32>,
    pk_x: BytesN<32>,
    pk_y: BytesN<32>,
    time: BytesN<32>,
}

fn parse_proof(env: &Env) -> Proof {
    Proof {
        a: BytesN::from_array(env, SAMPLE_PROOF[0..96].try_into().unwrap()),
        b: BytesN::from_array(env, SAMPLE_PROOF[96..288].try_into().unwrap()),
        c: BytesN::from_array(env, SAMPLE_PROOF[288..384].try_into().unwrap()),
        commitment: BytesN::from_array(env, SAMPLE_PROOF[384..416].try_into().unwrap()),
        nullifier: BytesN::from_array(env, SAMPLE_PROOF[416..448].try_into().unwrap()),
        pk_x: BytesN::from_array(env, SAMPLE_PROOF[448..480].try_into().unwrap()),
        pk_y: BytesN::from_array(env, SAMPLE_PROOF[480..512].try_into().unwrap()),
        time: BytesN::from_array(env, SAMPLE_PROOF[512..544].try_into().unwrap()),
    }
}

fn tampered_commitment(env: &Env) -> BytesN<32> {
    let mut bad = [0u8; 32];
    bad.copy_from_slice(&SAMPLE_PROOF[384..416]);
    bad[31] ^= 1;
    BytesN::from_array(env, &bad)
}

// ---- Pure verification (no state) ----

#[test]
fn verifies_valid_kyc_proof() {
    let (env, client) = setup();
    let p = parse_proof(&env);
    assert!(client.verify(
        &p.a,
        &p.b,
        &p.c,
        &p.commitment,
        &p.nullifier,
        &p.pk_x,
        &p.pk_y,
        &p.time
    ));
}

#[test]
fn rejects_tampered_public_input() {
    let (env, client) = setup();
    let p = parse_proof(&env);
    let bad = tampered_commitment(&env);
    assert!(!client.verify(
        &p.a,
        &p.b,
        &p.c,
        &bad,
        &p.nullifier,
        &p.pk_x,
        &p.pk_y,
        &p.time
    ));
}

#[test]
fn rejects_wrong_anchor_key() {
    // Flipping the anchor public key (as if a different/untrusted anchor) must fail verification.
    let (env, client) = setup();
    let p = parse_proof(&env);
    let mut bad = [0u8; 32];
    bad.copy_from_slice(&SAMPLE_PROOF[448..480]);
    bad[0] ^= 1;
    let bad_pk_x = BytesN::from_array(&env, &bad);
    assert!(!client.verify(
        &p.a,
        &p.b,
        &p.c,
        &p.commitment,
        &p.nullifier,
        &bad_pk_x,
        &p.pk_y,
        &p.time
    ));
}

// ---- Stateful submit ----

#[test]
fn submit_records_valid_transfer() {
    let (env, client) = setup();
    let p = parse_proof(&env);
    assert!(!client.is_spent(&p.nullifier));
    client.submit(
        &p.a,
        &p.b,
        &p.c,
        &p.commitment,
        &p.nullifier,
        &p.pk_x,
        &p.pk_y,
        &p.time,
    );
    assert!(client.is_spent(&p.nullifier));
    assert!(client.is_committed(&p.commitment));
}

#[test]
fn submit_rejects_invalid_proof() {
    let (env, client) = setup();
    let p = parse_proof(&env);
    let bad = tampered_commitment(&env);
    let result = client.try_submit(
        &p.a,
        &p.b,
        &p.c,
        &bad,
        &p.nullifier,
        &p.pk_x,
        &p.pk_y,
        &p.time,
    );
    assert_eq!(result, Err(Ok(Error::InvalidProof)));
    assert!(!client.is_spent(&p.nullifier));
}

#[test]
fn submit_rejects_replayed_nullifier() {
    let (env, client) = setup();
    let p = parse_proof(&env);
    client.submit(
        &p.a,
        &p.b,
        &p.c,
        &p.commitment,
        &p.nullifier,
        &p.pk_x,
        &p.pk_y,
        &p.time,
    );
    let result = client.try_submit(
        &p.a,
        &p.b,
        &p.c,
        &p.commitment,
        &p.nullifier,
        &p.pk_x,
        &p.pk_y,
        &p.time,
    );
    assert_eq!(result, Err(Ok(Error::NullifierAlreadyUsed)));
}

// ---- Cost ----

#[test]
fn measure_verify_cost() {
    let (env, client) = setup();
    let p = parse_proof(&env);
    env.cost_estimate().budget().reset_default();
    let ok = client.verify(
        &p.a,
        &p.b,
        &p.c,
        &p.commitment,
        &p.nullifier,
        &p.pk_x,
        &p.pk_y,
        &p.time,
    );
    assert!(ok);
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let mem = env.cost_estimate().budget().memory_bytes_cost();
    std::println!("PROVA_V2_VERIFY_COST cpu_insns={cpu} mem_bytes={mem}");
    assert!(cpu < 100_000_000, "verify must fit the CPU budget");
}
