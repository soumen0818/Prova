# circuits

Prova's zero-knowledge circuits and on-device prover — Rust, [arkworks](https://github.com/arkworks-rs),
Groth16 over **BLS12-381**.

> **This directory previously targeted Circom + SnarkJS + BN254.** That plan is abandoned: Soroban
> (Stellar's smart contract platform) has no BN254 host functions, only BLS12-381 ones. The entire
> ZK stack was rewritten in Rust on `arkworks`/BLS12-381. The old Circom sources, `node_modules/`,
> and compiled artifacts (`circuits/circuits/`, `circuits/build/`) are historical leftovers — nothing
> in the working system depends on them. **Everything real lives in `circuits/prover/`.**

## Why Rust, why BLS12-381

- **BLS12-381**, not BN254: Soroban's `env.crypto().bls12_381()` host functions (`g1_msm`,
  `pairing_check`) are the only pairing-friendly curve exposed on-chain. There is no BN254 verifier
  available, so the whole proof system had to move to a curve Soroban actually supports.
- **arkworks (`ark-groth16`)**, not SnarkJS: an active, well-audited Rust Groth16 implementation
  over BLS12-381 with first-class R1CS constraint gadgets. Rust also compiles straight to a
  cross-platform native module (Android via JNI today, iOS the same way later) and to the same CLI
  binary the backend shells out to — one implementation, three consumers, no reimplementation risk.
- **Jubjub** (`ark-ed-on-bls12-381`) is the curve used for the KYC signature and note-encryption
  keys — chosen because its base field equals BLS12-381's scalar field, so verifying a Jubjub
  signature *inside* a BLS12-381 circuit needs no expensive non-native field arithmetic.

## What's actually in here

```
circuits/
  prover/                    ← the real thing. Everything below is inside this crate.
    Cargo.toml                crate `prova-prover`; cdylib+staticlib+rlib (native module + CLI)
    src/
      lib.rs                  circuit v2: the KYC-inclusive transfer circuit (see below)
      credential.rs            anchor-attested KYC credential: issue, sign, verify (Jubjub EdDSA)
      ffi.rs                   C-ABI surface for the on-device prover (transfer circuit)
      jni_bridge.rs            Android JNI glue (#[cfg(target_os = "android")]) → mobile native module
      pool/                    the shielded pool subsystem (circuit v3) — see below
      bin/prova_prover.rs      the `prova-prover` CLI (setup, proving, artifact generation, dev tools)
    tests/pool_circuits.rs     ~45 black-box tests for shield/spend/fold — the must-fail cases *are*
                               the point: every assertion maps to a way money could be stolen, minted,
                               or lost (see Docs/shielded-pool.md §10.3)
    build-android.sh           cross-compiles the cdylib to .so (arm64-v8a, x86_64) via cargo-ndk,
                               drops the output straight into mobile/modules/prova-prover/.../jniLibs
    Dockerfile                 builds just the CLI binary; the backend's docker-compose copies it
                               into a shared volume and shells out to it (see backend/README.md)
  circuits/, build/, scripts/, node_modules/   ← stale Circom/BN254 leftovers, not used by anything
  README.md                  this file
```

## The two circuit generations

### Circuit v2 — per-transfer proof (`src/lib.rs`)

The original design: one proof per transfer, proving a statement about a transfer amount without
moving custodied value on-chain (the "private balance" is a local counter, not real tokens — see the
shielded pool below for the version that actually custodies funds).

`TransferCircuit` proves, in one Groth16 proof:
- `1 <= amount <= MAX_AMOUNT` (`MAX_AMOUNT = 9999`, a frozen UAE/FEMA placeholder ceiling) via a
  14-bit range check.
- `commitment = Poseidon(amount, secret)` and `nullifier = Poseidon(secret, transferId)` — so a
  transfer is uniquely identifiable and can't be replayed, without revealing the amount.
- The sender holds a **credential the anchor signed** — `sign(userId, kycLevel, expiry)` via
  Poseidon-challenge Schnorr/EdDSA over Jubjub — verified natively *inside* the circuit, with
  `expiry >= currentTime` and `kycLevel >= MIN_KYC_LEVEL` also enforced in-circuit.

Public inputs, frozen order: `[commitment, nullifier, anchorPk.x, anchorPk.y, currentTime]`.

`pub mod soroban_ser` inside `lib.rs` handles the encoding contract with the chain: Soroban's
BLS12-381 host functions expect uncompressed, big-endian points (`Fp` = 48 bytes, `G1` = 96 bytes,
`G2` = 192 bytes with `Fp2 = c1‖c0` limb ordering), and beta/gamma/delta are pre-negated off-chain so
the on-chain verifier reduces to a single `pairing_check` call.

