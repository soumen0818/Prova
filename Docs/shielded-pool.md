# Prova — The Shielded Pool (real private value)

> The value layer that makes Prova's core claim true. Companion to [proposal.md](proposal.md) (§5),
> [kyc-verification.md](kyc-verification.md) and [deposit-flow.md](deposit-flow.md).
> **This supersedes the "private balance" as a local counter.** Read before touching the circuit,
> the contract, or anything that moves value.

---

## 0. Why this exists — the gap being closed

Today Prova has **two disconnected balances**:

| | What it is | Backed by real value? |
|---|---|---|
| On-chain asset (SRT) | Testnet asset the anchor deposits to the user's Stellar account | ✅ yes, but **public** |
| "Private balance" | A counter in the phone's secure storage | ❌ **no** |

And a ZK transfer today **proves a statement but moves no value**: the contract verifies the proof
and records a commitment + nullifier, but never custodies or transfers an asset.

So the privacy math is real, and the compliance proof is real — but nothing of value flows underneath
them. **The shielded pool is what connects them**: real tokens go in, value moves privately inside,
real tokens come out.

---

## 1. The model — a UTXO "note" pool

Value lives as **notes** (like cash in a wallet), not account balances.

```
note        = (amount, owner_pk, rho)          rho = random per-note nonce
commitment  = Poseidon(amount, owner_pk, rho)  ← this is what goes on-chain (reveals nothing)
nullifier   = Poseidon(owner_sk, rho)          ← published when spent (prevents double-spend)
```

- Your **balance** = the sum of your notes that have not been nullified.
- The contract keeps an **append-only Merkle tree of every commitment** ever created, and a **set of
  spent nullifiers**.
- To spend, you prove *in zero knowledge*: "I know a note whose commitment is **somewhere** in the
  tree, I own it, and here is its nullifier" — without revealing **which** note.

That last property is the whole point: the anonymity set is every note in the tree.

### Three operations

| Operation | Public | Private | Effect |
|---|---|---|---|
| **Shield** | amount, sender | — | Tokens move into the pool contract; one note commitment is added |
| **Transact** | proof, nullifier, new commitments | **amounts, sender, recipient** | Spend a note → create recipient note + change note |
| **Unshield** | amount out, destination | which note was spent | Spend a note → contract releases tokens |

**Shield is public on purpose** — the anchor already knows the deposit (they did KYC and owe Travel
Rule data). Privacy is required *in transit*, which is exactly what **Transact** provides:
on-chain a watcher sees only a nullifier and two commitments.

---

## 2. What the circuit must prove (v3)

Circuit v3 replaces v2. It keeps the KYC credential check (Prova's differentiator) and adds the pool.

**Public inputs:** `merkleRoot`, `nullifier`, `outCommitment1`, `outCommitment2`, `publicAmount`,
`anchorPk.x`, `anchorPk.y`, `currentTime`

**Private witnesses:** the input note (`amount`, `rho`, `owner_sk`), its **Merkle path + index**, the
two output notes, and the KYC credential + signature.

**Constraints:**

1. **Merkle membership** — recompute the root from the input note's commitment + path; it must equal
   the public `merkleRoot`. *(Proves the note exists without revealing which one.)*
2. **Ownership** — `owner_pk` derives from `owner_sk`.
3. **Nullifier correctness** — `nullifier = Poseidon(owner_sk, rho)`. Deterministic per note, so a
   second spend collides and is rejected on-chain.
4. **Output commitments** — each is a correct `Poseidon(amount, owner_pk, rho)`.
5. **Value conservation** — `inAmount = out1 + out2 + publicAmount`. **Non-negotiable**: without it,
   money can be printed.
6. **Range checks** — every amount is in `[0, 2^64)` so wrap-around can't fake conservation.
7. **KYC** — the anchor-signed credential is valid, unexpired, and of sufficient level *(carried over
   from v2)*.

`publicAmount = 0` → a fully private transfer. `publicAmount > 0` → an unshield. One circuit, both
operations.

### Cost estimate (to be measured, not trusted)

| Piece | Approx. constraints |
|---|---|
| Merkle path (depth 20) | ~5,000 |
| Poseidon (nullifier + 2 commitments + ownership) | ~1,200 |
| Range checks (4 × 64-bit) | ~256 |
| Value conservation | trivial |
| **KYC EdDSA (carried from v2)** | **~3,000** |
| **Total** | **~10,000** |

v2 is ~4–5k constraints. So v3 is roughly **2–3× the proving time**. On-device measurement is a
**gate**, not a formality — see §7 Risks.

---

## 3. What the contract must do (v3)

The verifier becomes a **vault**. New responsibilities:

1. **Custody** — hold the SEP-41 / Stellar Asset Contract token (SRT on testnet). `shield` pulls
   tokens in; `unshield` sends them out.
2. **Incremental Merkle tree** — append commitments, recompute the root cheaply, and keep a **rolling
   history of recent roots** (a proof is built against a root that may be a few blocks stale; without
   history, every concurrent transfer would fail).
3. **Nullifier set** — reject any repeat (already exists in v2).
4. **Events** — emit each new commitment + its **encrypted note payload**, so recipients can find
   their money (§4).

```
shield(from, amount, commitment)              → pulls tokens, appends commitment
transact(proof, root, nullifier, c1, c2, …)   → verifies, nullifies, appends 2 commitments
unshield(proof, …, publicAmount, destination) → verifies, nullifies, appends change, pays out
```

**Poseidon on-chain is the open question.** The tree must be hashed with the *same* function as the
circuit. Soroban has no native Poseidon, so either the contract implements it in Rust (CPU-budget
risk — must be measured early) or the design shifts the tree update off-chain with a proof. **This is
the single biggest technical unknown and gets spiked first (V1.0).**

---

## 4. Note discovery — how the recipient finds their money

A note is useless if its owner can't see it. Standard solution (Zcash's):

