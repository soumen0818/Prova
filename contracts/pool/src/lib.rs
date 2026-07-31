#![cfg_attr(not(test), no_std)]
// The `#[contractimpl]` macros regenerate the multi-argument entrypoints for the client and args
// types, so `too_many_arguments` must be allowed crate-wide rather than per-function.
#![allow(clippy::too_many_arguments)]
//! Prova shielded pool (contract v3) — see `Docs/shielded-pool.md`.
//!
//! The vault behind Prova's privacy claim: real tokens go in, value moves privately inside as notes,
//! real tokens come out. On-chain a watcher sees only commitments, nullifiers and proofs.
//!
//! ## The defining constraint: this contract never hashes
//!
//! The V1.0 gate measured one Poseidon permutation at **10,967,507 CPU** against Soroban's 100M
//! per-transaction budget. A depth-20 Merkle append needs 20 of them and cannot even run to
//! completion, so maintaining the tree here is impossible (the measurement is kept executable in the
//! test-only `gate` module and `test::gate_onchain_merkle_does_not_fit_cpu_budget`).
//!
//! So the tree update is **deferred and batched**:
//!
//! ```text
//! shield / transact / unshield  →  verify a proof, queue the new commitments   (no hashing)
//! update_root                   →  verify one proof that folds the queue in    (no hashing)
//! ```
//!
//! [`Pool::update_root`] is permissionless. The fold proof enforces correctness, so a folder can
//! neither mint, steal, nor spend — its only power is to stop working, which delays new notes
//! becoming spendable and puts no custodied funds at risk.
//!
//! ## Consequence for callers
//!
//! A note is spendable only once the fold containing it has landed, because a spend proves Merkle
//! membership and an unfolded commitment is not yet a leaf. Wallets must show queued notes as
//! confirming, not spendable.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bls12_381::{Fr, G1Affine, G2Affine},
    token,
    xdr::ToXdr,
    Address, BytesN, Env, Vec,
};

// Poseidon and the gate probes are **test-only**. The production contract never hashes — that is the
// finding this whole design rests on — so shipping them in the wasm would be dead weight. They are
// kept because the measurement must stay re-runnable, and because the fold circuit's constants and
// the backend indexer both need a reference implementation of the same hash.
#[cfg(test)]
pub mod gate;
#[cfg(test)]
pub mod poseidon;

// ---------------------------------------------------------------------------
// Frozen parameters — must match `shared/src/pool.ts` and the circuits exactly.
// ---------------------------------------------------------------------------

/// Tree depth (`MerkleParams.DEPTH`). Only used to bound `next_index`; the contract never walks it.
pub const DEPTH: u32 = 20;
/// Commitments folded per [`Pool::update_root`] (`MerkleParams.BATCH`).
pub const BATCH: u32 = 8;
/// How many recent roots a spend may prove against (`MerkleParams.ROOT_HISTORY`).
pub const ROOT_HISTORY: u32 = 32;

/// Verifying keys, exported from the circuits by `prova-prover pool-artifacts`. Layout:
/// `alpha(96) ‖ -beta(192) ‖ -gamma(192) ‖ -delta(192) ‖ IC[0..n](96 each)`, with beta/gamma/delta
/// pre-negated so verification is a single `pairing_check`.
static SPEND_VK: &[u8] = include_bytes!("artifacts/spend_vk.bin");
static SHIELD_VK: &[u8] = include_bytes!("artifacts/shield_vk.bin");
static FOLD_VK: &[u8] = include_bytes!("artifacts/fold_vk.bin");

/// `zeros[DEPTH]` — the root of an empty tree. The contract cannot derive this (20 Poseidon hashes),
/// so it is embedded from the same source as the circuits' constants.
static EMPTY_ROOT: &[u8; 32] = include_bytes!("artifacts/empty_root.bin");

/// Byte offset of `IC[0]` in a verifying key blob.
const IC0: usize = 96 + 192 * 3;

/// A Groth16 proof. Bundled because Soroban caps a contract function at 10 parameters and the spend
/// entrypoints would otherwise exceed it.
#[contracttype]
#[derive(Clone)]
pub struct Proof {
    pub a: BytesN<96>,
    pub b: BytesN<192>,
    pub c: BytesN<96>,
}