### Circuit v3 — the shielded pool (`src/pool/`)

The real value layer: an actual note/UTXO model where tokens are custodied by a Soroban contract
(`contracts/pool`) and moved privately between notes. See [`Docs/shielded-pool.md`](../Docs/shielded-pool.md)
for the full design; this is the circuit-level summary.

**Frozen parameters** (`pool/mod.rs`) — mirrored bit-for-bit in `shared/src/pool.ts` and
`shared/go/schema/pool.go`; a mismatch here silently makes notes unspendable, not loudly rejected:

| Constant | Value | Meaning |
|---|---|---|
| `DEPTH` | 20 | Merkle tree depth (≈1.05M notes) |
| `BATCH` | 8 | commitments folded per `update_root` call |
| `ROOT_HISTORY` | 32 | how many recent roots a spend may prove against |
| `AMOUNT_BITS` | 64 | range-check width for amounts (prevents field-wraparound minting) |

**Three independent circuits**, each with its own Groth16 setup (`pool::setup::{spend,shield,fold}`,
each XOR'd with a different constant off the shared seed, so changing one circuit never invalidates
another's keys):

- **`shield`** (on-device, at deposit time) — proves a public commitment really commits to the
  amount the user is depositing. Without this a user could deposit 100 while committing to
  1,000,000 and later drain the pool, since the contract itself can never compute a Poseidon hash
  (see below). Also computes the deposit note's encrypted payload in the same proof. Public inputs
  (7): `[commitment, amount, ownerPk, epkX, epkY, encAmount, encRho]`.
- **`spend`** (on-device, at send/cash-out time) — the core private-transfer proof. One note in, two
  notes out (recipient + change — strictly 1-in-2-out, so a wallet with fragmented notes can fail
  even with sufficient total balance). Proves: Merkle membership of the input note (against a root,
  not a position — the anonymity set is every note ever folded into the tree), its nullifier, value
  conservation (`in == out1 + out2 + publicAmount`), range checks on all four amounts, a
  destination-binding constraint (a private transfer must bind `destination == 0`, so it can't be
  replayed to a different address), the two outputs' encrypted payloads, and a fresh KYC credential
  check identical to circuit v2's, but bound to the pool's `ownerSk` instead of the legacy transfer
  secret. Serves both a private transfer (`publicAmount == 0`) and an unshield/cash-out
  (`publicAmount > 0`) — same circuit, so an on-chain observer can't tell which one happened. Public
  inputs (15): `[merkleRoot, nullifier, outCommitment1, outCommitment2, publicAmount, destination, anchorPkX, anchorPkY, currentTime, epkX, epkY, enc1Amount, enc1Rho, enc2Amount, enc2Rho]`.
- **`fold`** (server-side, run by the backend's folder) — the reason the contract never hashes. A
  measured Poseidon permutation costs **~10.97M CPU instructions**; a depth-20 append needs 20 of
  them and blows Soroban's 100M-per-transaction budget outright, so the tree cannot be maintained
  on-chain. `fold` instead proves a batch tree-append is correct off-chain: it witnesses the
  pre-batch tree frontier privately, proves it's consistent with the public `oldRoot`, and proves
  `count` active leaves form an exact prefix of the 8-slot batch (an active-zero-leaf pair would let
  a malicious folder silently drop a queued note — money loss). The contract's `update_root` is
  **permissionless**: the proof enforces correctness, so a folder can neither mint nor steal, only
  stall (delaying new notes from becoming spendable, at no risk to custodied funds). Public inputs:
  `[oldRoot, newRoot, startIndex, count, leaf0..leaf7]` — leaves are deliberately public, since
  that's what stops a folder from inventing notes.

**Supporting modules inside `pool/`:**

| Module | Responsibility |
|---|---|
| `tree.rs` | Native incremental Merkle tree — the off-chain mirror of the on-chain root (the contract itself only ever stores the root, never the tree). Builds Merkle paths as spend-proof witnesses. |
| `gadgets.rs` | In-circuit twins of every native primitive (`hash2`/`hash3`, commitment/nullifier, range checks, Merkle-root recomputation, the fold circuit's frontier walk) — each one must match its native counterpart exactly. |
| `keys.rs` | Wallet key derivation: one master seed → HKDF-SHA256 (domain-separated) → an independent **spending key** (`owner_sk`, can move money) and **encryption key** (`enc`, Jubjub — can only find/decrypt notes, not spend them; the basis for a future viewing key). |
| `encryption.rs` | Note discovery scheme: Jubjub ECDH → Poseidon-derived one-time-pad key → masks `(amount, rho)`. Chosen over SHA-256-based encryption because SHA-256 costs ~42,000 constraints per 64-byte block versus ~14,302 constraints for the *entire* spend circuit. |
| `ffi.rs` | The on-device JSON-in/JSON-out API the mobile app actually calls: `keys_json`, `shield_prove_json`, `spend_prove_json`, `scan_json` (batched trial-decryption over a page of on-chain note candidates), `warm_up` (pre-derives both proving keys, ~1s, meant to run on a background thread at app start). |

## The prover CLI (`prova-prover`)

One binary, dispatched by subcommand, used both as a developer tool and as the backend's KYC/pool
signing mechanism (the Go backend shells out to this binary rather than reimplementing any of the
above — see `backend/README.md`):

| Subcommand | What it does |
|---|---|
| *(none)* | Runs the circuit-v2 setup + prove + verify, writes `verifying_key.bin` / `sample_proof.bin` / `anchor_pubkey.bin` |
| `issue-credential` | Anchor signs `(userId, kycLevel, expiry)`, prints the credential JSON |
| `anchor-pubkey` | Prints the anchor's Jubjub public key as `{"x":..,"y":..}` |
| `prove-json` | Runs a JSON payload through the exact on-device FFI path, prints the proof blob hex |
| `poseidon-params` | Dumps the frozen Poseidon `ark`/`mds` constants for the contract to embed |
| `pool-artifacts` | Generates every artifact `contracts/pool` needs: 3 verifying keys + a full real proof scenario (shield → fold → transfer → fold → unshield → fold-chain) |
| `merkle-path` | Rebuilds a tree from `{"leaves":[...],"index":N}`, prints the sibling path + root — the backend indexer/folder shell out to this instead of reimplementing Poseidon+tree logic in Go |
| `fold-prove` | Proves a fold from `{"leaves":[...],"new":[...]}`, prints the proof + new root. Supports `--pk-cache FILE` to skip ~1.4s of repeated setup |
| `poseidon-hash2` | Prints `Poseidon(a,b)` — ground truth for contract test vectors |
| `user-id` | Prints `user_id = Poseidon(secret, domain)` |

I/O convention throughout: JSON via stdin or `--input FILE`, results as JSON/hex on stdout, binary
artifacts to `--out`. **The deterministic setup randomness (`SETUP_SEED = 42`) is toxic waste and is
public — testnet only.** Mainnet requires a real multi-party trusted-setup ceremony (Phase 5).

## On-device / mobile bindings

`ffi.rs` exposes a plain C ABI (`prova_prove_json`, `prova_user_id`, `prova_string_free`) shared by
Android and (eventually) iOS. `jni_bridge.rs` (Android-only) wraps `ffi.rs` and `pool::ffi` as
`Java_expo_modules_provaprover_ProvaProverModule_native*` JNI symbols matching the Kotlin Expo native
module in `mobile/modules/prova-prover/`. `build-android.sh` cross-compiles the cdylib via
`cargo-ndk` for `arm64-v8a` (real devices) and `x86_64` (emulator) and drops the `.so` files straight
into the mobile module's `jniLibs/`. See `mobile/README.md` for the JS/Kotlin side of this bridge.

## Build & test

```bash
cd circuits/prover
cargo build --release                 # builds the CLI + the cdylib
cargo test                            # unit tests (lib.rs, credential.rs, pool/*.rs)
cargo test --test pool_circuits       # the ~45 shield/spend/fold integration tests

# generate the artifacts contracts/pool embeds at compile time:
cargo run --release --bin prova-prover -- pool-artifacts --out ../../contracts/pool/src/artifacts

# cross-compile the Android native module:
./build-android.sh
```

## Status

Circuit v2 (per-transfer, KYC-inclusive) and circuit v3 (shielded pool: shield/spend/fold) are both
functionally complete and covered by unit + integration tests, including full Groth16
prove/verify round-trips against the real contract-embedded verifying keys. The trusted setup used
everywhere (`SETUP_SEED = 42`) is deterministic and public by design — the one remaining gap before
mainnet is running a real Powers-of-Tau-style ceremony and re-embedding the resulting verification
keys (Phase 5, see [`Docs/implementation-guide.md`](../Docs/implementation-guide.md)).
