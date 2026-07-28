//! Prova prover CLI (Phase 3 — KYC-inclusive).
//!
//! Subcommands:
//!   (default)          setup + prove a KYC transfer; export VK + sample proof + anchor pubkey
//!   issue-credential   the anchor signs (user_id, kyc_level, expiry) → prints a credential as JSON
//!
//! Default flow:
//!   prova-prover --out DIR [--amount A] [--secret S] [--transfer-id T]
//!                [--kyc-level L] [--expiry E] [--now N] [--seed K] [--anchor-seed HEX]
//!
//! Credential issuance (used by the backend SEP-12 handoff):
//!   prova-prover issue-credential --user-id HEX --kyc-level L --expiry E [--anchor-seed HEX]
//!
//! Setup randomness is seeded for reproducible testnet artifacts (toxic waste — testnet only).

use std::fs;
use std::path::PathBuf;

use ark_bls12_381::{Bls12_381, Fr};
use ark_ed_on_bls12_381::Fr as JubjubFr;
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::Groth16;
use ark_snark::SNARK;
use ark_std::rand::{rngs::StdRng, SeedableRng};

use prova_prover::{credential, poseidon_config, soroban_ser, TransferCircuit};

/// Fixed dev anchor secret seed (32 bytes hex). The backend uses the same to reproduce the key.
const DEFAULT_ANCHOR_SEED: &str =
    "2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a";

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

// --- hex helpers (32-byte big-endian, matching Soroban scalar encoding) ---

fn fq_hex(f: &Fr) -> String {
    hex::encode(soroban_ser::fr_bytes(f))
}
fn fq_from_hex(s: &str) -> Fr {
    Fr::from_be_bytes_mod_order(&hex::decode(s).expect("hex"))
}
fn jfr_hex(f: &JubjubFr) -> String {
    let b = f.into_bigint().to_bytes_be();
    let mut o = [0u8; 32];
    o[32 - b.len()..].copy_from_slice(&b);
    hex::encode(o)
}
fn anchor_from_seed(seed_hex: &str) -> credential::AnchorKey {
    let sk = JubjubFr::from_be_bytes_mod_order(&hex::decode(seed_hex).expect("anchor seed hex"));
    credential::AnchorKey::from_secret(sk)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let sub = args.get(1).map(String::as_str).unwrap_or("");
    match sub {
        "issue-credential" => issue_credential(),
        "anchor-pubkey" => anchor_pubkey(),
        "prove-json" => prove_json_cmd(),
        "poseidon-params" => poseidon_params(),
        "user-id" => {
            let secret = arg("--secret", &fq_hex(&Fr::from(0u64)));
            println!(
                "{}",
                prova_prover::ffi::user_id_hex(&secret).expect("user-id")
            );
        }
        _ => setup_and_prove(),
    }
}

/// Dump the frozen Poseidon parameters as a flat binary blob, so the Soroban contract can embed the
/// *exact* constants the circuit uses. The on-chain Merkle tree and the in-circuit hash must agree
/// bit-for-bit, so these are exported from one source of truth rather than re-derived by hand.
///
/// Layout: `ark[rounds][width] ‖ mds[width][width]`, each element 32-byte big-endian.
/// Writes to `--out FILE` (default: stdout as hex).
fn poseidon_params() {
    use ark_ff::{BigInteger, PrimeField};
    let cfg = prova_prover::poseidon_config::<Fr>();
    let mut out: Vec<u8> = Vec::new();
    let mut push = |f: &Fr| {
        let b = f.into_bigint().to_bytes_be();
        let mut o = [0u8; 32];
        o[32 - b.len()..].copy_from_slice(&b);
        out.extend_from_slice(&o);
    };
    for row in &cfg.ark {
        for f in row {
            push(f);
        }
    }
    for row in &cfg.mds {
        for f in row {
            push(f);
        }
    }
    let path = arg("--out", "");
    eprintln!(
        "poseidon params: rounds={} width={} ark={}x{} mds={}x{} bytes={}",
        cfg.full_rounds + cfg.partial_rounds,
        cfg.rate + cfg.capacity,
        cfg.ark.len(),
        cfg.ark[0].len(),
        cfg.mds.len(),
        cfg.mds[0].len(),
        out.len()
    );
    if path.is_empty() {
        println!("{}", hex::encode(&out));
    } else {
        std::fs::write(&path, &out).expect("write params");
        eprintln!("wrote {}", path);
    }
}

/// Generate a proof from a JSON input (stdin or --input FILE) via the exact on-device FFI path.
/// Prints the 544-byte Soroban proof blob as hex. Used to verify the FFI path on the real contract.
fn prove_json_cmd() {
    let path = arg("--input", "");
    let input = if path.is_empty() {
        use std::io::Read;
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).expect("read stdin");
        s
    } else {
        std::fs::read_to_string(&path).expect("read input file")
    };
    match prova_prover::ffi::prove_json(&input) {
        Ok(h) => println!("{h}"),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}

/// Print the anchor's Jubjub public key `{x, y}` as JSON (for the backend's trusted-anchor set).
fn anchor_pubkey() {
    let anchor = anchor_from_seed(&arg("--anchor-seed", DEFAULT_ANCHOR_SEED));
    println!(
        "{{\"x\":\"{}\",\"y\":\"{}\"}}",
        fq_hex(&anchor.pk.x),
        fq_hex(&anchor.pk.y),
    );
}