/// The two notes a spend creates, with the encrypted payloads their owners will trial-decrypt.
///
/// A transfer always produces exactly two: one for the recipient and one for the change. An unshield
/// producing no change still carries two — zero-amount notes with real commitments — so the shape of
/// an on-chain spend never reveals which operation it was.
///
/// **The encrypted payloads are public inputs to the proof, not attachments.** The spend circuit
/// computes them itself, so corrupting one invalidates the proof rather than silently leaving the
/// recipient unable to find their money. `epk` is the shared ephemeral key; each note's `(amount,
/// rho)` is masked with a Poseidon pad derived from it. See `circuits/prover/src/pool/encryption.rs`.
#[contracttype]
#[derive(Clone)]
pub struct Outputs {
    pub c1: BytesN<32>,
    pub c2: BytesN<32>,
    /// Ephemeral public key (Jubjub, x then y), shared by both notes.
    pub epk_x: BytesN<32>,
    pub epk_y: BytesN<32>,
    /// Note 1: masked amount and rho.
    pub enc1_amount: BytesN<32>,
    pub enc1_rho: BytesN<32>,
    /// Note 2: masked amount and rho.
    pub enc2_amount: BytesN<32>,
    pub enc2_rho: BytesN<32>,
}

/// A deposit's note: the commitment, its owner, and the owner's encrypted copy.
///
/// Bundled to stay inside Soroban's 10-parameter limit. Like a transfer's outputs, the encrypted
/// payload is a public input to the shield proof — so a wallet restored from seed alone can discover
/// this deposit, and nobody can corrupt that discovery message in transit.
#[contracttype]
#[derive(Clone)]
pub struct ShieldNote {
    pub commitment: BytesN<32>,
    pub owner_pk: BytesN<32>,
    pub epk_x: BytesN<32>,
    pub epk_y: BytesN<32>,
    pub enc_amount: BytesN<32>,
    pub enc_rho: BytesN<32>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// One-time initialisation guard.
    Config,
    /// Address permitted to upgrade, pause, and rotate the anchor key.
    ///
    /// **This is the pool's one trusted role, and it is deliberate.** A deployed Soroban contract is
    /// immutable, so without it a bug discovered after launch would freeze every custodied token
    /// permanently, with no recourse. The trade is explicit: whoever holds this key could also
    /// install malicious code. It is a single address today; it should become a multisig before
    /// mainnet, via [`Pool::set_admin`]. Every use emits an event, so admin action is always publicly
    /// visible even though it is not trustless.
    Admin,
    /// When true, `shield` and `transact` are halted. `unshield` and `update_root` never are.
    Paused,
    /// The SEP-41 / Stellar Asset Contract token this pool custodies.
    Token,
    /// Anchor public key the KYC credential must be signed by (x, y).
    AnchorPk,
    /// The current Merkle root.
    Root,
    /// Rolling history of the last [`ROOT_HISTORY`] roots, indexed by ring slot.
    RootAt(u32),
    /// Next free ring slot.
    RootCursor,
    /// Leaves folded into the tree so far — where the next fold starts.
    NextIndex,
    /// Queue read cursor (next commitment to fold).
    QueueHead,
    /// Queue write cursor (next free queue slot).
    QueueTail,
    /// A queued commitment awaiting its fold.
    Queued(u32),
    /// Marks a nullifier as spent. Must never be evicted — see [`Pool::extend_ttl`].
    Nullifier(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    /// The note was already spent — a double-spend attempt.
    NullifierAlreadyUsed = 3,
    /// The Groth16 proof did not verify.
    InvalidProof = 4,
    /// The spend proved membership against a root the contract no longer accepts.
    UnknownRoot = 5,
    /// `count` outside `1..=BATCH`, or more than the queue holds.
    InvalidBatch = 6,
    /// A commitment must be a real Poseidon output; zero is the empty-leaf value.
    ZeroCommitment = 7,
    /// Amount is not a positive value inside the circuits' u64 range.
    InvalidAmount = 8,
    /// The tree is full (2^DEPTH leaves).
    TreeFull = 9,
    /// Deposits and private transfers are paused. Withdrawals are never blocked.
    Paused = 10,
}

#[contract]
pub struct Pool;

// ---------------------------------------------------------------------------
// Groth16 verification
// ---------------------------------------------------------------------------

fn vk_g1(env: &Env, vk: &[u8], off: usize) -> G1Affine {
    let mut a = [0u8; 96];
    a.copy_from_slice(&vk[off..off + 96]);
    G1Affine::from_bytes(BytesN::from_array(env, &a))
}

fn vk_g2(env: &Env, vk: &[u8], off: usize) -> G2Affine {
    let mut a = [0u8; 192];
    a.copy_from_slice(&vk[off..off + 192]);
    G2Affine::from_bytes(BytesN::from_array(env, &a))
}

/// The Groth16 check, shared by all three proof kinds.
///
/// The equation is rearranged (off-chain, by pre-negating beta/gamma/delta in the VK) into a single
/// pairing check:
///
/// ```text
/// e(A, B) · e(alpha, -beta) · e(vk_x, -gamma) · e(C, -delta) == 1
/// where vk_x = IC[0] + Σ inputs[i]·IC[i+1]
/// ```
///
/// `inputs` must be in the circuit's exact public-input order; a mismatch fails every proof.
fn verify_groth16(
    env: &Env,
    vk: &[u8],
    proof_a: BytesN<96>,
    proof_b: BytesN<192>,
    proof_c: BytesN<96>,
    inputs: &Vec<BytesN<32>>,
) -> bool {
    let bls = env.crypto().bls12_381();

    // vk_x = IC[0]·1 + Σ IC[i+1]·input[i]
    let mut ic = Vec::new(env);
    let mut scalars = Vec::new(env);
    ic.push_back(vk_g1(env, vk, IC0));
    scalars.push_back(Fr::from_bytes(BytesN::from_array(env, &{
        let mut one = [0u8; 32];
        one[31] = 1;
        one
    })));
    for (i, input) in inputs.iter().enumerate() {
        ic.push_back(vk_g1(env, vk, IC0 + 96 * (i + 1)));
        scalars.push_back(Fr::from_bytes(input));
    }
    let vk_x = bls.g1_msm(ic, scalars);

    let vp1 = Vec::from_array(
        env,
        [
            G1Affine::from_bytes(proof_a),
            vk_g1(env, vk, 0),
            vk_x,
            G1Affine::from_bytes(proof_c),
        ],
    );
    let vp2 = Vec::from_array(
        env,
        [
            G2Affine::from_bytes(proof_b),
            vk_g2(env, vk, 96),
            vk_g2(env, vk, 96 + 192),
            vk_g2(env, vk, 96 + 192 * 2),
        ],
    );
    bls.pairing_check(vp1, vp2)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A `u64` amount as the circuits see it: a 32-byte big-endian field element.
fn amount_to_fr(env: &Env, amount: i128) -> Result<BytesN<32>, Error> {
    if amount <= 0 || amount > u64::MAX as i128 {
        return Err(Error::InvalidAmount);
    }
    let mut b = [0u8; 32];
    b[24..].copy_from_slice(&(amount as u64).to_be_bytes());
    Ok(BytesN::from_array(env, &b))
}

fn u32_to_fr(env: &Env, v: u32) -> BytesN<32> {
    let mut b = [0u8; 32];
    b[28..].copy_from_slice(&v.to_be_bytes());
    BytesN::from_array(env, &b)
}

fn zero_fr(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

/// Bind a payout `Address` to a field element the spend circuit can carry as a public input.
///
/// `sha256(xdr(address))` with the top byte cleared, so the result is always below the BLS12-381
/// scalar modulus. 248 bits of collision resistance is far more than enough to make it infeasible to
/// find a second address with the same binding — which is what stops an unshield proof being
/// redirected. The wallet computes this identically when building the proof.
fn destination_to_fr(env: &Env, destination: &Address) -> BytesN<32> {
    let digest = env.crypto().sha256(&destination.clone().to_xdr(env));
    let mut b = digest.to_array();
    b[0] = 0;
    BytesN::from_array(env, &b)
}

fn is_zero(b: &BytesN<32>) -> bool {
    b.to_array().iter().all(|x| *x == 0)
}

// ---------------------------------------------------------------------------
// State access
// ---------------------------------------------------------------------------

/// Persistent entries live as long as the pool does. Nullifiers especially: an archived nullifier
/// would silently re-enable a double-spend, so every touched entry gets its TTL extended.
const TTL_THRESHOLD: u32 = 100_000;
const TTL_EXTEND: u32 = 500_000;

fn get<V>(env: &Env, key: &DataKey) -> Option<V>
where
    V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val> + Clone,
{
    let v = env.storage().persistent().get::<DataKey, V>(key);
    if v.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND);
    }
    v
}

fn put<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey, value: &V) {
    env.storage().persistent().set(key, value);
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND);
}

