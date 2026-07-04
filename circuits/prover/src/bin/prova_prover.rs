//! Prova Phase 1 prover CLI.
//!
//! Runs the BLS12-381 Groth16 trusted setup, proves one transfer, verifies it off-chain, and
//! writes two byte blobs in Soroban's BLS12-381 encoding:
//!   - `verifying_key.bin` — embedded by the on-chain verifier contract
//!   - `sample_proof.bin`  — a valid proof + public inputs, used as the contract's test vector
//!
//! Usage:
//!   prova-prover --out DIR [--amount A] [--secret S] [--transfer-id T] [--seed N]
//!
//! NOTE: the setup randomness here is seeded for reproducible testnet artifacts. This is the
//! "toxic waste" — acceptable for testnet only. Mainnet uses the public ceremony (Phase 5).

use std::fs;
use std::path::PathBuf;

use ark_bls12_381::{Bls12_381, Fr};
use ark_groth16::Groth16;
use ark_snark::SNARK;
use ark_std::rand::{rngs::StdRng, SeedableRng};

use prova_prover::{poseidon_config, soroban_ser, TransferCircuit};

fn arg(name: &str, default: &str) -> String {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len() {
        if args[i] == name {
            if let Some(v) = args.get(i + 1) {
                return v.clone();
            }
        }
    }
    default.to_string()
}

fn main() {
    let out = PathBuf::from(arg("--out", "artifacts"));
    let amount: u64 = arg("--amount", "4200").parse().expect("amount");
    let secret: u64 = arg("--secret", "987654321").parse().expect("secret");
    let transfer_id: u64 = arg("--transfer-id", "555").parse().expect("transfer-id");
    let seed: u64 = arg("--seed", "42").parse().expect("seed");

    fs::create_dir_all(&out).expect("create out dir");
    let mut rng = StdRng::seed_from_u64(seed);
    let cfg = poseidon_config::<Fr>();

    // Trusted setup (structure is value-independent; use a valid dummy assignment).
    let setup_circuit =
        TransferCircuit::from_inputs(cfg.clone(), Fr::from(1u64), Fr::from(1u64), Fr::from(1u64));
    let (pk, vk) =
        Groth16::<Bls12_381>::circuit_specific_setup(setup_circuit, &mut rng).expect("setup");

    // Prove the requested transfer.
    let circuit = TransferCircuit::from_inputs(
        cfg,
        Fr::from(amount),
        Fr::from(secret),
        Fr::from(transfer_id),
    );
    let public = circuit.public_inputs().expect("public inputs");
    let (commitment, nullifier) = (public[0], public[1]);
    let proof = Groth16::<Bls12_381>::prove(&pk, circuit, &mut rng).expect("prove");

    // Sanity: it must verify off-chain before we ship it on-chain.
    let ok = Groth16::<Bls12_381>::verify(&vk, &public, &proof).expect("verify");
    assert!(
        ok,
        "off-chain verification failed — refusing to write artifacts"
    );

    // Export Soroban-encoded blobs.
    let vk_blob = soroban_ser::verifying_key_blob(&vk);
    let proof_blob = soroban_ser::proof_blob(&proof, &commitment, &nullifier);
    let vk_path = out.join("verifying_key.bin");
    let proof_path = out.join("sample_proof.bin");
    fs::write(&vk_path, &vk_blob).expect("write vk");
    fs::write(&proof_path, &proof_blob).expect("write proof");

    println!("off-chain verify: OK");
    println!(
        "public inputs: {} (commitment), {} (nullifier)",
        commitment, nullifier
    );
    println!(
        "wrote {} ({} bytes)  [alpha 96 | -beta 192 | -gamma 192 | -delta 192 | IC {}x96]",
        vk_path.display(),
        vk_blob.len(),
        vk.gamma_abc_g1.len()
    );
    println!(
        "wrote {} ({} bytes)  [A 96 | B 192 | C 96 | commitment 32 | nullifier 32]",
        proof_path.display(),
        proof_blob.len()
    );
}
