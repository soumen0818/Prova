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
`destination`, `anchorPk.x`, `anchorPk.y`, `currentTime`, and the six encrypted-note fields
(`epkX`, `epkY`, `enc1Amount`, `enc1Rho`, `enc2Amount`, `enc2Rho`) — **15 in total**.

> **`destination` was added after the V0 freeze, and it closes a fund-theft hole.** Without it an
> unshield proof binds the *amount* leaving the pool but not *who receives it*, so anyone watching the
> mempool could resubmit the same valid proof with their own address substituted and take the payout.
> Binding it as a public input makes the proof valid for exactly one destination. It is `0` for a
> private transfer (`publicAmount = 0`), where nothing leaves the pool.

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

The verifier becomes a **vault**. Responsibilities:

1. **Custody** — hold the SEP-41 / Stellar Asset Contract token (SRT on testnet). `shield` pulls
   tokens in; `unshield` sends them out.
2. **Commitment queue** — new commitments are *queued*, not hashed into the tree (see the box below).
3. **Merkle root + history** — store the current root and a **rolling history of recent roots**, and
   accept a spend proof against any of them. Without history, concurrent transfers would all fail.
4. **Nullifier set** — reject any repeat (already exists in v2).
5. **Events** — emit each new commitment + its **encrypted note payload**, so recipients can find
   their money (§4).

> ### The contract never hashes — this is the defining constraint
>
> The V1.0 gate **failed** (§10.1). One Poseidon permutation costs **10,967,507 CPU instructions**
> against Soroban's 100M per-transaction budget, so the contract can afford **9 hashes** and a
> depth-20 append needs **20** — a single insertion cannot run to completion, let alone the ~40 a
> transfer needs.
>
> So the tree update is **deferred and batched**: spends queue their commitments, and a separate
> permissionless `update_root` call folds a batch into the tree by *verifying a proof* that the
> transition is correct. Verifying is a fixed cost regardless of the work proved, which is exactly the
> property that makes this affordable. §10.2 has the measurements and the alternatives that were
> rejected.

```
shield(from, amount, note, proof)                → pulls tokens, queues 1 commitment
transact(proof, root, nullifier, out)            → verifies, nullifies, queues 2 commitments
unshield(proof, …, amount, destination)          → verifies, nullifies, queues change, pays out
update_root(proof, newRoot, count)               → folds up to 8 queued commitments into the tree

upgrade / set_anchor / set_paused / set_admin    → admin only; see §10.6 for the trust model
```

**Consequence for users:** a note is spendable only once the fold that contains it has landed. With
`update_root` running on a short timer this is a few seconds — invisible next to a remittance corridor
measured in days — but it is a real ordering constraint the wallet and indexer must respect (§4).

---

## 4. Note discovery — how the recipient finds their money

A note is useless if its owner can't see it. Standard solution (Zcash's):

- Each output note is **encrypted to the recipient's public key** and emitted in the transaction event.
- Wallets **scan** new events and **trial-decrypt** each one; what decrypts is yours.
- The chain sees ciphertext only.

**The encryption happens inside the spend circuit** (Jubjub ECDH + a Poseidon one-time pad), so the
payload is a proof public input rather than an attachment. That is what stops whoever submits the
transaction from corrupting a recipient's discovery message and making their money permanently
unfindable — see §10.5 for the construction and the measured cost.

This requires: an encryption keypair per user (Jubjub, derived from the same master seed — see
[account-recovery.md](account-recovery.md)), and a scan cursor in the wallet. Notes should still be
included in the encrypted cloud backup as a convenience, but a wallet restored from **seed alone** can
now rediscover every note it owns by scanning.

---

## 5. Roadmap

Ordered; each stage ships something verifiable. Stages **V1** and **V2** are the hard ones.

### V0 — Design freeze *(no code)*
Freeze in `prova-shared`: note format, commitment/nullifier derivation, tree depth + hash, circuit
public-input order, event schema. Everything downstream depends on these being stable.

### V1 — Circuits v3 *(three of them — see §10.3)*
- **V1.0 spike (gate):** Poseidon Merkle verification **in a Soroban contract**, measured against the
  CPU budget. ✅ **Done — and it failed**, which is what forced the batched design (§10.1).
- **Spend circuit** — Merkle membership + note commitment/nullifier + value conservation + range
  checks + destination binding, keeping the KYC credential check.
- **Shield circuit** — binds a deposit's public amount to its commitment (without it, money can be
  minted; §10.3).
- **Fold circuit** — proves a batch of queued commitments appends correctly, `oldRoot → newRoot`.
- **Must-fail tests:** double-spend, value inflation, wrong root, forged note, expired credential,
  forged frontier, out-of-order fold.