/// Require the caller to be the admin. Every admin entrypoint starts here.
fn require_admin(env: &Env) -> Result<Address, Error> {
    let admin: Address = get(env, &DataKey::Admin).ok_or(Error::NotInitialized)?;
    admin.require_auth();
    Ok(admin)
}

/// Reject value-*increasing* operations while paused.
///
/// Deliberately not applied to `unshield` or `update_root`: a pause must never trap anyone's money.
/// Withdrawals stay open so users can always exit, and folding stays open because a note has to be
/// in the tree before it can be withdrawn — pausing that would strand exactly the people trying to
/// leave.
fn require_not_paused(env: &Env) -> Result<(), Error> {
    if get::<bool>(env, &DataKey::Paused).unwrap_or(false) {
        return Err(Error::Paused);
    }
    Ok(())
}

fn token_client(env: &Env) -> Result<token::Client<'static>, Error> {
    let addr: Address = get(env, &DataKey::Token).ok_or(Error::NotInitialized)?;
    Ok(token::Client::new(env, &addr))
}

/// Append a commitment to the fold queue and emit its encrypted note for wallet scanning.
///
/// Zero is rejected: it is the empty-leaf value, and the fold circuit refuses it in an active slot
/// precisely so a batch cannot be padded with zeros and made to advance the queue past real notes.
fn enqueue(
    env: &Env,
    commitment: &BytesN<32>,
    epk_x: &BytesN<32>,
    epk_y: &BytesN<32>,
    c_amount: &BytesN<32>,
    c_rho: &BytesN<32>,
    slot: u32,
) -> Result<u32, Error> {
    if is_zero(commitment) {
        return Err(Error::ZeroCommitment);
    }
    let tail: u32 = get(env, &DataKey::QueueTail).unwrap_or(0);
    put(env, &DataKey::Queued(tail), commitment);
    put(env, &DataKey::QueueTail, &(tail + 1));

    // The recipient finds their money by trial-decrypting these; the chain only sees ciphertext.
    // `slot` must be emitted because it is domain-separated into the decryption key.
    env.events().publish(
        (soroban_sdk::symbol_short!("note"),),
        (
            commitment.clone(),
            tail,
            slot,
            epk_x.clone(),
            epk_y.clone(),
            c_amount.clone(),
            c_rho.clone(),
        ),
    );
    Ok(tail)
}

