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
        "pool-artifacts" => pool_artifacts(),
        "merkle-path" => merkle_path_cmd(),
        "fold-prove" => fold_prove_cmd(),
        "poseidon-hash2" => poseidon_hash2_cmd(),
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

/// `Poseidon(a, b)` — the exact 2->1 compression the circuit and the on-chain Merkle tree both use.
/// Ground truth for the contract's Poseidon test vectors, and the hash the backend indexer shells out
/// for so it never grows a second implementation that could drift.
fn poseidon_hash2_cmd() {
    let cfg = poseidon_config::<Fr>();
    let a = fq_from_hex(&arg("--a", &fq_hex(&Fr::from(0u64))));
    let b = fq_from_hex(&arg("--b", &fq_hex(&Fr::from(0u64))));
    println!("{}", fq_hex(&prova_prover::poseidon_hash2(&cfg, a, b)));
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

/// Generate every artifact the pool contract needs: the three verifying keys, and a full
/// shield → fold → transact → fold → unshield → fold run as real proofs.
///
/// The contract's tests replay these blobs against the deployed verifier, so a change that breaks
/// circuit/contract agreement fails there rather than on testnet. Public inputs are appended to each
/// proof blob, so the tests need no separate manifest — the blob is self-describing.
///
///   prova-prover pool-artifacts --out contracts/pool/src/artifacts [--seed 42]
fn pool_artifacts() {
    use ark_ff::Zero;
    use ark_ed_on_bls12_381::Fr as JubjubScalar;
    use prova_prover::pool::{
        encryption::EncKey,
        fold::FoldCircuit,
        owner_pk, setup,
        shield::ShieldCircuit,
        spend::{SpendCircuit, SpendOutput},
        tree::MerkleTree,
        Note, BATCH,
    };

    let out = PathBuf::from(arg("--out", "artifacts"));
    let seed: u64 = arg("--seed", "42").parse().expect("seed");
    fs::create_dir_all(&out).expect("create out dir");

    let cfg = poseidon_config::<Fr>();
    let anchor = anchor_from_seed(&arg("--anchor-seed", DEFAULT_ANCHOR_SEED));
    let mut rng = StdRng::seed_from_u64(seed.wrapping_add(1));

    // --- verifying keys ---
    let (spend_pk, spend_vk) = setup::spend(seed);
    let (shield_pk, shield_vk) = setup::shield(seed);
    let (fold_pk, fold_vk) = setup::fold(seed);
    for (name, vk) in [
        ("spend_vk.bin", &spend_vk),
        ("shield_vk.bin", &shield_vk),
        ("fold_vk.bin", &fold_vk),
    ] {
        let blob = soroban_ser::verifying_key_blob(vk);
        fs::write(out.join(name), &blob).expect("write vk");
        println!(
            "wrote {:<16} {:>5} bytes  IC={}",
            name,
            blob.len(),
            vk.gamma_abc_g1.len()
        );
    }

    // A proof, verified off-chain before it is written — never ship an artifact that does not verify.
    macro_rules! prove {
        ($name:expr, $pk:expr, $vk:expr, $circuit:expr) => {{
            let c = $circuit;
            let public = c.public_inputs().expect("public inputs");
            let proof = Groth16::<Bls12_381>::prove(&$pk, c, &mut rng).expect("prove");
            assert!(
                Groth16::<Bls12_381>::verify(&$vk, &public, &proof).expect("verify"),
                "{} failed off-chain verification — refusing to write it",
                $name
            );
            let blob = soroban_ser::proof_blob(&proof, &public);
            fs::write(out.join($name), &blob).expect("write proof");
            println!(
                "wrote {:<16} {:>5} bytes  {} public inputs",
                $name,
                blob.len(),
                public.len()
            );
            public
        }};
    }

    // ------------------------------------------------------------------
    // The scenario the contract tests replay.
    // ------------------------------------------------------------------
    let owner_sk = Fr::from(1234567u64);
    let pk = owner_pk(&cfg, owner_sk);
    // The wallet's note-encryption key (Jubjub), derived from the same master seed in the real app.
    let enc = EncKey::from_secret(JubjubScalar::from(0xE9C_u64));
    let user_id = credential::user_id(&cfg, owner_sk);
    let mut cred_rng = StdRng::seed_from_u64(seed ^ 0xC0FFEE);
    let cred = credential::issue(&cfg, &anchor, user_id, 2, 2_000_000_000, &mut cred_rng);
    let now: u64 = 1_700_000_000;

    // 1. Shield 1000 into a fresh note.
    let deposit: u64 = 1000;
    let rho0 = Fr::from(1001u64);
    let note0 = Note::new(deposit, pk, rho0);
    let c0 = note0.commitment(&cfg);
    prove!(
        "shield_proof.bin",
        shield_pk,
        shield_vk,
        ShieldCircuit::new(cfg.clone(), deposit, pk, rho0, enc.pk, JubjubScalar::from(0xE0u64))
    );

    // 2. Fold it in — only now is it spendable.
    let mut tree = MerkleTree::new(&cfg);
    let (f1, tree1) = FoldCircuit::from_tree(&cfg, &tree, &[c0]);
    prove!("fold1_proof.bin", fold_pk, fold_vk, f1);
    tree = tree1;

    // 3. Private transfer: 1000 -> 600 recipient + 400 change, nothing leaves the pool.
    let out1 = Note::new(600, pk, Fr::from(2001u64));
    let out2 = Note::new(400, pk, Fr::from(2002u64));
    prove!(
        "spend_proof.bin",
        spend_pk,
        spend_vk,
        SpendCircuit::new(
            cfg.clone(),
            deposit,
            rho0,
            owner_sk,
            &tree.path(0),
            SpendOutput::new(out1, enc.pk),
            SpendOutput::new(out2, enc.pk),
            JubjubScalar::from(0xE1u64),
            0,
            Fr::zero(),
            &cred,
            anchor.pk,
            now,
        )
    );

    // 4. Fold both outputs in.
    let (f2, tree2) = FoldCircuit::from_tree(&cfg, &tree, &[out1.commitment(&cfg), out2.commitment(&cfg)]);
    prove!("fold2_proof.bin", fold_pk, fold_vk, f2);
    let root_after_fold2 = tree2.root();
    tree = tree2;

    // 5. Unshield the 600 note to a public destination; nothing stays behind.
    let destination = Fr::from(0xD0D0_CAFEu64);
    prove!(
        "unshield_proof.bin",
        spend_pk,
        spend_vk,
        SpendCircuit::new(
            cfg.clone(),
            600,
            out1.rho,
            owner_sk,
            &tree.path(1),
            SpendOutput::new(Note::new(0, pk, Fr::from(3001u64)), enc.pk),
            SpendOutput::new(Note::new(0, pk, Fr::from(3002u64)), enc.pk),
            JubjubScalar::from(0xE2u64),
            600,
            destination,
            &cred,
            anchor.pk,
            now,
        )
    );

    // 6. A chain of single-leaf folds, long enough to push `root_after_fold2` out of the 32-root
    //    history window — this is what lets the contract test prove that an *evicted* root is
    //    rejected while a merely stale one is still accepted.
    let history = prova_prover::pool::ROOT_HISTORY;
    let mut chain = Vec::new();
    for i in 0..(history + 1) {
        let leaf = Fr::from(50_000u64 + i as u64);
        let (fc, next) = FoldCircuit::from_tree(&cfg, &tree, &[leaf]);
        let public = fc.public_inputs().expect("public inputs");
        let proof = Groth16::<Bls12_381>::prove(&fold_pk, fc, &mut rng).expect("prove");
        assert!(Groth16::<Bls12_381>::verify(&fold_vk, &public, &proof).expect("verify"));
        chain.extend_from_slice(&soroban_ser::proof_blob(&proof, &public));
        tree = next;
    }
    fs::write(out.join("fold_chain.bin"), &chain).expect("write fold chain");
    println!(
        "wrote {:<16} {:>5} bytes  {} folds of 1 leaf (evicts the {}-root window)",
        "fold_chain.bin",
        chain.len(),
        history + 1,
        history
    );

    // The empty tree's root — `zeros[DEPTH]`. The contract starts here and can never derive it
    // itself (that would need 20 Poseidon hashes), so it is embedded.
    let empty_root = prova_prover::pool::zero_hashes(&cfg)[prova_prover::pool::DEPTH];
    fs::write(
        out.join("empty_root.bin"),
        soroban_ser::fr_bytes(&empty_root),
    )
    .expect("write empty root");
    println!(
        "wrote {:<16} {:>5} bytes  zeros[{}] = {}",
        "empty_root.bin",
        32,
        prova_prover::pool::DEPTH,
        fq_hex(&empty_root)
    );

    // Anchor public key, so the contract can pin its trusted-anchor set.
    let mut anchor_pk_bytes = Vec::new();
    anchor_pk_bytes.extend_from_slice(&soroban_ser::fr_bytes(&anchor.pk.x));
    anchor_pk_bytes.extend_from_slice(&soroban_ser::fr_bytes(&anchor.pk.y));
    fs::write(out.join("anchor_pubkey.bin"), &anchor_pk_bytes).expect("write anchor");

    println!(
        "\nscenario: shield {deposit} -> fold -> transact (600+400) -> fold -> unshield 600\n\
         batch={BATCH} root_history={history} root_after_fold2={}",
        fq_hex(&root_after_fold2)
    );
}

// ---------------------------------------------------------------------------
// Backend-facing commands
//
// The indexer and the folder both need the pool's Merkle tree. Rather than reimplement Poseidon and
// the tree in Go — where it could silently drift from the circuit and make every note unspendable —
// the backend shells out to these, exactly as it already does for credential issuance.
// ---------------------------------------------------------------------------

/// Membership path for one leaf, so a wallet can build a spend proof.
///
///   prova-prover merkle-path --input path.json     (or stdin)
///   in:  {"leaves":["<hex>",...], "index": 3}
///   out: {"leafIndex":3, "siblings":["<hex>",...], "root":"<hex>"}
///
/// `leaves` is every commitment folded into the tree, in leaf order — the indexer's table. The tree
/// is rebuilt per call, which is O(n) and therefore fine at MVP volumes but is the first thing to
/// make incremental if path latency ever matters.
fn merkle_path_cmd() {
    use prova_prover::pool::tree::MerkleTree;

    #[derive(serde::Deserialize)]
    struct Input {
        leaves: Vec<String>,
        index: u64,
    }

    let input: Input = serde_json::from_str(&read_input()).expect("parse merkle-path input");
    let cfg = poseidon_config::<Fr>();
    let mut tree = MerkleTree::new(&cfg);
    for leaf in &input.leaves {
        tree.insert(fq_from_hex(leaf));
    }
    if input.index >= tree.next_index() {
        eprintln!(
            "error: leaf {} is not in the tree ({} leaves)",
            input.index,
            tree.next_index()
        );
        std::process::exit(1);
    }

    let path = tree.path(input.index);
    let siblings: Vec<String> = path.siblings.iter().map(fq_hex).collect();
    println!(
        "{{\"leafIndex\":{},\"siblings\":[{}],\"root\":\"{}\"}}",
        path.leaf_index,
        siblings
            .iter()
            .map(|s| format!("\"{s}\""))
            .collect::<Vec<_>>()
            .join(","),
        fq_hex(&path.root)
    );
}

/// Prove that appending `new` commitments advances the tree — the folder's whole job.
///
///   prova-prover fold-prove --input fold.json [--pk-cache FILE] [--seed 42]
///   in:  {"leaves":["<hex>",...], "new":["<hex>",...]}
///   out: {"proof":"<hex>", "oldRoot":"…", "newRoot":"…", "startIndex":N, "count":N}
///
/// `proof` is `A(96) ‖ B(192) ‖ C(96)`; the contract rebuilds the public inputs from its own queue,
/// which is precisely what stops a folder inserting commitments that were never queued.
fn fold_prove_cmd() {
    use prova_prover::pool::{fold::FoldCircuit, tree::MerkleTree, BATCH};

    #[derive(serde::Deserialize)]
    struct Input {
        leaves: Vec<String>,
        new: Vec<String>,
    }

    let input: Input = serde_json::from_str(&read_input()).expect("parse fold-prove input");
    if input.new.is_empty() || input.new.len() > BATCH {
        eprintln!("error: a fold carries 1..={BATCH} leaves, got {}", input.new.len());
        std::process::exit(1);
    }

    let cfg = poseidon_config::<Fr>();
    let mut tree = MerkleTree::new(&cfg);
    for leaf in &input.leaves {
        tree.insert(fq_from_hex(leaf));
    }

    let new: Vec<Fr> = input.new.iter().map(|h| fq_from_hex(h)).collect();
    let (circuit, next) = FoldCircuit::from_tree(&cfg, &tree, &new);
    let public = circuit.public_inputs().expect("public inputs");

    let seed: u64 = arg("--seed", "42").parse().expect("seed");
    let pk = load_or_build_fold_key(seed);
    let mut rng = StdRng::from_entropy();
    let proof = Groth16::<Bls12_381>::prove(&pk, circuit, &mut rng).expect("prove");

    // Never emit a proof that does not verify — a bad fold would stall the pool until someone
    // noticed, and the failure would surface as an opaque on-chain rejection. The verifying key
    // travels inside the proving key, so this costs nothing beyond the check itself.
    assert!(
        Groth16::<Bls12_381>::verify(&pk.vk, &public, &proof).expect("verify"),
        "fold proof failed off-chain verification — refusing to emit it"
    );

    let mut blob = Vec::new();
    blob.extend_from_slice(&soroban_ser::g1_bytes(&proof.a));
    blob.extend_from_slice(&soroban_ser::g2_bytes(&proof.b));
    blob.extend_from_slice(&soroban_ser::g1_bytes(&proof.c));

    println!(
        "{{\"proof\":\"{}\",\"oldRoot\":\"{}\",\"newRoot\":\"{}\",\"startIndex\":{},\"count\":{}}}",
        hex::encode(&blob),
        fq_hex(&public[0]),
        fq_hex(&public[1]),
        tree.next_index(),
        new.len()
    );
    let _ = next;
}

/// The fold proving key, cached to disk if `--pk-cache` is given.
///
/// Generating it takes ~1.4 s. A folder runs every few seconds, so paying that on every invocation
/// would dominate its latency. The setup is seeded and deterministic, so the cache is a pure
/// speed-up — deleting the file only costs time, never correctness.
fn load_or_build_fold_key(seed: u64) -> ark_groth16::ProvingKey<Bls12_381> {
    use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};

    let cache = arg("--pk-cache", "");
    if !cache.is_empty() {
        if let Ok(bytes) = fs::read(&cache) {
            // Uncompressed and unvalidated on purpose. Compressed form was measured at ~11 s to load
            // — decompressing millions of curve points costs a modular square root each, far more
            // than the ~1.5 s of simply regenerating the key. Subgroup validation is skipped for the
            // same reason; a corrupted cache can only produce a proof that fails the off-chain
            // verification below, so it costs a retry rather than correctness.
            if let Ok(pk) = ark_groth16::ProvingKey::<Bls12_381>::deserialize_with_mode(
                &bytes[..],
                Compress::No,
                Validate::No,
            ) {
                return pk;
            }
            eprintln!("warning: {cache} is unreadable, regenerating");
        }
    }

    let (pk, _) = prova_prover::pool::setup::fold(seed);
    if !cache.is_empty() {
        let mut bytes = Vec::new();
        if pk.serialize_uncompressed(&mut bytes).is_ok() {
            let _ = fs::write(&cache, &bytes);
        }
    }
    pk
}

/// Read a JSON payload from `--input FILE`, or stdin when the flag is absent.
fn read_input() -> String {
    let path = arg("--input", "");
    if path.is_empty() {
        use std::io::Read;
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).expect("read stdin");
        s
    } else {
        fs::read_to_string(&path).expect("read input file")
    }
}