- New trusted setup (seeded for testnet), export all three VKs.
- **Benchmark constraints + on-device proving time.**

### V2 — Contract v3
- Commitment queue + Merkle root history (**no on-chain hashing**).
- Nullifier set (carried over).
- Token custody via the SAC/SEP-41 client.
- `shield` / `transact` / `unshield` / `update_root` + events carrying encrypted notes.
- Tests: shield→fold→transact→fold→unshield end-to-end, replay rejected, value conserved,
  stale-root accepted, evicted-root rejected, unspendable-before-fold.

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

*Taken after the V1.0 gate (§10), which invalidated the on-chain-tree assumption:*

7. **The tree update is deferred and batched**, proved by a separate `update_root` circuit. Forced by
   the measurement, not chosen — the contract cannot afford a single Poseidon append (§10.1).
8. **Three circuits, not one** — spend, shield, fold. Each independently auditable, and the
   money-critical value-conservation logic stays out of the paths that do not need it.
9. **`destination` is bound into the spend proof** (9th public input). Without it an unshield proof is
   replayable against an attacker's address — a fund-theft hole in the original freeze (§2).
10. **Batch size 8**, from the measured public-input cost (§10.2). Tunable upward to 16; 32 does not fit.

## 7. Risks — stated plainly

| Risk | Why it matters | Mitigation |
|---|---|---|
| ~~**On-chain Poseidon cost**~~ | ~~If Merkle updates blow the Soroban CPU budget, the whole design changes~~ | ✅ **Measured, and it does blow the budget** — design changed to batched inserts (§10) |
| **Folder liveness** | If nobody calls `update_root`, new notes never become spendable | Permissionless — anyone can fold. Run it on the V3 relayer; alert on queue depth. Custodied funds are never at risk, only newly-created notes are delayed |
| **Admin key compromise** | The upgrade key can install code that drains the pool — the price of being able to fix a bug at all | Hardware-held, **2-of-3 multisig before mainnet** (`set_admin`). Every admin action emits an event, and a pause can never block withdrawals (§10.5) |
| **Anchor key compromise** | Forged KYC credentials let anyone use the pool uncontrolled — a compliance failure, not theft | `set_anchor` rotates it and kills every credential signed by the old key. Rotate on a schedule, not only after an incident |
| **Fold latency** | A note is unspendable until its batch lands; too slow and the wallet feels broken | Batch size 8 with a short timer; wallet shows notes as "confirming" until folded |
| ~~**Tampered note ciphertext**~~ | ~~A relayer could corrupt the encrypted payload so the recipient can never find their note~~ | ✅ **Closed.** Note encryption moved *inside* the circuit (Jubjub ECDH + Poseidon pad), so the payload is a public input the proof covers. Corrupting any part of it now rejects the transaction instead of stranding the money — §10.6 |
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

## 10. The measured design — what gets built and why

Everything below rests on numbers measured on this machine, not estimates. The tests that produce
them live in `contracts/pool/src/test.rs` and `circuits/prover/tests/gadget_costs.rs`, so the findings
are executable rather than folklore — if Soroban's pricing ever changes, they fail loudly.

`prova-shared` (§V0) is the cross-repo contract these must satisfy; read `shared/src/pool.ts`
alongside this section.

### 10.1 — The V1.0 gate: FAILED

The gate asked whether a Poseidon Merkle update fits Soroban's **100M CPU** per-transaction budget.

| Measurement | Value |
|---|---|
| One Poseidon permutation (= one tree node) | **10,967,507** |
| — of which, decoding round constants | 764,145 |
| — of which, the permutation itself | 10,203,362 |
| Depth-8 append (8 permutations) | 82,354,608 |
| **Max permutations per invocation** | **9** |
| Needed for one append (depth 20) | 20 |
| Needed for one `transact` (2 appends) | **40** |

A depth-20 append extrapolates to ~219M and a `transact` to ~439M — before the pairing check. **The
contract cannot complete even one insertion.** Depth 20 is not measurable directly: past ~8 levels the
budget is exhausted outright, which is an uncatchable host abort.

**Why it is this expensive.** One permutation is 601 host calls (325 `fr_add`, 195 `fr_mul`, 81
`fr_pow`). Priced individually:

| Host call | CPU |
|---|---|
| `fr_add` | 8,014 |
| `fr_mul` | 8,272 |
| `fr_pow(5)` | 8,262 |

They are within 3% of each other. Adding two field elements cannot genuinely cost the same as raising
one to the fifth power, so the arithmetic is not what is being paid for — **the per-host-call boundary
is**. Reading `soroban-sdk` 22's `crypto/bls12_381.rs` confirms it: every call reconstructs the field
modulus and range-checks operands that are already reduced by construction. 601 × ~8,100 ≈ 4.9M of
pure overhead per hash, against a target of ~1.2M to fit. No amount of tuning closes that gap, and the
SDK exposes no way to batch or amortise it.

