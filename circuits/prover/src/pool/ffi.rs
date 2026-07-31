//! The on-device pool API — everything the wallet asks the native layer to do.
//!
//! Four operations, and each is here rather than in TypeScript for a specific reason:
//!
//! | Operation | Why it must be native |
//! |---|---|
//! | [`keys_json`] | Key derivation must match the circuit's field arithmetic exactly |
//! | [`shield_prove_json`] | Groth16 proving; JS cannot do it at any acceptable speed |
//! | [`spend_prove_json`] | Same, and the secrets must never cross the bridge |
//! | [`scan_json`] | Trial decryption is a Jubjub scalar multiplication *per note* |
//!
//! Scanning is the one that would be tempting to write in JS and shouldn't be. A wallet trial-opens
//! every note in the feed, so a slow implementation makes startup crawl — and a second Jubjub
//! implementation in TypeScript would be a fresh chance to drift from the circuit, which does not
//! fail loudly. It makes notes invisible.
//!
//! Everything crosses the bridge as JSON strings, matching the existing `ffi` module. **Secrets stay
//! on the device**: the seed goes in, proofs and opened notes come out.

use ark_bls12_381::{Bls12_381, Fr};
use ark_ed_on_bls12_381::{EdwardsAffine, Fr as JubjubFr};
use ark_ff::PrimeField;
use ark_groth16::{Groth16, ProvingKey};
use ark_snark::SNARK;
use ark_std::rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use super::{
    encryption::{self, EncryptedNote},
    keys,
    shield::ShieldCircuit,
    spend::{SpendCircuit, SpendOutput},
    tree::MerklePath,
    Note,
};
use crate::{credential, poseidon_config, soroban_ser, SETUP_SEED};

// ---------------------------------------------------------------------------
// Proving keys — derived once, on first use.
// ---------------------------------------------------------------------------

/// The spend proving key. Deterministic, so it matches the verifying key embedded in the contract.
///
/// Deriving it is the slowest thing the wallet ever does, which is why it is cached for the process
/// lifetime and why [`warm_up`] exists: paying it during app start is invisible, paying it inside a
/// user's first send is not.
fn spend_key() -> &'static ProvingKey<Bls12_381> {
    static PK: OnceLock<ProvingKey<Bls12_381>> = OnceLock::new();
    PK.get_or_init(|| super::setup::spend(SETUP_SEED).0)
}

fn shield_key() -> &'static ProvingKey<Bls12_381> {
    static PK: OnceLock<ProvingKey<Bls12_381>> = OnceLock::new();
    PK.get_or_init(|| super::setup::shield(SETUP_SEED).0)
}