/// Verify a spend proof, reject replays, record the nullifier and queue both output notes.
/// Shared by [`Pool::transact`] and [`Pool::unshield`] — the only difference is what happens to
/// tokens afterwards.
fn spend(
    env: &Env,
    proof: Proof,
    root: BytesN<32>,
    nullifier: BytesN<32>,
    out: Outputs,
    public_amount: BytesN<32>,
    destination: BytesN<32>,
    current_time: u64,
) -> Result<(), Error> {
    // 1. Cheapest checks first — a replay or an unknown root costs no pairing.
    let nullifier_key = DataKey::Nullifier(nullifier.clone());
    if env.storage().persistent().has(&nullifier_key) {
        return Err(Error::NullifierAlreadyUsed);
    }
    if !Pool::is_known_root(env.clone(), root.clone()) {
        return Err(Error::UnknownRoot);
    }

    // 2. Verify, in the circuit's frozen public-input order.
    let anchor: (BytesN<32>, BytesN<32>) =
        get(env, &DataKey::AnchorPk).ok_or(Error::NotInitialized)?;
    let inputs = Vec::from_array(
        env,
        [
            root,
            nullifier.clone(),
            out.c1.clone(),
            out.c2.clone(),
            public_amount,
            destination,
            anchor.0,
            anchor.1,
            {
                let mut b = [0u8; 32];
                b[24..].copy_from_slice(&current_time.to_be_bytes());
                BytesN::from_array(env, &b)
            },
            // The encrypted notes. Passing them through the verifier is what binds them to the
            // proof — the reason a relayer cannot corrupt a recipient's discovery message.
            out.epk_x.clone(),
            out.epk_y.clone(),
            out.enc1_amount.clone(),
            out.enc1_rho.clone(),
            out.enc2_amount.clone(),
            out.enc2_rho.clone(),
        ],
    );
    if !verify_groth16(env, SPEND_VK, proof.a, proof.b, proof.c, &inputs) {
        return Err(Error::InvalidProof);
    }

    // 3. Burn the note, then queue the two it produced.
    put(env, &nullifier_key, &true);
    // Publish the nullifier so the indexer can mark the note spent. Without this a wallet could
    // only learn a note was consumed by trusting its own local state, and a wallet restored from
    // seed would show already-spent notes as available balance.
    env.events()
        .publish((soroban_sdk::symbol_short!("spend"),), nullifier);
    enqueue(
        env,
        &out.c1,
        &out.epk_x,
        &out.epk_y,
        &out.enc1_amount,
        &out.enc1_rho,
        0,
    )?;
    enqueue(
        env,
        &out.c2,
        &out.epk_x,
        &out.epk_y,
        &out.enc2_amount,
        &out.enc2_rho,
        1,
    )?;
    Ok(())
}