**What did work:** the implementation in `contracts/pool/src/poseidon.rs` is byte-for-byte identical
to the circuit's hash, verified against vectors generated by `prova-prover poseidon-hash2`. It is
correct; it simply cannot run on-chain. It is kept because the fold circuit's zero-subtree constants
and the indexer both need a Rust Poseidon, and because the gate test asserts the *negative* result —
if Soroban's scalar ops ever get cheap enough, the assertion fires and this decision is worth
revisiting.

### 10.2 — The replacement: defer and batch the tree update

The contract was doing two jobs with opposite requirements: **spending** (must be cheap, on a phone,
concurrent) and **tree maintenance** (hash-heavy, but nobody is waiting on it). Welding them together
is what dragged 40 hashes into the one budget that cannot afford them. So they are split:

- **Spending never touches the tree.** A spend proves membership against a root already in the
  contract's history ring. Zero hashing, and concurrent spends stop colliding — which is precisely
  what the 32-root window was frozen for.
- **New commitments are queued.** A persistent write costs **15,390** CPU. Effectively free.
- **A separate `update_root` folds a batch in**, by verifying a proof of the `oldRoot → newRoot`
  transition. The hashing happens *inside that proof*, generated on a server where an 11M-CPU
  permutation is irrelevant. Verification is a fixed cost no matter how much work it represents.

Nothing new is trusted. The folder cannot mint, steal, or spend — a bad fold produces a proof that
fails verification. Its only power is to stop working, which delays new notes becoming spendable and
puts no custodied funds at risk.

#### How the fold proof binds to the queued commitments

The proof must cover *exactly* the commitments the contract queued, or the folder could insert notes
of its own invention. Two mechanisms were measured:

| | On-chain cost | In-circuit cost | Verdict |
|---|---|---|---|
| Commitments as Groth16 **public inputs** | **1,492,160** per input (MSM) | none | ✅ chosen |
| **SHA-256** accumulator the circuit re-derives | 12,422 per hash | **~42,000 constraints per 64-byte block** | rejected |

SHA-256 is ~120× cheaper on-chain but catastrophic in-circuit: a Poseidon 2→1 is **240** constraints,
a SHA-256 block is **~42,000**. Binding 8 commitments that way would cost ~170k constraints against
~43k for the entire rest of the fold circuit — it would *quadruple* the fold's proving time to save
on-chain budget that is not scarce. Public inputs win.

The tradeoff is that public inputs cap the batch size, projected from a real verify (`prova-verifier`
with 5 public inputs costs **49,048,967**):

| Batch size | Public inputs | Projected verify cost | |
|---|---|---|---|
| 8 | 12 | ~60M | ✅ **chosen** — 40M headroom |
| 16 | 20 | ~71M | possible, thin |
| 32 | 36 | ~95M | ✗ no room for storage, events, custody |

**Confirmed against the built contract** (`test::all_operations_fit_the_cpu_budget`), which is the
number that actually matters — full entrypoints including custody, storage and events:

| Operation | Measured CPU | Budget used |
|---|---|---|
| `shield` | 46,293,144 | 46% |
| `transact` | 55,217,538 | 55% |
| `update_root` (batch 8) | 59,845,219 | 60% |

> #### A fold costs the same whether it carries 1 commitment or 8
>
> Measured (`test::fold_cost_by_batch_size`): **59,715,007** at `count = 1` versus **59,845,219** at
> `count = 8` — a marginal **18,601** per commitment. The verifier's MSM runs over the circuit's
> *fixed* public-input count (always `4 + BATCH`, with unused slots zero), so it does not care how
> many slots are live. 93% of the cost is the fixed pairing check.
>
> Two consequences, and the second is the one that matters:
>
> 1. **Partial folds are free.** Folding one commitment the moment it arrives costs the same as
>    waiting for eight, so the folder should optimise purely for latency, never for batching economy.
> 2. **There is no runtime escape hatch.** The intuitive recovery — "if a fold gets too expensive,
>    fold fewer at a time" — does nothing. If `update_root` ever exceeded the budget, the only fix
>    would be a smaller `BATCH`, which means a new circuit, a new trusted setup, a new VK and a
>    redeployed contract. This is why the tests enforce a **75M safety ceiling** rather than the real
>    100M limit: the 25-point margin exists to buy time for that, not to be spent.
>
> It also settles `BATCH`. Lowering it to 4 would save only ~6M (four fewer public inputs at ~1.49M
> each) while halving throughput; raising it to 16 costs ~12M and lands at ~72M, past the ceiling. **8
> is the safe choice, and shrinking it trades real capacity for negligible margin.**