/// Derive both proving keys now, so the first real operation is not the one that pays for it.
/// Call from a background thread at app start.
pub fn warm_up() -> Result<String, String> {
    let _ = spend_key();
    let _ = shield_key();
    Ok("ok".into())
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

fn fr_from_hex(s: &str) -> Result<Fr, String> {
    let b = hex::decode(s).map_err(|_| format!("not hex: {s}"))?;
    Ok(Fr::from_be_bytes_mod_order(&b))
}

fn fr_hex(f: &Fr) -> String {
    hex::encode(soroban_ser::fr_bytes(f))
}

fn jubjub_from_hex(s: &str) -> Result<JubjubFr, String> {
    let b = hex::decode(s).map_err(|_| format!("not hex: {s}"))?;
    Ok(JubjubFr::from_be_bytes_mod_order(&b))
}

fn point(x: &str, y: &str) -> Result<EdwardsAffine, String> {
    Ok(EdwardsAffine::new_unchecked(
        fr_from_hex(x)?,
        fr_from_hex(y)?,
    ))
}

// ---------------------------------------------------------------------------
// 1. Keys
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct KeysIn {
    /// The wallet's master seed, hex. Never leaves the device.
    seed: String,
}

#[derive(Serialize)]
struct KeysOut {
    owner_sk: String,
    owner_pk: String,
    enc_sk: String,
    enc_pk_x: String,
    enc_pk_y: String,
}

/// Derive the wallet's pool keys from its master seed.
///
/// `ownerSk` and `encSk` are returned so the app can keep them in the enclave alongside the seed;
/// they never go to a server. `ownerPk` + `encPk` together are the shareable address.
pub fn keys_json(input: &str) -> Result<String, String> {
    let arg: KeysIn = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let seed = hex::decode(&arg.seed).map_err(|_| "seed must be hex".to_string())?;
    if seed.len() < 16 {
        return Err("seed must be at least 16 bytes".into());
    }

    let cfg = poseidon_config::<Fr>();
    let k = keys::derive(&cfg, &seed);
    let mut enc_sk = [0u8; 32];
    let bytes = {
        use ark_ff::BigInteger;
        k.enc.sk.into_bigint().to_bytes_be()
    };
    enc_sk[32 - bytes.len()..].copy_from_slice(&bytes);

    serde_json::to_string(&KeysOut {
        owner_sk: fr_hex(&k.owner_sk),
        owner_pk: fr_hex(&k.owner_pk),
        enc_sk: hex::encode(enc_sk),
        enc_pk_x: fr_hex(&k.enc.pk.x),
        enc_pk_y: fr_hex(&k.enc.pk.y),
    })
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 2. Shield
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ShieldIn {
    amount: u64,
    owner_pk: String,
    rho: String,
    enc_pk_x: String,
    enc_pk_y: String,
    /// Fresh ephemeral secret. **Must be random per deposit** — reuse repeats the one-time pad.
    esk: String,
}

#[derive(Serialize)]
struct ShieldOut {
    proof: String,
    commitment: String,
    epk_x: String,
    epk_y: String,
    enc_amount: String,
    enc_rho: String,
}

/// Prove a deposit's commitment binds the amount being deposited.
///
/// Without this the contract cannot check the commitment at all (it cannot compute Poseidon), and a
/// user could deposit 100 while committing to a million.
pub fn shield_prove_json(input: &str) -> Result<String, String> {
    let arg: ShieldIn = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let cfg = poseidon_config::<Fr>();

    let circuit = ShieldCircuit::new(
        cfg,
        arg.amount,
        fr_from_hex(&arg.owner_pk)?,
        fr_from_hex(&arg.rho)?,
        point(&arg.enc_pk_x, &arg.enc_pk_y)?,
        jubjub_from_hex(&arg.esk)?,
    );
    debug_assert_eq!(
        circuit.public_inputs().map(|p| p.len()),
        Some(7),
        "shield has 7 public inputs"
    );
    let enc = circuit.enc.ok_or("no encrypted note")?;
    let commitment = circuit.commitment.ok_or("no commitment")?;

    let proof = Groth16::<Bls12_381>::prove(shield_key(), circuit, &mut OsRng)
        .map_err(|e| format!("prove: {e}"))?;

    serde_json::to_string(&ShieldOut {
        proof: hex::encode(proof_abc(&proof)),
        commitment: fr_hex(&commitment),
        epk_x: fr_hex(&enc.epk.x),
        epk_y: fr_hex(&enc.epk.y),
        enc_amount: fr_hex(&enc.c_amount),
        enc_rho: fr_hex(&enc.c_rho),
    })
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 3. Spend
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SpendNoteIn {
    amount: u64,
    /// Recipient's pool address.
    owner_pk: String,
    rho: String,
    enc_pk_x: String,
    enc_pk_y: String,
}

#[derive(Deserialize)]
struct SpendIn {
    /// The note being spent.
    in_amount: u64,
    in_rho: String,
    owner_sk: String,
    /// Its membership path, from `GET /pool/path/{commitment}`.
    leaf_index: u64,
    siblings: Vec<String>,
    root: String,
    /// The two notes being created: recipient, then change.
    out1: SpendNoteIn,
    out2: SpendNoteIn,
    /// Fresh per transfer. **Must be random** — reuse repeats the one-time pad across transfers.
    esk: String,
    /// 0 for a private transfer; the amount leaving the pool for an unshield.
    public_amount: u64,
    /// Payout destination as a field element, from the contract's `destination_field`. "0" (or
    /// empty) for a private transfer — the circuit rejects a private transfer that names one.
    destination: String,
    // KYC credential.
    kyc_level: u64,
    expiry: u64,
    sig_rx: String,
    sig_ry: String,
    sig_s: String,
    anchor_pk_x: String,
    anchor_pk_y: String,
    current_time: u64,
}

#[derive(Serialize)]
struct SpendOut {
    proof: String,
    nullifier: String,
    out_c1: String,
    out_c2: String,
    epk_x: String,
    epk_y: String,
    enc1_amount: String,
    enc1_rho: String,
    enc2_amount: String,
    enc2_rho: String,
}

/// Prove a spend: one note in, two notes out, value conserved, KYC valid.
///
/// This is the proof that makes a transfer private, and the heaviest thing the wallet does.
pub fn spend_prove_json(input: &str) -> Result<String, String> {
    let arg: SpendIn = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let cfg = poseidon_config::<Fr>();

    if arg.siblings.len() != super::DEPTH {
        return Err(format!(
            "expected {} siblings, got {}",
            super::DEPTH,
            arg.siblings.len()
        ));
    }
    let siblings = arg
        .siblings
        .iter()
        .map(|s| fr_from_hex(s))
        .collect::<Result<Vec<_>, _>>()?;

    let path = MerklePath {
        leaf_index: arg.leaf_index,
        siblings,
        root: fr_from_hex(&arg.root)?,
    };

    let cred = credential::Credential {
        user_id: credential::user_id(&cfg, fr_from_hex(&arg.owner_sk)?),
        kyc_level: arg.kyc_level,
        expiry: arg.expiry,
        sig: credential::Signature {
            r: point(&arg.sig_rx, &arg.sig_ry)?,
            s: jubjub_from_hex(&arg.sig_s)?,
        },
    };

    let out1 = SpendOutput::new(
        Note::new(
            arg.out1.amount,
            fr_from_hex(&arg.out1.owner_pk)?,
            fr_from_hex(&arg.out1.rho)?,
        ),
        point(&arg.out1.enc_pk_x, &arg.out1.enc_pk_y)?,
    );
    let out2 = SpendOutput::new(
        Note::new(
            arg.out2.amount,
            fr_from_hex(&arg.out2.owner_pk)?,
            fr_from_hex(&arg.out2.rho)?,
        ),
        point(&arg.out2.enc_pk_x, &arg.out2.enc_pk_y)?,
    );

    let destination = if arg.destination.is_empty() {
        Fr::from(0u64)
    } else {
        fr_from_hex(&arg.destination)?
    };

    let circuit = SpendCircuit::new(
        cfg,
        arg.in_amount,
        fr_from_hex(&arg.in_rho)?,
        fr_from_hex(&arg.owner_sk)?,
        &path,
        out1,
        out2,
        jubjub_from_hex(&arg.esk)?,
        arg.public_amount,
        destination,
        &cred,
        point(&arg.anchor_pk_x, &arg.anchor_pk_y)?,
        arg.current_time,
    );

    let nullifier = circuit.nullifier.ok_or("no nullifier")?;
    let c1 = circuit.out_c1.ok_or("no output 1")?;
    let c2 = circuit.out_c2.ok_or("no output 2")?;
    let enc1 = circuit.enc1.ok_or("no payload 1")?;
    let enc2 = circuit.enc2.ok_or("no payload 2")?;

    let proof = Groth16::<Bls12_381>::prove(spend_key(), circuit, &mut OsRng)
        .map_err(|e| format!("prove: {e}"))?;

    serde_json::to_string(&SpendOut {
        proof: hex::encode(proof_abc(&proof)),
        nullifier: fr_hex(&nullifier),
        out_c1: fr_hex(&c1),
        out_c2: fr_hex(&c2),
        epk_x: fr_hex(&enc1.epk.x),
        epk_y: fr_hex(&enc1.epk.y),
        enc1_amount: fr_hex(&enc1.c_amount),
        enc1_rho: fr_hex(&enc1.c_rho),
        enc2_amount: fr_hex(&enc2.c_amount),
        enc2_rho: fr_hex(&enc2.c_rho),
    })
    .map_err(|e| e.to_string())
}

/// `A(96) ‖ B(192) ‖ C(96)` — the contract's `Proof` struct. Public inputs are rebuilt by the caller
/// (the contract, or the relayer) from values it already holds, so they are not repeated here.
fn proof_abc(proof: &ark_groth16::Proof<Bls12_381>) -> Vec<u8> {
    let mut v = Vec::with_capacity(384);
    v.extend_from_slice(&soroban_ser::g1_bytes(&proof.a));
    v.extend_from_slice(&soroban_ser::g2_bytes(&proof.b));
    v.extend_from_slice(&soroban_ser::g1_bytes(&proof.c));
    v
}

// ---------------------------------------------------------------------------
// 4. Scan (trial decryption)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ScanNote {
    queue_index: i64,
    commitment: String,
    epk_x: String,
    epk_y: String,
    enc_amount: String,
    enc_rho: String,
    slot: u64,
}

#[derive(Deserialize)]
struct ScanIn {
    enc_sk: String,
    owner_pk: String,
    notes: Vec<ScanNote>,
}

#[derive(Serialize)]
struct FoundNote {
    queue_index: i64,
    commitment: String,
    amount: u64,
    rho: String,
    /// The nullifier this note will publish when spent. Returned so the wallet can ask the backend
    /// whether it is already spent, without needing the spending key at scan time.
    nullifier: String,
}

#[derive(Deserialize)]
struct ScanInWithSpend {
    #[serde(flatten)]
    base: ScanIn,
    /// Optional: with the spending key, each found note's nullifier is computed too.
    owner_sk: Option<String>,
}

/// Trial-decrypt a batch of notes; return the ones that belong to this wallet.
///
/// The feed is deliberately unfiltered — asking the server for "my notes" would tell it who is being
/// paid — so the wallet tries every note and keeps what opens. A match is conclusive: the decrypted
/// values must rebuild the exact published commitment, and forging that would mean finding a
/// Poseidon collision.
///
/// Batched in one call because the per-call bridge overhead would otherwise dominate: the actual
/// work is one Jubjub scalar multiplication per note.
pub fn scan_json(input: &str) -> Result<String, String> {
    let arg: ScanInWithSpend = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let cfg = poseidon_config::<Fr>();

    let enc_sk = jubjub_from_hex(&arg.base.enc_sk)?;
    let owner_pk = fr_from_hex(&arg.base.owner_pk)?;
    let owner_sk = match &arg.owner_sk {
        Some(s) if !s.is_empty() => Some(fr_from_hex(s)?),
        _ => None,
    };

    let mut found = Vec::new();
    for n in &arg.base.notes {
        let commitment = fr_from_hex(&n.commitment)?;
        let enc = EncryptedNote {
            epk: point(&n.epk_x, &n.epk_y)?,
            c_amount: fr_from_hex(&n.enc_amount)?,
            c_rho: fr_from_hex(&n.enc_rho)?,
        };
        let Some(note) = encryption::try_open(&cfg, enc_sk, owner_pk, commitment, &enc, n.slot)
        else {
            continue; // not ours, which is the common case
        };
        found.push(FoundNote {
            queue_index: n.queue_index,
            commitment: n.commitment.clone(),
            amount: note.amount,
            rho: fr_hex(&note.rho),
            nullifier: match owner_sk {
                Some(sk) => fr_hex(&super::note_nullifier(&cfg, sk, note.rho)),
                None => String::new(),
            },
        });
    }

    serde_json::to_string(&found).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wallet_keys(seed: &str) -> serde_json::Value {
        let out = keys_json(&json!({ "seed": seed }).to_string()).expect("keys");
        serde_json::from_str(&out).unwrap()
    }

    #[test]
    fn keys_are_derived_and_stable() {
        let a = wallet_keys("00112233445566778899aabbccddeeff");
        let b = wallet_keys("00112233445566778899aabbccddeeff");
        assert_eq!(a, b, "the same seed must always give the same wallet");

        let c = wallet_keys("ffeeddccbbaa99887766554433221100");
        assert_ne!(a["owner_pk"], c["owner_pk"]);
    }

    #[test]
    fn keys_reject_a_short_or_malformed_seed() {
        assert!(keys_json(&json!({ "seed": "00" }).to_string()).is_err());
        assert!(keys_json(&json!({ "seed": "nothex" }).to_string()).is_err());
    }

    /// The round trip that has to work or money is invisible: a note encrypted to this wallet's
    /// address must be found by scanning, with the right amount, and must rebuild the published
    /// commitment so it can actually be spent.
    #[test]
    fn scanning_finds_a_note_addressed_to_this_wallet() {
        let cfg = poseidon_config::<Fr>();
        let k = wallet_keys("00112233445566778899aabbccddeeff");
        let owner_pk = fr_from_hex(k["owner_pk"].as_str().unwrap()).unwrap();

        let rho = Fr::from(31337u64);
        let note = Note::new(2500, owner_pk, rho);
        let commitment = note.commitment(&cfg);
        let enc = encryption::encrypt(
            &cfg,
            JubjubFr::from(999u64),
            &point(
                k["enc_pk_x"].as_str().unwrap(),
                k["enc_pk_y"].as_str().unwrap(),
            )
            .unwrap(),
            Fr::from(2500u64),
            rho,
            1,
        );

        let input = json!({
            "enc_sk": k["enc_sk"],
            "owner_pk": k["owner_pk"],
            "owner_sk": k["owner_sk"],
            "notes": [{
                "queue_index": 12,
                "commitment": fr_hex(&commitment),
                "epk_x": fr_hex(&enc.epk.x),
                "epk_y": fr_hex(&enc.epk.y),
                "enc_amount": fr_hex(&enc.c_amount),
                "enc_rho": fr_hex(&enc.c_rho),
                "slot": 1,
            }],
        })
        .to_string();

        let out: serde_json::Value = serde_json::from_str(&scan_json(&input).unwrap()).unwrap();
        assert_eq!(out.as_array().unwrap().len(), 1, "the note must be found");
        assert_eq!(out[0]["amount"], 2500);
        assert_eq!(out[0]["queue_index"], 12);
        assert!(
            !out[0]["nullifier"].as_str().unwrap().is_empty(),
            "with the spending key, the nullifier must come back so the wallet can check if it is spent"
        );
    }

    /// Scanning must reveal nothing about other people's notes — this is what makes an unfiltered
    /// feed safe to serve.
    #[test]
    fn scanning_ignores_notes_for_other_wallets() {
        let cfg = poseidon_config::<Fr>();
        let mine = wallet_keys("00112233445566778899aabbccddeeff");
        let theirs = wallet_keys("aabbccddeeff00112233445566778899");

        let their_pk = fr_from_hex(theirs["owner_pk"].as_str().unwrap()).unwrap();
        let rho = Fr::from(5u64);
        let commitment = Note::new(100, their_pk, rho).commitment(&cfg);
        let enc = encryption::encrypt(
            &cfg,
            JubjubFr::from(7u64),
            &point(
                theirs["enc_pk_x"].as_str().unwrap(),
                theirs["enc_pk_y"].as_str().unwrap(),
            )
            .unwrap(),
            Fr::from(100u64),
            rho,
            0,
        );

        let input = json!({
            "enc_sk": mine["enc_sk"],
            "owner_pk": mine["owner_pk"],
            "notes": [{
                "queue_index": 1,
                "commitment": fr_hex(&commitment),
                "epk_x": fr_hex(&enc.epk.x),
                "epk_y": fr_hex(&enc.epk.y),
                "enc_amount": fr_hex(&enc.c_amount),
                "enc_rho": fr_hex(&enc.c_rho),
                "slot": 0,
            }],
        })
        .to_string();

        let out: serde_json::Value = serde_json::from_str(&scan_json(&input).unwrap()).unwrap();
        assert!(
            out.as_array().unwrap().is_empty(),
            "another wallet's note must stay invisible"
        );
    }

    #[test]
    fn spend_rejects_a_path_of_the_wrong_depth() {
        let k = wallet_keys("00112233445566778899aabbccddeeff");
        let input = json!({
            "in_amount": 100, "in_rho": "01", "owner_sk": k["owner_sk"],
            "leaf_index": 0, "siblings": ["01", "02"], "root": "03",
            "out1": {"amount": 60, "owner_pk": k["owner_pk"], "rho": "04",
                     "enc_pk_x": k["enc_pk_x"], "enc_pk_y": k["enc_pk_y"]},
            "out2": {"amount": 40, "owner_pk": k["owner_pk"], "rho": "05",
                     "enc_pk_x": k["enc_pk_x"], "enc_pk_y": k["enc_pk_y"]},
            "esk": "06", "public_amount": 0, "destination": "",
            "kyc_level": 2, "expiry": 2000000000,
            "sig_rx": "01", "sig_ry": "02", "sig_s": "03",
            "anchor_pk_x": "01", "anchor_pk_y": "02", "current_time": 1700000000,
        })
        .to_string();

        let err = spend_prove_json(&input).expect_err("a short path must be refused");
        assert!(err.contains("siblings"), "got: {err}");
    }
}

#[cfg(test)]
mod end_to_end {
    use super::*;
    use crate::pool::tree::MerkleTree;
    use ark_std::rand::{rngs::StdRng, SeedableRng};
    use serde_json::json;
    use std::time::Instant;

    /// The whole on-device path, ending in a real verification.
    ///
    /// Every other test checks a piece. This one proves the pieces compose: keys derived from a seed
    /// produce a note the wallet can find, whose membership path yields a proof that **verifies
    /// against the same verifying key the contract embeds**. If this passes, a phone can spend.
    #[test]
    fn spend_proof_from_the_ffi_path_verifies() {
        let cfg = poseidon_config::<Fr>();
        let mut rng = StdRng::seed_from_u64(4242);

        // A wallet, from a seed alone.
        let out =
            keys_json(&json!({"seed": "00112233445566778899aabbccddeeff"}).to_string()).unwrap();
        let k: serde_json::Value = serde_json::from_str(&out).unwrap();
        let owner_sk = fr_from_hex(k["owner_sk"].as_str().unwrap()).unwrap();
        let owner_pk = fr_from_hex(k["owner_pk"].as_str().unwrap()).unwrap();

        // A funded note sitting in the tree, surrounded by others.
        let rho = Fr::from(777u64);
        let note = Note::new(1000, owner_pk, rho);
        let mut tree = MerkleTree::new(&cfg);
        tree.insert(Fr::from(11u64));
        tree.insert(note.commitment(&cfg));
        tree.insert(Fr::from(22u64));
        let path = tree.path(1);

        // An anchor-issued KYC credential for this wallet.
        let anchor = credential::AnchorKey::generate(&mut rng);
        let uid = credential::user_id(&cfg, owner_sk);
        let cred = credential::issue(&cfg, &anchor, uid, 2, 2_000_000_000, &mut rng);
        let sig_s = {
            use ark_ff::BigInteger;
            let b = cred.sig.s.into_bigint().to_bytes_be();
            let mut o = [0u8; 32];
            o[32 - b.len()..].copy_from_slice(&b);
            hex::encode(o)
        };

        let siblings: Vec<String> = path.siblings.iter().map(fr_hex).collect();
        let input = json!({
            "in_amount": 1000,
            "in_rho": fr_hex(&rho),
            "owner_sk": k["owner_sk"],
            "leaf_index": 1,
            "siblings": siblings,
            "root": fr_hex(&path.root),
            "out1": {"amount": 600, "owner_pk": k["owner_pk"], "rho": fr_hex(&Fr::from(1u64)),
                     "enc_pk_x": k["enc_pk_x"], "enc_pk_y": k["enc_pk_y"]},
            "out2": {"amount": 400, "owner_pk": k["owner_pk"], "rho": fr_hex(&Fr::from(2u64)),
                     "enc_pk_x": k["enc_pk_x"], "enc_pk_y": k["enc_pk_y"]},
            "esk": fr_hex(&Fr::from(0xE5u64)),
            "public_amount": 0,
            "destination": "",
            "kyc_level": 2,
            "expiry": 2_000_000_000u64,
            "sig_rx": fr_hex(&cred.sig.r.x),
            "sig_ry": fr_hex(&cred.sig.r.y),
            "sig_s": sig_s,
            "anchor_pk_x": fr_hex(&anchor.pk.x),
            "anchor_pk_y": fr_hex(&anchor.pk.y),
            "current_time": 1_700_000_000u64,
        })
        .to_string();

        let result: serde_json::Value =
            serde_json::from_str(&spend_prove_json(&input).expect("prove")).unwrap();

        // A(96) ‖ B(192) ‖ C(96) = 384 bytes.
        let blob = hex::decode(result["proof"].as_str().unwrap()).unwrap();
        assert_eq!(blob.len(), 384, "proof blob must be A‖B‖C");

        // Rebuild the public inputs exactly as the contract does, then verify against the real
        // verifying key. This is the check that a phone's proof will be accepted on-chain.
        let public = vec![
            path.root,
            fr_from_hex(result["nullifier"].as_str().unwrap()).unwrap(),
            fr_from_hex(result["out_c1"].as_str().unwrap()).unwrap(),
            fr_from_hex(result["out_c2"].as_str().unwrap()).unwrap(),
            Fr::from(0u64),
            Fr::from(0u64),
            anchor.pk.x,
            anchor.pk.y,
            Fr::from(1_700_000_000u64),
            fr_from_hex(result["epk_x"].as_str().unwrap()).unwrap(),
            fr_from_hex(result["epk_y"].as_str().unwrap()).unwrap(),
            fr_from_hex(result["enc1_amount"].as_str().unwrap()).unwrap(),
            fr_from_hex(result["enc1_rho"].as_str().unwrap()).unwrap(),
            fr_from_hex(result["enc2_amount"].as_str().unwrap()).unwrap(),
            fr_from_hex(result["enc2_rho"].as_str().unwrap()).unwrap(),
        ];
        assert_eq!(public.len(), 15, "spend has 15 public inputs");

        // The blob above is in Soroban's encoding, which the contract parses. Verifying here uses
        // the arkworks form of the same statement, rebuilt from the identical witness.
        let (_, vk) = crate::pool::setup::spend(SETUP_SEED);
        assert!(
            Groth16::<Bls12_381>::verify(&vk, &public, &reprove(&input)).unwrap(),
            "a proof built through the FFI path must verify against the contract's verifying key"
        );
    }

    /// Rebuild the proof object from the same input, for verification against the VK.
    fn reprove(input: &str) -> ark_groth16::Proof<Bls12_381> {
        let arg: SpendIn = serde_json::from_str(input).unwrap();
        let cfg = poseidon_config::<Fr>();
        let siblings = arg
            .siblings
            .iter()
            .map(|s| fr_from_hex(s).unwrap())
            .collect();
        let path = MerklePath {
            leaf_index: arg.leaf_index,
            siblings,
            root: fr_from_hex(&arg.root).unwrap(),
        };
        let cred = credential::Credential {
            user_id: credential::user_id(&cfg, fr_from_hex(&arg.owner_sk).unwrap()),
            kyc_level: arg.kyc_level,
            expiry: arg.expiry,
            sig: credential::Signature {
                r: point(&arg.sig_rx, &arg.sig_ry).unwrap(),
                s: jubjub_from_hex(&arg.sig_s).unwrap(),
            },
        };
        let mk = |n: &SpendNoteIn| {
            SpendOutput::new(
                Note::new(
                    n.amount,
                    fr_from_hex(&n.owner_pk).unwrap(),
                    fr_from_hex(&n.rho).unwrap(),
                ),
                point(&n.enc_pk_x, &n.enc_pk_y).unwrap(),
            )
        };
        let circuit = SpendCircuit::new(
            cfg,
            arg.in_amount,
            fr_from_hex(&arg.in_rho).unwrap(),
            fr_from_hex(&arg.owner_sk).unwrap(),
            &path,
            mk(&arg.out1),
            mk(&arg.out2),
            jubjub_from_hex(&arg.esk).unwrap(),
            arg.public_amount,
            Fr::from(0u64),
            &cred,
            point(&arg.anchor_pk_x, &arg.anchor_pk_y).unwrap(),
            arg.current_time,
        );
        Groth16::<Bls12_381>::prove(spend_key(), circuit, &mut OsRng).unwrap()
    }

    /// Timing for the operations a user waits on.
    ///
    /// Desktop figures, so not a handset number — but they bound the shape, and `warm_up` is the
    /// reason the first send does not pay for key derivation. Run with `--nocapture` to read them.
    #[test]
    fn report_on_device_timings() {
        let t = Instant::now();
        warm_up().unwrap();
        println!("PROVA_DEVICE warm_up_ms={}", t.elapsed().as_millis());

        let t = Instant::now();
        let out =
            keys_json(&json!({"seed": "00112233445566778899aabbccddeeff"}).to_string()).unwrap();
        println!("PROVA_DEVICE keys_ms={}", t.elapsed().as_millis());
        let k: serde_json::Value = serde_json::from_str(&out).unwrap();

        // Shield: what a user waits on when depositing.
        let t = Instant::now();
        shield_prove_json(
            &json!({
                "amount": 1000, "owner_pk": k["owner_pk"], "rho": fr_hex(&Fr::from(3u64)),
                "enc_pk_x": k["enc_pk_x"], "enc_pk_y": k["enc_pk_y"], "esk": fr_hex(&Fr::from(9u64)),
            })
            .to_string(),
        )
        .unwrap();
        println!("PROVA_DEVICE shield_prove_ms={}", t.elapsed().as_millis());

        // Scanning 200 notes, none of them ours — the worst case, and what a wallet does on every
        // poll. This is the number that decides whether the feed feels instant.
        let cfg = poseidon_config::<Fr>();
        let stranger = crate::pool::encryption::EncKey::from_secret(JubjubFr::from(5u64));
        let mut notes = Vec::new();
        for i in 0..200u64 {
            let rho = Fr::from(i + 1);
            let enc = crate::pool::encryption::encrypt(
                &cfg,
                JubjubFr::from(i + 2),
                &stranger.pk,
                Fr::from(10u64),
                rho,
                0,
            );
            notes.push(json!({
                "queue_index": i as i64,
                "commitment": fr_hex(&Fr::from(i + 100)),
                "epk_x": fr_hex(&enc.epk.x), "epk_y": fr_hex(&enc.epk.y),
                "enc_amount": fr_hex(&enc.c_amount), "enc_rho": fr_hex(&enc.c_rho),
                "slot": 0,
            }));
        }
        let t = Instant::now();
        let found = scan_json(
            &json!({"enc_sk": k["enc_sk"], "owner_pk": k["owner_pk"], "notes": notes}).to_string(),
        )
        .unwrap();
        let ms = t.elapsed().as_millis();
        println!(
            "PROVA_DEVICE scan_200_notes_ms={ms} per_note_us={}",
            ms * 1000 / 200
        );
        assert_eq!(found, "[]", "none of those notes are ours");
    }
}