- Each output note is **encrypted to the recipient's public key** and emitted in the transaction event.
- Wallets **scan** new events and **trial-decrypt** each one; what decrypts is yours.
- The chain sees ciphertext only.

This requires: an encryption keypair per user (derived from the same master seed — see
[account-recovery.md](account-recovery.md)), and a scan cursor in the wallet. **Notes must be included
in the encrypted cloud backup**, or a restored phone can't spend money it owns.

---

## 5. Roadmap

Ordered; each stage ships something verifiable. Stages **V1** and **V2** are the hard ones.

### V0 — Design freeze *(no code)*
Freeze in `prova-shared`: note format, commitment/nullifier derivation, tree depth + hash, circuit
public-input order, event schema. Everything downstream depends on these being stable.

### V1 — Circuit v3
- **V1.0 spike (gate):** Poseidon Merkle verification **in a Soroban contract**, measured against the
  CPU budget. If it doesn't fit, redesign the tree strategy *before* writing the circuit.
- Merkle membership gadget + note commitment/nullifier + value conservation + range checks.
- Keep the KYC credential check.
- **Must-fail tests:** double-spend, value inflation, wrong root, forged note, expired credential.
- New trusted setup (seeded for testnet), export VK.
- **Benchmark constraints + on-device proving time.**

### V2 — Contract v3
- Incremental Merkle tree + root history.
- Nullifier set (carried over).
- Token custody via the SAC/SEP-41 client.
- `shield` / `transact` / `unshield` + events carrying encrypted notes.
- Tests: shield→transact→unshield end-to-end, replay rejected, value conserved, stale-root handling.

### V3 — Backend
- **Indexer** rebuilds the tree from events and serves **Merkle paths** to wallets.
- Serves encrypted note events for scanning (paginated, by cursor).
- Relayer submits `transact`/`unshield` (so the user's Stellar account isn't linked to the spend).

### V4 — Mobile
- **Note store** in the enclave; balance = sum of unspent notes.
- Scanning + trial decryption; spend selection.
- Shield / send / unshield flows on the new circuit.
- Notes added to the encrypted cloud backup.

### V5 — Integration & hardening
- Full testnet run: deposit → shield → private send → unshield → payout.
- Fragmentation handling, failure/timeout paths, concurrency.
- Threat-model pass; audit preparation.

---

## 6. Decisions taken

1. **Public shield, private transact.** The anchor sees the deposit (it already must); the transfer is
   private. Preserves the golden rule: *on-chain, only commitments, nullifiers and proofs*.
2. **1 input, 2 outputs** for v3. Covers remittance (recipient + change) at roughly half the proving
   cost of 2-in-2-out. Trade-off: notes can't be merged, so a wallet holding many small notes can't
   combine them — revisit if fragmentation shows up in practice.
3. **One circuit for transfer and unshield**, via `publicAmount` (0 = private transfer). Fewer
   circuits, one trusted setup, one verification key.