**`MerkleParams.BATCH = 8`** — four transfers per fold. `update_root` may fold *fewer* than 8 so a
quiet period never strands a note; unused slots are inactive, not padded, so no tree capacity is
wasted (padding every fold would exhaust the 2^20 tree in days).

#### Alternatives rejected

- **A cheaper hash (SHA-256/Keccak for the tree).** Cheap on-chain, ~42k constraints per block
  in-circuit — a depth-20 membership proof becomes ~840k constraints and the phone cannot prove it.
  This inversion is the whole reason Poseidon exists.
- **A shallower tree.** Fitting 9 hashes means depth 8 — a pool holding 256 notes ever.
- **Proving the tree update inside the spend circuit** (the fallback §10 originally named). Fails on
  *concurrency*, not cost: such a proof is welded to the exact root it was built on, so of two
  simultaneous spends one is always rejected and must re-prove. The pool would serialise, defeating
  the root-history window. Also ~4.2× the spend circuit size.

This deferred-batch shape is not a workaround — it is what **Aztec** and every zk-rollup does. The
on-chain-tree designs (Tornado Cash, Railgun) work because EVM gas is permissive; Zcash and Penumbra
work because they are purpose-built L1s whose own node software updates the tree with no metering at
all. Soroban is a metered contract platform with a tight budget and **no native Poseidon** — chains
that take ZK seriously ship one as a precompile. Until Stellar does, batching is the standard answer.

### 10.3 — V1: three circuits (`circuits/prover`)

Splitting into three small circuits rather than one large one is deliberate: each is independently
auditable, and the money-critical logic stays out of the paths that do not need it.

#### (a) Spend circuit — `SpendCircuit`

Replaces v2's `TransferCircuit`. Public inputs **in this exact order** (`POOL_PUBLIC_INPUTS`):

```
[merkleRoot, nullifier, outCommitment1, outCommitment2, publicAmount, destination,
 anchorPkX, anchorPkY, currentTime]
```

Private witnesses: input note (`amount`, `rho`, `ownerSk`), its Merkle path + leaf index, both output
notes, and the KYC credential + signature.

1. **Merkle membership** — fold the path with Poseidon; result must equal `merkleRoot`. Leaf-index
   bits choose left/right at each level.
2. **Ownership** — `ownerPk == Poseidon(ownerSk, PoolDomain.OWNER)`.
3. **Nullifier** — `nullifier == Poseidon(ownerSk, rho)`.
4. **Output commitments** — each `== Poseidon(amount, ownerPk, rho)`.
5. **Value conservation** — `inAmount == out1 + out2 + publicAmount`. *Miss this and money is printed.*
6. **Range** — all four amounts in `[0, 2^64)`, so wrap-around cannot fake conservation.
7. **KYC** — the v2 gadget unchanged (signature, expiry, level).
8. **Destination binding** — `destination` is constrained into the proof (as a witness the circuit
   simply enforces equal to the public input), so a valid proof cannot be replayed against a
   different payout address. `0` for a private transfer.

**Must-fail tests:** double-spend (reused nullifier) · value inflation (`out > in`) · wrong/unknown
root · forged note not in the tree · tampered output commitment · expired credential · forged anchor
signature · substituted destination.

#### (b) Shield circuit — `ShieldCircuit`

**Why it exists.** `shield` is the one place a commitment enters the pool without a spend proof
behind it. The contract cannot compute Poseidon, so it cannot check that the commitment the user
hands it actually commits to the amount deposited — a user could transfer 100 and commit to
1,000,000, then unshield the pool dry. Having the *fold* circuit check it does not work either: that
needs the user's private `rho`, which the folding server never sees. Hence a dedicated proof.

Public inputs: `[commitment, amount, ownerPk]`. Private: `rho`.

1. `commitment == Poseidon(amount, ownerPk, rho)`
2. `amount` in `[0, 2^64)`

~1k constraints; sub-second on-device. The contract checks `amount` equals the tokens actually
transferred, which is what closes the hole.

#### (c) Fold circuit — `FoldCircuit`

Public inputs: `[oldRoot, newRoot, startIndex, count, leaf0 … leaf7]` (12 total).
Private witness: the **frontier** (`filled_subtrees[20]`).

1. **Frontier consistency** — recompute the root from the frontier at position `startIndex` (walking
   20 levels, combining with precomputed zero-subtree hashes) and enforce it equals `oldRoot`. A
   second frontier matching the same root would be a Merkle collision, so this binds it.