#[contractimpl]
impl Pool {
    /// Bind the pool to its token and the anchor whose KYC credentials it honours.
    ///
    /// The tree starts empty, and the empty root is seeded into the history so the very first spend
    /// after the first fold has something to prove against.
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        anchor_pk_x: BytesN<32>,
        anchor_pk_y: BytesN<32>,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Config, &true);

        put(&env, &DataKey::Admin, &admin);
        put(&env, &DataKey::Paused, &false);
        put(&env, &DataKey::Token, &token);
        put(&env, &DataKey::AnchorPk, &(anchor_pk_x, anchor_pk_y));

        let empty = BytesN::from_array(&env, EMPTY_ROOT);
        put(&env, &DataKey::Root, &empty);
        put(&env, &DataKey::RootAt(0), &empty);
        put(&env, &DataKey::RootCursor, &1u32);
        put(&env, &DataKey::NextIndex, &0u32);
        put(&env, &DataKey::QueueHead, &0u32);
        put(&env, &DataKey::QueueTail, &0u32);
        Ok(())
    }

    /// Move tokens into the pool and queue the note they become.
    ///
    /// Public by design: the anchor already knows this deposit — they did the KYC and owe Travel
    /// Rule data. Privacy is required *in transit*, which [`Pool::transact`] provides.
    ///
    /// The shield proof is what makes this safe. Because the contract cannot compute Poseidon, it
    /// cannot check that `commitment` commits to `amount`; without the proof a user could transfer
    /// 100 while committing to 1,000,000 and then unshield the pool dry. The proof binds the two,
    /// and the amount it is checked against is the amount actually transferred here.
    pub fn shield(
        env: Env,
        from: Address,
        amount: i128,
        note: ShieldNote,
        proof: Proof,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        from.require_auth();
        let amount_fr = amount_to_fr(&env, amount)?;

        let inputs = Vec::from_array(
            &env,
            [
                note.commitment.clone(),
                amount_fr,
                note.owner_pk.clone(),
                note.epk_x.clone(),
                note.epk_y.clone(),
                note.enc_amount.clone(),
                note.enc_rho.clone(),
            ],
        );
        if !verify_groth16(&env, SHIELD_VK, proof.a, proof.b, proof.c, &inputs) {
            return Err(Error::InvalidProof);
        }

        token_client(&env)?.transfer(&from, &env.current_contract_address(), &amount);
        enqueue(
            &env,
            &note.commitment,
            &note.epk_x,
            &note.epk_y,
            &note.enc_amount,
            &note.enc_rho,
            0,
        )?;
        Ok(())
    }

    /// Spend a note privately: one note in, two notes out, nothing leaves the pool.
    ///
    /// On-chain an observer sees a nullifier and two commitments — not the amount, not the sender,
    /// not the recipient.
    pub fn transact(
        env: Env,
        proof: Proof,
        root: BytesN<32>,
        nullifier: BytesN<32>,
        out: Outputs,
        current_time: u64,
    ) -> Result<(), Error> {
        require_not_paused(&env)?;
        // A private transfer moves nothing publicly, so both are zero — and the circuit enforces
        // that a zero public amount forbids naming a destination.
        spend(
            &env,
            proof,
            root,
            nullifier,
            out,
            zero_fr(&env),
            zero_fr(&env),
            current_time,
        )
    }

    /// Spend a note and release `amount` tokens to `destination`, queueing any change.
    ///
    /// `destination` is bound inside the proof. Without that binding this proof could be lifted from
    /// the mempool and resubmitted with an attacker's address — the funds would be theirs and the
    /// proof would still be perfectly valid.
    pub fn unshield(
        env: Env,
        proof: Proof,
        root: BytesN<32>,
        nullifier: BytesN<32>,
        out: Outputs,
        amount: i128,
        destination: Address,
        current_time: u64,
    ) -> Result<(), Error> {
        let amount_fr = amount_to_fr(&env, amount)?;
        let dest_fr = destination_to_fr(&env, &destination);

        spend(
            &env,
            proof,
            root,
            nullifier,
            out,
            amount_fr,
            dest_fr,
            current_time,
        )?;

        token_client(&env)?.transfer(&env.current_contract_address(), &destination, &amount);
        Ok(())
    }

    /// Fold up to [`BATCH`] queued commitments into the tree and advance the root.
    ///
    /// **Permissionless.** The proof carries the leaves as public inputs and the contract supplies
    /// them from its own queue, so a caller cannot insert a commitment that was never queued, skip
    /// one, reorder them, or append anywhere but the tree's next free slot. All a malicious caller
    /// can do is decline to call this, which delays new notes and risks no custodied funds.
    pub fn update_root(
        env: Env,
        proof: Proof,
        new_root: BytesN<32>,
        count: u32,
    ) -> Result<(), Error> {
        let head: u32 = get(&env, &DataKey::QueueHead).ok_or(Error::NotInitialized)?;
        let tail: u32 = get(&env, &DataKey::QueueTail).unwrap_or(0);
        if count == 0 || count > BATCH || head + count > tail {
            return Err(Error::InvalidBatch);
        }

        let next_index: u32 = get(&env, &DataKey::NextIndex).unwrap_or(0);
        if next_index + count > (1u32 << DEPTH) {
            return Err(Error::TreeFull);
        }
        let old_root: BytesN<32> = get(&env, &DataKey::Root).ok_or(Error::NotInitialized)?;

        // [oldRoot, newRoot, startIndex, count, leaf0..leaf7] — unused slots are zero, which the
        // circuit requires so the input vector is canonical.
        let mut inputs = Vec::new(&env);
        inputs.push_back(old_root);
        inputs.push_back(new_root.clone());
        inputs.push_back(u32_to_fr(&env, next_index));
        inputs.push_back(u32_to_fr(&env, count));
        for i in 0..BATCH {
            if i < count {
                let leaf: BytesN<32> =
                    get(&env, &DataKey::Queued(head + i)).ok_or(Error::InvalidBatch)?;
                inputs.push_back(leaf);
            } else {
                inputs.push_back(zero_fr(&env));
            }
        }

        if !verify_groth16(&env, FOLD_VK, proof.a, proof.b, proof.c, &inputs) {
            return Err(Error::InvalidProof);
        }

        // Advance the tree and push the new root into the rolling history, so proofs built against
        // the previous root keep verifying while they are in flight.
        let cursor: u32 = get(&env, &DataKey::RootCursor).unwrap_or(0);
        put(&env, &DataKey::Root, &new_root);
        put(&env, &DataKey::RootAt(cursor % ROOT_HISTORY), &new_root);
        put(&env, &DataKey::RootCursor, &(cursor + 1));
        put(&env, &DataKey::NextIndex, &(next_index + count));
        put(&env, &DataKey::QueueHead, &(head + count));

        env.events().publish(
            (soroban_sdk::symbol_short!("root"),),
            (new_root, next_index + count, count),
        );
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Admin. Rare, break-glass operations — driven from a CLI by the key holder,
    // never from a web service. Each emits an event, so admin action is publicly
    // auditable even though it is not trustless.
    // -----------------------------------------------------------------------

    /// Replace the contract's code.
    ///
    /// The recovery path that makes everything else survivable: a deployed Soroban contract is
    /// otherwise immutable, so a bug found after launch would freeze every custodied token forever.
    /// The cost of having it is that this key can also install malicious code — which is why it
    /// belongs on a hardware wallet, and on a multisig before mainnet.
    ///
    /// Storage layout is preserved across an upgrade, so the tree, the queue and the nullifier set
    /// all survive. A new wasm that changes the meaning of a `DataKey` would corrupt them.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        require_admin(&env)?;
        env.events().publish(
            (soroban_sdk::symbol_short!("upgrade"),),
            new_wasm_hash.clone(),
        );
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Rotate the anchor public key that KYC credentials are checked against.
    ///
    /// If the anchor's signing key ever leaks, an attacker can mint themselves unlimited "verified"
    /// credentials and use the pool with no KYC at all — not theft, but a silent collapse of the
    /// compliance guarantee. Without rotation that would be permanent. Routine rotation is also what
    /// a financial auditor expects to see.
    ///
    /// **Takes effect immediately and invalidates every outstanding credential**, including honest
    /// ones. That is the point in an emergency; for a planned rotation, re-issue credentials first so
    /// wallets can refresh with minimal disruption.
    pub fn set_anchor(
        env: Env,
        anchor_pk_x: BytesN<32>,
        anchor_pk_y: BytesN<32>,
    ) -> Result<(), Error> {
        require_admin(&env)?;
        put(
            &env,
            &DataKey::AnchorPk,
            &(anchor_pk_x.clone(), anchor_pk_y.clone()),
        );
        env.events().publish(
            (soroban_sdk::symbol_short!("anchor"),),
            (anchor_pk_x, anchor_pk_y),
        );
        Ok(())
    }

    /// Halt or resume deposits and private transfers.
    ///
    /// Buys time. The upgrade path can fix a discovered flaw, but writing, testing and deploying a
    /// fix takes hours or days — during which a live pool keeps bleeding. This stops it in seconds.
    ///
    /// **`unshield` and `update_root` are never paused.** Users can always withdraw, and folding
    /// continues so notes queued when the pause landed can still be exited. Nobody's money is ever
    /// held hostage by this switch.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), Error> {
        require_admin(&env)?;
        put(&env, &DataKey::Paused, &paused);
        env.events()
            .publish((soroban_sdk::symbol_short!("paused"),), paused);
        Ok(())
    }

    /// Hand the admin role to another address.
    ///
    /// The migration path from a single key to a 2-of-3 multisig, which is where this should be
    /// before mainnet. Requires the *current* admin's authorisation, so it cannot be seized.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        require_admin(&env)?;
        put(&env, &DataKey::Admin, &new_admin);
        env.events()
            .publish((soroban_sdk::symbol_short!("admin"),), new_admin);
        Ok(())
    }

    // --- views ---

    pub fn admin(env: Env) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Admin)
    }

    /// Are deposits and private transfers currently halted? Withdrawals are unaffected either way.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// Is `root` one the contract still accepts a spend against?
    ///
    /// A proof is built against whatever root the wallet last saw; by the time it lands, other
    /// transfers may have advanced it. Accepting any of the last [`ROOT_HISTORY`] roots is what lets
    /// concurrent spends coexist instead of all but one failing.
    pub fn is_known_root(env: Env, root: BytesN<32>) -> bool {
        if is_zero(&root) {
            return false;
        }
        for slot in 0..ROOT_HISTORY {
            if let Some(r) = env
                .storage()
                .persistent()
                .get::<DataKey, BytesN<32>>(&DataKey::RootAt(slot))
            {
                if r == root {
                    return true;
                }
            }
        }
        false
    }

    /// The field element a payout `Address` binds to inside an unshield proof.
    ///
    /// Exposed so a wallet builds its proof against exactly what this contract will check, with no
    /// second implementation to drift. See [`destination_to_fr`].
    pub fn destination_field(env: Env, destination: Address) -> BytesN<32> {
        destination_to_fr(&env, &destination)
    }

    pub fn root(env: Env) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::Root)
    }

    /// Leaves folded into the tree so far.
    pub fn next_index(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::NextIndex)
            .unwrap_or(0)
    }

    /// Commitments queued but not yet folded — the metric to alert on if the folder stalls.
    pub fn queue_depth(env: Env) -> u32 {
        let head: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::QueueHead)
            .unwrap_or(0);
        let tail: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::QueueTail)
            .unwrap_or(0);
        tail - head
    }

    /// Has this note already been spent?
    pub fn is_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier))
    }

    /// Keep a nullifier alive. Anyone may call it: letting a nullifier be archived would re-enable
    /// the double-spend it exists to prevent, so this is deliberately not permissioned.
    pub fn extend_ttl(env: Env, nullifier: BytesN<32>) {
        let key = DataKey::Nullifier(nullifier);
        if env.storage().persistent().has(&key) {
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
        }
    }
}

mod test;