4. **Keep KYC in-circuit.** It is Prova's differentiator; dropping it to save constraints would gut
   the product.
5. **Fixed tree depth 20** (~1M notes). Enough for testnet and well beyond an MVP's traffic.
6. **A note is owned by any public key.** The pool does not care whether the owner is a payout anchor
   (remittance) or another user (P2P) — the circuit and contract are identical either way. This keeps
   both product flows open and defers that decision to V4 (mobile), at the cost of a little extra app
   surface.

## 7. Risks — stated plainly

| Risk | Why it matters | Mitigation |
|---|---|---|
| **On-chain Poseidon cost** | If Merkle updates blow the Soroban CPU budget, the whole design changes | **V1.0 spike before any circuit work** |
| **Proving time on a phone** | ~2–3× v2; this is already the proposal's #1 product risk | Measure on-device at V1; if too slow, cut tree depth or revisit 1-in-2-out |
| **Value bugs mint money** | A flaw in conservation or nullifiers is catastrophic and irreversible | Must-fail tests first; **independent audit before mainnet** |
| **Note loss = fund loss** | If a wallet loses its notes it cannot spend, even with the right keys | Notes in the encrypted cloud backup + recoverable from chain by scanning |
| **Anonymity set** | With few users, timing/amount correlation can deanonymize | Honest limitation; improves with adoption. Do not overclaim privacy early |

## 8. Explicitly out of scope (for now)

Proof aggregation, multi-asset pools, 2-in-2-out consolidation, viewing keys for selective
disclosure, and mainnet deployment. Each is a follow-on once the pool works.

---

## 9. Build environment — Rust must be built on Linux

**Finding (Windows dev machine):** Rust cannot compile here. The active toolchain is
`stable-x86_64-pc-windows-msvc`, which needs the MSVC linker, and **Visual Studio Build Tools are not
installed** (`link.exe` missing, `vswhere` absent). A `cargo build` fails at the link step for every
crate. Git Bash makes it worse by shadowing `link.exe` with GNU coreutils' `link`.

Two ways forward — **Linux is the chosen path**:

| Option | Notes |
|---|---|
| **Linux (chosen)** | Native `cargo`. Fastest iteration; also what CI uses |
| Docker on Windows | `circuits/prover/Dockerfile` already builds with `rust:1-bookworm`. Works, but slower and awkward for the Soroban contract |

Everything **non-Rust** (shared schemas, Go backend, TypeScript app) builds fine on Windows and is
unaffected.

### Setup on Linux

```bash
# Rust + wasm target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# Soroban CLI (contract build/deploy)
cargo install --locked stellar-cli

# Sanity check: the existing v2 code must build before starting v3
cd circuits/prover && cargo test
cd ../../contracts   && cargo test
```

---

## 10. Remaining work — precise specification

Everything below is **Rust** and is the work to do on Linux. `prova-shared` (§V0) is already frozen
and is the contract these must satisfy — read `shared/src/pool.ts` alongside this section.

### V1.0 — GATE: measure on-chain Poseidon *(do this first)*

Do **not** write the circuit before this is answered. If the Merkle update doesn't fit Soroban's
100M-instruction budget, the design changes.

**Good news already established:** Soroban's `soroban-sdk` 22 exposes BLS12-381 **scalar-field host
functions** — `fr_add`, `fr_sub`, `fr_mul`, `fr_pow`, `fr_inv` on `env.crypto().bls12_381()`. That is
*exactly* our circuit's field, so Poseidon can be implemented on-chain with host arithmetic rather
than hand-rolled big-integer math.

**Task:**
1. Export the frozen constants (a `poseidon-params` subcommand has been **added to
   `circuits/prover/src/bin/prova_prover.rs` but never compiled** — verify it first):
   ```bash
   cargo run --bin prova-prover -- poseidon-params --out poseidon_params.bin
   # expect: rounds=65 width=3 ark=65x3 mds=3x3 bytes=6528
   ```
2. Implement the permutation in a Soroban contract using host `Fr` ops:
   `width 3, alpha 5, 8 full rounds + 57 partial rounds` — for each round: add round constants →
   S-box (`x^5`; full rounds apply it to all 3 lanes, partial rounds only to lane 0) → 3×3 MDS
   multiply.
3. Measure with `env.cost_estimate().budget()` in a test:
   - one permutation
   - one **depth-20 Merkle append** (~20 permutations)
   - a `transact` (**2 appends ≈ 40 permutations**) ← the number that actually decides this