2. **Appends** — for `i in 0..8`, if `i < count`, insert `leaf[i]` at index `startIndex + i`,
   updating the frontier; otherwise leave it unchanged. Index bits are decomposed and constrained to
   equal `startIndex + i`.
3. **Result** — the root after the last active append must equal `newRoot`. With `count == 0`,
   `newRoot == oldRoot`.

~180 Poseidon hashes ≈ 43k constraints. Server-side, so proving is fast and the batch size is free to
grow later.

Zero-subtree constants: `zeros[0] = EMPTY_LEAF = 0`, `zeros[i+1] = Poseidon(zeros[i], zeros[i])`.
Shared by circuit, contract and indexer.

#### Measured results

Trusted setup is seeded and reproducible (`prova-prover pool-artifacts`), so the deployed VKs can be
re-derived and checked against source. Constraint counts and proving times, from
`tests/pool_circuits.rs`:

| Circuit | Constraints | Setup | Prove | Runs on |
|---|---|---|---|---|
| **spend** | **24,729** (v2: 7,758 — 3.2×) | 2,230 ms | **918 ms** | the phone |
| **shield** | 6,684 | 1,171 ms | 245 ms | the phone |
| **fold** | 43,981 | 1,427 ms | 1,442 ms | a server |

Desktop figures, so not a handset number. The spend circuit grew from 14,302 to 24,729 when note
encryption moved in-circuit (§10.5) — a deliberate trade that closed a fund-loss hole. On-device
measurement stays a V4 gate and remains the #1 product risk.

### 10.4 — V2: contract v3 (`contracts/pool`)

1. **Storage** — current `Root`; `RootHistory` ring of 32; `NextIndex`; nullifier set; the commitment
   queue (`QueueHead`, `QueueTail`, `Queued(i)`). Nullifiers and the queue are persistent and must
   have their TTL extended on touch — an archived nullifier would re-enable a double-spend.
2. **No hashing.** The contract never calls Poseidon. `poseidon.rs` stays for tests and constants only.
3. **Verifier** — the v2 pairing check, generalised over three embedded VKs (9, 3 and 12 public
   inputs → 10, 4 and 13 IC entries).
4. **Token custody** — `soroban_sdk::token::Client` (SEP-41 / SAC). `shield` transfers `from →
   contract`; `unshield` transfers `contract → destination`.
5. **Entrypoints**
   - `shield(from, amount, commitment, proof)` — verify the shield proof against the *actual*
     transferred amount, pull tokens, queue the commitment, emit its encrypted note.
   - `transact(proof, root, nullifier, c1, c2, encrypted…)` — root must be in history; nullifier
     unspent; verify; record nullifier; queue both commitments; emit.
   - `unshield(…, publicAmount, destination)` — same, plus `destination` bound in the proof, and
     transfer `publicAmount` out.
   - `update_root(proof, newRoot, count)` — read `count ≤ 8` commitments from the queue head, pass
     them as public inputs, verify, advance the root + history ring, advance `QueueHead`/`NextIndex`.
6. **Events** — a `NoteEvent` per new commitment carrying the encrypted payload, for wallet scanning.

**Tests:** shield → fold → transact → fold → unshield end-to-end; replayed nullifier rejected; proof
against a stale-but-in-window root accepted; proof against an evicted root rejected; spend of an
unfolded note rejected; fold with tampered leaves rejected; token balances conserved across the whole
run.

### 10.5 — Note encryption: why it lives inside the circuit

A commitment reveals nothing, not even to its owner, so each note ships with an encrypted message
telling the recipient *"this leaf is yours"*. Wallets scan and trial-decrypt; what opens is theirs.

**The flaw in doing that outside the proof.** A payload that merely travels alongside a proof is not
covered by it. Whoever submits the transaction could corrupt those bytes: the money stays on-chain
and stays the recipient's, nobody else can ever spend it — but their wallet can never *find* it.
Functionally identical to losing it, and only recoverable if the sender still holds their own copy.

**Why the obvious fix was rejected.** Encrypting off-circuit and binding a SHA-256 hash of the
ciphertext costs **~42,000 constraints per 64-byte block**, against 240 for a Poseidon hash. It would
have multiplied the spend circuit several times over — making on-device proving, already the #1
product risk, materially worse.

**What was built instead.** Encryption from primitives the circuit already speaks:

```text
epk     = esk·G                        S = esk·encPk = encSk·epk     (Jubjub ECDH)
k       = Poseidon(S.x, S.y, slot)
cAmount = amount + Poseidon(k, 1)      cRho = rho + Poseidon(k, 2)
```