/// The anchor signs (user_id, kyc_level, expiry) and prints the credential + anchor pubkey as JSON.
fn issue_credential() {
    let cfg = poseidon_config::<Fr>();
    let anchor = anchor_from_seed(&arg("--anchor-seed", DEFAULT_ANCHOR_SEED));
    let user_id = fq_from_hex(&arg("--user-id", &fq_hex(&Fr::from(0u64))));
    let kyc_level: u64 = arg("--kyc-level", "2").parse().expect("kyc-level");
    let expiry: u64 = arg("--expiry", "2000000000").parse().expect("expiry");

    let mut rng = StdRng::from_entropy();
    let cred = credential::issue(&cfg, &anchor, user_id, kyc_level, expiry, &mut rng);

    println!(
        "{{\"userId\":\"{}\",\"kycLevel\":{},\"expiry\":{},\"sigRx\":\"{}\",\"sigRy\":\"{}\",\"sigS\":\"{}\",\"anchorPkX\":\"{}\",\"anchorPkY\":\"{}\"}}",
        fq_hex(&user_id),
        kyc_level,
        expiry,
        fq_hex(&cred.sig.r.x),
        fq_hex(&cred.sig.r.y),
        jfr_hex(&cred.sig.s),
        fq_hex(&anchor.pk.x),
        fq_hex(&anchor.pk.y),
    );
}

/// Setup + prove a KYC transfer; export the VK, a sample proof, and the anchor public key.
fn setup_and_prove() {
    let out = PathBuf::from(arg("--out", "artifacts"));
    let amount: u64 = arg("--amount", "4200").parse().expect("amount");
    let secret: u64 = arg("--secret", "987654321").parse().expect("secret");
    let transfer_id: u64 = arg("--transfer-id", "555").parse().expect("transfer-id");
    let kyc_level: u64 = arg("--kyc-level", "2").parse().expect("kyc-level");
    let expiry: u64 = arg("--expiry", "2000000000").parse().expect("expiry");
    let now: u64 = arg("--now", "1700000000").parse().expect("now");
    let seed: u64 = arg("--seed", "42").parse().expect("seed");
    let anchor_seed = arg("--anchor-seed", DEFAULT_ANCHOR_SEED);

    fs::create_dir_all(&out).expect("create out dir");
    let cfg = poseidon_config::<Fr>();
    let anchor = anchor_from_seed(&anchor_seed);

    // Anchor issues a credential for this user (user_id bound to the transfer secret).
    let secret_fr = Fr::from(secret);
    let user_id = credential::user_id(&cfg, secret_fr);
    let mut cred_rng = StdRng::seed_from_u64(seed ^ 0xC0FFEE);
    let cred = credential::issue(&cfg, &anchor, user_id, kyc_level, expiry, &mut cred_rng);

    // Build the circuit and prove.
    let circuit = TransferCircuit::new(
        cfg,
        Fr::from(amount),
        secret_fr,
        Fr::from(transfer_id),
        &cred,
        anchor.pk,
        now,
    );
    let public = circuit.public_inputs().expect("public inputs");

    // Use the SAME key source as the on-device prover (setup_keys → dummy_circuit) so the deployed
    // VK and the FFI proving key are a matched pair.
    let (pk, vk) = prova_prover::setup_keys(seed);
    let mut rng = StdRng::seed_from_u64(seed.wrapping_add(1));
    let proof = Groth16::<Bls12_381>::prove(&pk, circuit, &mut rng).expect("prove");

    let ok = Groth16::<Bls12_381>::verify(&vk, &public, &proof).expect("verify");
    assert!(
        ok,
        "off-chain verification failed — refusing to write artifacts"
    );

    // Export Soroban-encoded blobs.
    let vk_blob = soroban_ser::verifying_key_blob(&vk);
    let proof_blob = soroban_ser::proof_blob(&proof, &public);
    let mut anchor_pk = Vec::new();
    anchor_pk.extend_from_slice(&soroban_ser::fr_bytes(&anchor.pk.x));
    anchor_pk.extend_from_slice(&soroban_ser::fr_bytes(&anchor.pk.y));

    fs::write(out.join("verifying_key.bin"), &vk_blob).expect("write vk");
    fs::write(out.join("sample_proof.bin"), &proof_blob).expect("write proof");
    fs::write(out.join("anchor_pubkey.bin"), &anchor_pk).expect("write anchor pubkey");

    println!("off-chain verify: OK ({} public inputs)", public.len());
    println!(
        "  commitment={} nullifier={}",
        fq_hex(&public[0]),
        fq_hex(&public[1])
    );
    println!(
        "wrote {} ({} bytes)  [alpha 96 | -beta/-gamma/-delta 192 | IC {}x96]",
        out.join("verifying_key.bin").display(),
        vk_blob.len(),
        vk.gamma_abc_g1.len()
    );
    println!(
        "wrote {} ({} bytes)  [A 96 | B 192 | C 96 | {} public inputs x32]",
        out.join("sample_proof.bin").display(),
        proof_blob.len(),
        public.len()
    );
    println!(
        "wrote {} (64 bytes anchor pubkey x‖y)",
        out.join("anchor_pubkey.bin").display()
    );
}