**Pass/fail:** a `transact` must fit comfortably inside the 100M CPU budget with headroom for the
pairing check (~44.6M measured in Phase 1 — see phase1-findings.md). **If it doesn't fit**, fall back
to one of: reduce tree depth; batch/defer insertions; or move the tree update into the circuit
(prove the new root) so the contract stores a root and hashes nothing.

### V1 — Circuit v3 (`circuits/prover`)

Replace `TransferCircuit` (v2) with the pool circuit. Public inputs **in this exact order**
(`POOL_PUBLIC_INPUTS` in `shared/src/pool.ts`):

```
[merkleRoot, nullifier, outCommitment1, outCommitment2, publicAmount, anchorPkX, anchorPkY, currentTime]
```

Private witnesses: input note (`amount`, `rho`, `ownerSk`), its Merkle path + leaf index, both output
notes, and the KYC credential + signature.

Constraints to enforce (all mandatory — see §2):
1. **Merkle membership** — fold the path with Poseidon; result must equal `merkleRoot`. Use the leaf
   index bits to choose left/right ordering at each level.
2. **Ownership** — `ownerPk == Poseidon(ownerSk, PoolDomain.OWNER)`.
3. **Nullifier** — `nullifier == Poseidon(ownerSk, rho)`.
4. **Output commitments** — each `== Poseidon(amount, ownerPk, rho)`.
5. **Value conservation** — `inAmount == out1 + out2 + publicAmount`. *Miss this and money can be printed.*
6. **Range** — all four amounts in `[0, 2^64)`, so wrap-around can't fake conservation.
7. **KYC** — reuse the v2 gadget unchanged (signature, expiry, level).

**Must-fail tests** (a passing test suite without these is meaningless):
double-spend (reused nullifier) · value inflation (`out > in`) · wrong/unknown root · forged note not
in the tree · tampered output commitment · expired credential · forged anchor signature.

Then: new trusted setup (seeded, testnet-grade), export the VK blob for the contract, and
**benchmark constraint count + on-device proving time** (the proposal's #1 product risk).

### V2 — Contract v3 (`contracts/pool`, new crate)

1. **Poseidon** — the module from the V1.0 spike, using host `Fr` ops.
2. **Incremental Merkle tree** — store the `filled_subtrees` frontier + `next_index`; on append, walk
   up 20 levels combining with either the incoming hash or the precomputed zero-subtree hash. Keep a
   rolling **`MerkleRootHistory = 32`** ring of roots and accept a proof against **any** of them.
3. **Nullifier set** — reuse v2's persistent-storage pattern; reject repeats.
4. **Token custody** — `soroban_sdk::token::Client` (SEP-41 / Stellar Asset Contract). `shield` calls
   `transfer(from → contract)`; `unshield` calls `transfer(contract → destination)`.
5. **Entrypoints** — `shield`, `transact`, `unshield` (see §3), each emitting a `NoteEvent` per new
   commitment with the encrypted payload.
6. **Verifier** — the v2 pairing check, with the VK swapped for v3's and `9` IC entries (8 public
   inputs + 1).

**Tests:** shield → transact → unshield end-to-end; replayed nullifier rejected; proof against a
stale-but-in-window root accepted; proof against an evicted root rejected; token balances conserved.

### V3 / V4 — deliberately not started

The backend indexer and the wallet's note layer are **intentionally deferred** until V1/V2 exist,
because both depend on artifacts only those produce (the VK, the real event shape, and the prover
CLI's Merkle commands). Building them now would be speculation.

One design decision is already made, to avoid a duplicate Poseidon in Go: the backend should **shell
out to the `prova-prover` CLI** for Merkle path computation, exactly as it already does for
credential signing — so the hash lives in one place (Rust) and can never drift from the circuit.

---

## 11. Status

| Stage | State |
|---|---|
| **V0 — design freeze** | ✅ **Done** — frozen in `shared/src/pool.ts` + `shared/go/schema/pool.go`; both build |
| V1.0 — on-chain Poseidon gate | ⬜ Linux — §10. `poseidon-params` CLI added but **never compiled** |
| V1 — circuit v3 | ⬜ Linux — §10 |
| V2 — contract v3 | ⬜ Linux — §10 |
| V3 — backend | ⬜ blocked on V1/V2 |
| V4 — mobile | ⬜ blocked on V1/V2 |
| V5 — integration | ⬜ blocked |