The ECDH reuses the very scalar-multiplication gadget the KYC signature check already needs. The
ciphertext is *computed by the circuit* and published as a public input, so it is part of the proof
rather than an attachment. **Corrupting any element invalidates the proof and the transaction is
rejected** — the failure mode stops existing rather than becoming recoverable.

`slot` (0 or 1) is domain-separated into `k`. Both outputs share one ephemeral key, so without it two
notes sent to the *same* recipient would share a mask, and subtracting the two public ciphertexts
would reveal the difference of their amounts to any observer.

`shield` carries the same construction. A depositor knows their own note, so the immediate need is
weaker — but a wallet restored from seed alone discovers its money by scanning, and leaving shield as
the one unprotected path would mean a corrupted payload silently costs someone their deposit.

**Measured cost.** The estimate going in was ~18,000 constraints; the honest result is higher:

| | Before | After |
|---|---|---|
| Spend circuit | 14,302 | **24,729** (1.73×) |
| Shield circuit | 549 | **6,684** |
| `transact` on-chain | 55.2M | **64.2M** (64% of budget) |
| `shield` on-chain | 46.3M | **52.3M** |

Three Jubjub scalar multiplications dominate (one ephemeral key, one ECDH per recipient). A
fixed-base optimisation for the generator was tried and measured: it saved 252 constraints out of
~24,700 — Edwards addition is unified, so the generic path is already near-optimal — and was reverted
rather than leave a non-obvious optimisation in code that has to be audited.

Everything stays inside the 75M on-chain ceiling. `tampering_with_any_encrypted_field_invalidates_the_proof`
(circuit) and `corrupting_a_recipients_encrypted_note_is_rejected` (contract) assert the property
element by element.

**For the audit:** this is a standard construction, but it is cryptography assembled here rather than
a library call. It belongs in scope.

### 10.6 — Operational controls and the trust model

A deployed Soroban contract is **immutable**. Left as pure code, a bug found after launch would
freeze every custodied token permanently, with no recourse for anyone. A payments product cannot ship
on that basis, so the pool carries one trusted role — stated here plainly rather than buried, because
it is the honest limit on how decentralised this is today.

| Entrypoint | Power | Why it exists |
|---|---|---|
| `upgrade(wasm_hash)` | Replace the contract's code | The only recovery from a post-launch bug. Storage layout is preserved, so the tree, queue and nullifier set survive |
| `set_anchor(x, y)` | Rotate the KYC signing key | If that key leaks, an attacker can mint themselves unlimited "verified" credentials and use the pool with no KYC at all. Without rotation that would be **permanent** |
| `set_paused(bool)` | Halt deposits + private transfers | An upgrade fixes a flaw in hours or days; a pause stops the bleeding in seconds |
| `set_admin(addr)` | Hand over the role | The migration path from a single key to a multisig |

**What the admin cannot do.** It cannot spend a note, forge a proof, mint value, or move a user's
money. Those are enforced by the circuits, not by permissions.

**What it can do, stated honestly.** Whoever holds this key could deploy code that drains the pool.
That is the price of being able to fix a bug at all. Three things bound it:

1. **Withdrawals can never be blocked.** `unshield` and `update_root` are deliberately exempt from
   the pause — folding included, since a note must be in the tree before it can be withdrawn, so
   pausing that would strand exactly the users trying to leave. A pause can halt new business; it can
   never hold anyone's money hostage. Asserted by
   `test::withdrawals_and_folding_still_work_while_paused`.
2. **Every admin action emits an event.** Upgrades, rotations and pauses are publicly visible on
   chain. Not trustless, but never silent.
3. **The role is transferable.** It is a single address today; it should become a **2-of-3 multisig
   before mainnet** via `set_admin`, so no one key is a single point of failure.

**Rotation has a user-visible cost.** `set_anchor` takes effect immediately and invalidates *every*
outstanding credential, honest ones included — which is exactly what you want if the key has leaked.
For a planned rotation, re-issue credentials first so wallets can refresh with minimal disruption.

#### Runbook

These are break-glass operations, driven from a terminal by the key holder. **There is deliberately
no admin dashboard**: an admin panel would put the most destructive capability in the system behind a
password on the internet, turning a cold key into a hot one. The operations tooling that *is* worth
building is a **read-only** monitoring view (queue depth, folder liveness, pool balance, admin
events) — that belongs with the V3 indexer.

```bash
# Halt new deposits and transfers. Withdrawals keep working.
stellar contract invoke --id $POOL --source $ADMIN -- set_paused --paused true

# Rotate the KYC signing key after a compromise (invalidates outstanding credentials).
stellar contract invoke --id $POOL --source $ADMIN -- \
  set_anchor --anchor_pk_x $NEW_X --anchor_pk_y $NEW_Y

# Ship a fix.
stellar contract install --wasm prova_pool.wasm            # prints the hash
stellar contract invoke --id $POOL --source $ADMIN -- upgrade --new_wasm_hash $HASH

# Hand the role to a multisig account before mainnet.
stellar contract invoke --id $POOL --source $ADMIN -- set_admin --new_admin $MULTISIG
```

### 10.7 — V3: the backend (built)

The contract stores only a Merkle root, so the tree lives here. This is not analytics — **a wallet
cannot build a spend proof without a membership path**, so the indexer is on the critical path for
the product working at all.

**The maths stays in Rust.** Everything tree-shaped shells out to `prova-prover`, exactly as
credential issuance already does. A second Poseidon in Go would be a permanent opportunity to drift
from the circuit, and drift does not fail loudly — it silently makes notes unspendable.

| Component | What it does |
|---|---|
| `merkle-path`, `fold-prove` (CLI) | Tree operations, in Rust only |
| `0003_pool.sql` | Notes, roots, nullifiers, scan cursor |
| `store/pool.go` | Append notes, assign leaf indices on fold, serve the tree and feed |
| `chain/pool_events.go` | Decodes `note` / `root` / `spend` from XDR |
| `pool/indexer.go` | Replays events into the mirror; resumes from a saved cursor |
| `pool/folder.go` | Proves folds and submits `update_root` on a timer |
| `pool/relayer.go` | Submits spends so the user's account is never linked to them |

**Endpoints:** `GET /pool/status`, `GET /pool/notes`, `GET /pool/path/{commitment}`,
`POST /pool/spent`, `POST /pool/spend`.

#### Decisions worth keeping

**The note feed is unfiltered.** Wallets download every note and trial-decrypt. Filtering by
recipient server-side would be faster and would tell the backend who is being paid — exactly the
privacy the pool exists to provide. The cost is client CPU, and it is the right trade.

**Notes are applied before roots.** A fold promotes commitments that must already be recorded, so
each page is applied notes-then-roots rather than in raw event order. The other way round leaves leaf
indices unassigned and every path built from them wrong.

**The cursor is saved only after a page fully succeeds.** Re-reading a page is harmless — every write
is idempotent — whereas skipping one loses notes permanently.

**The folder writes nothing locally.** It submits, and the indexer records the result when it reads
the event back. One writer for tree state means the mirror can never disagree with the chain.

**A stale fold is not an error.** Losing a race to another folder is expected under concurrency: the
queue is untouched and the next tick retries. Only real failures (an unreachable RPC, a broken key)
are surfaced.

**`shield` is not relayed.** It needs the user's own authorisation to move their tokens, and it is
public by design — the anchor already knows the deposit — so relaying it would add complexity and buy
no privacy. Only `transact` and `unshield` go through the relayer.

#### Operational notes

- **Run exactly one indexer and one folder.** Leaf indices are assigned in queue order; two writers
  racing on the same range would corrupt it. Two folders merely waste a ~1.5 s proof per round.
- **Alert on `queue_depth`.** A rising queue means the folder has stalled: deposits and transfers
  keep working and no money is at risk, but nothing new becomes spendable.
- **`POOL_FOLD_INTERVAL_SECONDS` is the delay users feel** before money is spendable. The floor is
  proving time (~1.5 s) plus a ledger close (~5 s on testnet).
- **The fold proving key cache** (`POOL_FOLD_KEY_CACHE`) is ~27 MB and stores the key *uncompressed*
  on purpose: the compressed form measured ~11 s to load, because decompressing millions of curve
  points costs a modular square root each — slower than regenerating. Uncompressed loads in ~1.5 s.
  It is a pure cache; deleting it costs time, never correctness.
- **The admin secret never belongs on a server.** The backend needs `POOL_CONTRACT_ID` (public) and
  `RELAYER_KEY` (low-value). Admin operations are run by hand — §10.6.

#### What the relayer is trusted with: nothing

The amount, both output notes, the payout destination and the encrypted payloads are all bound inside
the proof. Change one byte and it fails. The relayer's only powers are to **refuse** (censorship, not
theft — the contract is permissionless, so a user can always submit their own transaction) and to
**observe** that a proof passed through it. It still cannot read the amount or the parties.

### 10.8 — V4: the wallet (built)

The device holds the secrets; the backend only ever sees ciphertext and proofs.

**Everything cryptographic runs natively.** Not for speed alone — a second Poseidon or Jubjub
implementation in TypeScript would be a permanent chance to drift from the circuit, and drift does
not fail loudly. It makes notes unspendable or invisible.

| Piece | What it does |
|---|---|
| `pool/keys.rs` | HKDF from the master seed → spending key + encryption key |
| `pool/ffi.rs` | Key derivation, shield/spend proving, batch trial decryption, warm-up |
| `jni_bridge.rs`, Kotlin module | Async bridge — proving never blocks the UI thread |
| `lib/notes.ts` | AES-256-GCM encrypted note file; spendable vs pending |
| `lib/pool.ts` | Scan, shield, send, cash out |
| `hooks/use-pool.ts` | Balance + scan for screens |
| `app/pool-benchmark.tsx` | On-device proving measurement |

#### Two keys, deliberately separate

`ownerSk` (spend) and `encSk` (find) both derive from the one seed the wallet already backs up, so
**restoring the seed restores everything**. Keeping them apart is what makes a viewing key possible
later: handing someone `encSk` lets them audit incoming notes without any ability to spend.

#### Decisions worth keeping

**The note file is a cache, not the source of truth.** Every note is also published on-chain
encrypted to its owner, so deleting the file costs a rescan, not money. That is exactly what the
in-circuit encryption bought — and it is why the file key is *not* derived from the master seed and
never needs backing up.

**Notes live in a file, not the enclave.** `expo-secure-store` is a keychain entry, historically
rejected above ~2 KB — about eight notes. The file is AES-256-GCM encrypted with a key held in the
enclave: same protection at rest, no ceiling.

**Spendable and pending are never one number.** A note cannot move until its fold lands. Conflating
them would let someone tap Send on money that cannot move, and the failure would come from the
contract rather than the UI.

**Fragmentation is reported specifically.** The spend circuit is 1-in-2-out, so a payment needs a
*single* note that covers it. `InsufficientFunds` carries the largest available note, because "not
enough balance" would be wrong and confusing when the total is sufficient but split.

**Scanning is batched natively.** ~0.4 ms per note; 200 notes in ~82 ms. The feed is unfiltered on
purpose — asking the server for "my notes" would tell it who is being paid.

#### A cutover the KYC flow required

The spend circuit derives `user_id = Poseidon(ownerSk, domain)` from the **pool spending key**, but
the KYC screen was issuing credentials against the older v2 transfer secret. A credential bound to
the wrong identity produces a proof the contract rejects with no explanation.

The screen now derives its id from `poolUserId()`, and `spend()` checks the match before proving so
the failure is diagnosable rather than opaque. **Existing testnet users must verify once more** —
their current credential is bound to the old identity.

#### Measured on desktop

| Operation | Time |
|---|---|
| Warm up (both proving keys) | 1,027 ms — once per launch, in the background |
| Derive wallet keys | 1 ms |
| Shield proof | 226 ms |
| Scan 200 notes | 82 ms (410 µs each) |

`warmUpProver()` exists so the ~1 s key derivation lands at app start rather than inside a user's
first send.

#### Still to measure: the number that decides the send screen

**These are desktop figures.** `app/pool-benchmark.tsx` runs the same measurements on a handset and
turns the result into the design decision it implies:

| Spend proof | What the send screen has to be |
|---|---|
| under ~5 s | a spinner |
| 5–20 s | staged progress with reassurance |
| over ~20 s | a background job that notifies on completion — a different flow |

Run it on the cheapest device in the target market **before** the send screen is designed, because
the third row is far cheaper to build than to retrofit.

## 11. Status

| Stage | State |
|---|---|
| **V0 — design freeze** | ✅ Done, then **amended**: `destination` added as a 9th public input (§2) and the tree strategy replaced (§10.2) |
| **V1.0 — on-chain Poseidon gate** | ✅ **Done — FAILED**, decisively (§10.1). This is what reshaped the design |
| **V1 — circuits v3** | ✅ **Done** — spend / shield / fold, 44 tests incl. every must-fail case; setup + VKs exported |
| **V2 — contract v3** | ✅ **Done** — queue, root history, custody, admin controls, 30 tests; every entrypoint ≤ 64% of the CPU budget |
| **V3 — backend** | ✅ **Done** — indexer, folder, relayer, 5 endpoints; §10.7 |
| **V4 — mobile** | ✅ **Done** — pool FFI, note store, scan/shield/send/cash-out, benchmark screen; §10.8 |
| V5 — integration | ⬜ testnet deploy, then threat-model + audit prep |

**Remaining before testnet:**

- **On-device proving time is still unmeasured on real hardware.** The benchmark screen now exists
  (§10.8) — it needs running on a low-end handset. This remains the #1 product risk, and the result
  decides the shape of the send screen.
- **KYC re-verification is required at cutover.** Credentials are now bound to the pool spending key
  (§10.8); ones issued against the older v2 secret will not satisfy the spend circuit.
- **Testnet deployment and a real trusted setup.** The current setup is seeded and its toxic waste is
  public — testnet only, never mainnet.
