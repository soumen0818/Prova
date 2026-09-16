# Prova V2 — phased delivery plan

> The route from what is deployed today to the production V2 architecture in
> [v2-midnight-architecture.md](v2-midnight-architecture.md): **Midnight** for privacy and
> compliance, **Stellar** for settlement, **Prova** as the application layer joining them.
>
> This is the working tracker. Update the status boxes as work lands; do not let it drift from
> reality, because the whole point of it is to be the honest answer to "where are we?".

---

## How to read this

Phases are ordered so that **every phase ships something useful even if the next one never
happens.** That is deliberate. A migration that only pays off at the end is a migration that gets
abandoned halfway with nothing to show.

Each phase has an **exit test** — a single question with a yes/no answer. If it cannot be answered
yes, the phase is not done, regardless of how much code exists.

| Marker | Meaning            |
| ------ | ------------------ |
| ☐      | Not started        |
| ◐      | In progress        |
| ☑      | Done and verified  |
| ⚠      | Blocked or at risk |

**Gate 0 → 1 is a real decision point, not a formality.** Phase 0 costs little and is worth doing
regardless. Phase 1 answers whether the rest of this document should exist at all.

---

## Phase 0 — Foundations (no Midnight, all value today)

**Goal:** make the current system swap-ready and better, whatever is decided about Midnight.
**Risk:** low — refactoring and additive work only.
**Why first:** every item pays for itself immediately. Nothing here is wasted if Phase 1 says no.

### 0.1 Provider interfaces ☑

Introduce `PrivacyProvider` and `SettlementProvider` in `backend/internal/`, with the current
implementations behind them:

- `StellarSettlementProvider` — wraps the existing `chain/` and `pool/relayer.go`
- `SorobanPrivacyProvider` — wraps the existing pool contract + prover CLI calls

Stellar is already well contained (`internal/chain/`, `internal/pool/`), so this is a boundary, not
a rewrite.

**Exit test:** can the settlement backend be swapped for a stub in a test, without touching
remittance business logic? — **yes**, `TestSettlementProviderIsSubstitutable` ([`ff55014`](https://github.com/soumen0818/Prova/commit/ff55014)).

### 0.2 Explicit transfer state machine ☑

The states already exist implicitly — proving, relaying, folding, settled, failed — but nothing
models them. Add the machine from the V2 doc §23, with the failure states, and persist transitions.

**Exit test:** for any transfer id, can the system answer "where is this, and what happened to it?"
from stored state alone, with no log grepping? — **yes**, and illegal transitions are now refused in
`Store.SetStatus` ([`33dc593`](https://github.com/soumen0818/Prova/commit/33dc593)).

### 0.3 Compliance policy as data ☑

`MIN_KYC_LEVEL` is a compile-time constant in the circuit today, and tier limits live in code. Move
corridor policy into configuration: minimum KYC level, per-tier limits, allowed destinations,
credential validity window.

> **Note the constraint.** Anything the _circuit_ enforces cannot become runtime data without a new
> circuit — a constant in a constraint system is baked into the verifying key. So this phase splits
> policy into two tiers: **circuit-enforced invariants** (fixed per circuit version) and
> **application policy** (configurable). Write down which is which. That distinction is also exactly
> what Phase 1 has to evaluate.

**Exit test:** can a second corridor with different limits be configured without recompiling the
circuit or redeploying the contract?

### 0.4 Reconciliation and idempotency ☑

Partly present (`/pool/status`, nullifier checks, the relay failure record) but not systematic.
Make settlement idempotent on an explicit key, and reconcile every transfer across its full
lifecycle.

**Exit test:** does replaying the same settlement request twice produce exactly one payment, proven
by a test?

### 0.5 Close the honesty gaps in the current build ◐

Carried over, and worth clearing before any migration noise:

- ☑ Clear the stale `relayError` on `/pool/status` — a success now clears it
  ([`ClearRelayFailure`](../backend/internal/store/pool.go)). The field was write-only, so one
  bad relay left an error there permanently; a status field that only goes one way is not a
  status field.
- ☐ Recapture `payment_failed.png` — **MANUAL: needs a device.** It shows the pre-fix copy ("the
  proof was rejected") and the pre-fix balance behaviour. Install 1.3.0, force a failure, screenshot,
  replace `public/payment_failed.png`.
- ☐ Mobile-width website screenshot — **MANUAL: needs a browser.** Open
  [provapay.duckdns.org](https://provapay.duckdns.org) at ~390px wide, screenshot, save as
  `public/website_mobile.png`. Covers the "mobile responsive" submission requirement, which both
  current site shots miss because they are desktop.

**Phase 0 exit test:** _Is the current product measurably better, and could a different privacy
backend be dropped in without touching business logic?_

---

## Phase 1 — The Midnight decision (spike, not a build)

**Goal:** answer whether the migration should happen at all.
**Risk:** low cost, high leverage. This is the cheapest phase and the most important.

Everything downstream assumes the answer is yes. Do not skip it because the answer feels obvious.

### 1.1 Name the gap ☑

Write one page: **what can Midnight express that the current circuit cannot?**

Candidate answers worth testing — none of these is yet established:

- Compact is materially more maintainable than hand-written arkworks gadgets
- Midnight's private state model supports policies a 1-in-2-out circuit cannot (multi-input,
  multi-asset, multi-party)
- Its credential tooling replaces bespoke work in `circuits/prover/src/credential.rs`
- Policy can change without a trusted setup ceremony per change

**Exit test:** is there at least one capability, written down concretely, that the current system
cannot do and a real user need requires?

### 1.2 Measure, do not assume ◐

Build the smallest possible Midnight circuit — credential + one compliance rule — and record:

| Metric                             | Current (arkworks/BLS12-381) | Midnight  | Verdict |
| ---------------------------------- | ---------------------------- | --------- | ------- |
| Constraint count                   | _measure_                    | _measure_ |         |
| Proving time, mid-range Android    | _measure_                    | _measure_ |         |
| Verification cost on-chain         | ~49.0M CPU (measured)        | _measure_ |         |
| Proving key size / app size impact | 86 MB APK today              | _measure_ |         |
| Trusted setup required?            | Yes (seed 42, testnet-grade) | _measure_ |         |

Proving time on a real phone is the number that decides this. The current prover already runs
on-device; a design that cannot is a product regression regardless of its other merits.

### 1.3 Decide custody ☑ — **Option C**

**The question the V2 proposal does not ask.** Today the Soroban pool contract holds the tokens, so
the contract that verifies the proof is the contract that holds the money — atomic, in one
transaction. Splitting across two networks breaks that.

**Chosen: C.** Soroban keeps custody and keeps enforcing; Midnight proves compliance alongside it.
No new trusted component, and both proofs can run side by side before anything is cut over. Full
reasoning, including the honest cost, in
[v2-phase1-midnight-evaluation.md](v2-phase1-midnight-evaluation.md) §1.3.

The options as they were weighed:

| Option                                                                  | Custody                  | Trust assumption                                                 |
| ----------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| **A** — Stellar keeps custody, Midnight proves                          | Soroban pool (unchanged) | Settlement service is trusted to relay authorisations faithfully |
| **B** — Midnight custodies, Stellar settles out                         | Midnight                 | Bridge or committee between the two                              |
| **C** — Hybrid: Midnight for compliance proof only, Soroban keeps value | Soroban pool             | Compliance proof is advisory to the value layer                  |

**Why C won.** A and B both convert a contract-enforced guarantee into an operator-enforced one — A
through a trusted relay, B through a bridge. C changes neither what holds the money nor what decides
whether it may move, so it adds no trust at all.

**The cost, stated plainly:** a compliance proof the value layer does not verify is _advisory_. That
gap closes at the end of Phase 2, when the Midnight proof reference becomes a public input the pool
contract checks and the KYC constraints leave the Soroban circuit. Until then compliance is enforced
where it already is — in-circuit on Soroban — and no claim is made that Midnight enforces anything
on-chain.

**Phase 1 exit test:** _Is there a written, measured case that Midnight does something the current
system cannot, and is the custody model decided?_ — **custody: yes** (Option C — Soroban keeps value
and enforcement, Midnight proves compliance, no new trusted component). **Measured case: still
open**, and Phase 2.1 produces it as a by-product. See
[v2-phase1-midnight-evaluation.md](v2-phase1-midnight-evaluation.md).

> **Gate: passed on custody, open on measurement.** Phase 2 proceeds, but 2.1 must produce the
> on-device proving number before anything downstream depends on Midnight. If a phone cannot build
> the proof, the answer is still "it did not earn the migration" — and Option C means finding that
> out costs a circuit, not the product.

---

## Phase 2 — Midnight privacy core

**Goal:** a private transfer, provable and non-replayable, on Midnight.
**Depends on:** Phase 1 passing its gate.

### 2.0 Toolchain and the on-device question ◐

Installed 14 Sep: `compact` CLI 0.5.2, compiler 0.34.0, to `~/.local/bin`. Docker and Node were
already present. Nothing else needed — no SDK download, no ceremony artifacts.

**Answered by research, not memory** (see
[v2-phase1-midnight-evaluation.md](v2-phase1-midnight-evaluation.md)):

- ✅ **No trusted setup.** Halo2 with an Inner Product Argument removes the ceremony entirely. This
  is the one candidate gap from 1.1 that survived, and it is now confirmed — a real advantage the
  current stack cannot match without a multi-party ceremony before mainnet.
- ⚠️ **Proving happens in a Docker proof server on port 6300.** The documented paths are browser and
  Node.js; the SDK's `proofProvider` is described as letting a _backend_ do the ZK work. No mobile
  path is documented.

**The second point is the real risk of this migration**, and 2.1 must settle it before anything
downstream is built. Prova's claim is that the amount never leaves the phone, and today an on-device
Rust prover makes that literally true. A remote proof server would receive the witness — which means
it would know the amount, and the claim would be gone.

Acceptable outcomes: the prover compiled natively for arm64 (mirroring `modules/prova-prover`), or a
proof server running on the device itself. Unacceptable: sending witnesses to a server.

### 2.1 Credential circuit ☑ — compiles, measured

`privacy/midnight/contracts/compliance.compact` — the same eligibility statement the Soroban spend
circuit already enforces: credential not expired, KYC level at or above the corridor's minimum, and
a commitment binding the proof to the credential used.

Proving the _same_ statement twice is the point of Option C: both run side by side and their answers
are compared before anything is cut over. A circuit that proved something different would make the
comparison meaningless.

**Measured** (`compact` 0.5.2, compiler 0.34.0, language 0.26):

|                     | Midnight               | Current stack                                |
| ------------------- | ---------------------- | -------------------------------------------- |
| Compliance circuit  | 38 IR instructions     | part of the 24,729-constraint spend circuit  |
| Proving key shipped | **2.7 MB per circuit** | **0 bytes** — derived at runtime from a seed |
| Verifier key        | 2 KB                   | 2.2 KB embedded in the contract              |
| Trusted setup       | none                   | required                                     |

**What the compiler taught us.** Compact refused to compile until every witness-derived return value
was wrapped in `disclose()` — it treats a _hash_ of a secret as a disclosure, because an attacker
holding a candidate value can hash it and compare. That is a genuine protection the arkworks
pipeline does not offer: there, `user_id` is simply a public input with nothing forcing anyone to
notice. Both leak the same thing; only one makes you say so out loud.

**The 2.7 MB proving key is the finding to carry forward.** The current app ships no key at all — it
derives one from `SETUP_SEED` on first use. Midnight ships a file per circuit, so every circuit adds
~2.7 MB to an APK that is already 86 MB. Not disqualifying, but it is a real cost and it scales with
the number of circuits.

### 2.1b On-device proving ◐ — **likely viable, needs the NDK to confirm**

**Settle this before building anything else on Midnight.** It is a bigger risk than proving time:
time is a number to optimise, this is a property to keep or lose.

Midnight proves in a Docker service on port 6300, and the documented integrations are browser and
Node.js. Prova's claim is that the amount never leaves the phone, and an on-device Rust prover makes
that literally true today.

| Outcome                                                                        | On-device? | Verdict                                |
| ------------------------------------------------------------------------------ | ---------- | -------------------------------------- |
| Midnight's prover compiled for arm64 and bridged, as `modules/prova-prover` is | Yes        | Preserves the claim                    |
| Proof server running inside the app on the handset                             | Yes        | Heavy, acceptable                      |
| Remote proof server the app calls                                              | **No**     | **Breaks the product's central claim** |

The third is not a trade to weigh — a server that receives the witness knows the amount, and the
whole argument for this product is that nobody does.

**Tested 16 Sep — the answer is encouraging.** `cargo add midnight-proofs` resolves (102 packages,
Rust 1.96 compatible) and `cargo build --target aarch64-linux-android` gets all the way through
dependency compilation before stopping at exactly one thing:

```
error: failed to run custom build command for `blst v0.3.17`
  error occurred in cc-rs: failed to find tool "aarch64-linux-android-clang"
```

`blst` is the C implementation of BLS12-381. It needs the NDK's clang, which is missing only because
the Android SDK was removed from this machine. **Nothing in the Rust code is Android-incompatible** —
no `std`-only guard, no unsupported intrinsic, no platform gate. It is a toolchain gap.

And it is a gap this repo has already closed: `circuits/prover/build-android.sh` cross-compiles the
existing arkworks prover with `cargo-ndk` and `ANDROID_NDK_HOME`, for the same target, against the
same curve. The same recipe applies.

**Status: the native path looks viable, unproven.** To finish it: reinstall the NDK, run the build
with `cargo-ndk`, and measure proving time on the handset. That turns "looks viable" into the number
1.2 is still missing.

**What this means for the risk.** The outcome that would break the product — witnesses leaving the
device for a remote proof server — is no longer the likely one. Midnight's _documented_ path is a
Docker proof server, but its prover is a Rust crate that appears to cross-compile like any other, and
this codebase already ships a Rust prover on Android.

### 2.2 Private value: commitments and nullifiers ☐

Notes, commitments, nullifier derivation, replay rejection. The **semantics** carry over from
`Docs/shielded-pool.md`; the **primitives** must be whatever Midnight supports natively. Do not port
Poseidon-over-BLS12-381 if Midnight has a native equivalent.

### 2.3 Compliance policy in-circuit ☐

The policy set from Phase 0.3, expressed as Midnight constraints.

**Exit test:** _Can a spend be proved valid, verified, and provably not replayed — with the amount,
identity and credential details never disclosed?_

---

## Phase 3 — The settlement boundary

**Goal:** the explicit, auditable join between privacy and value. This is the highest-risk phase.

### 3.1 Settlement intent ☐

Define and version the structure (V2 doc §15). It must carry enough for settlement and nothing
more — that is the selective-disclosure principle applied at the most tempting place to violate it.

### 3.2 Authorisation ☐ ⚠

How does the settlement service know an intent is genuine and unspent? Under Phase 1.3's chosen
custody model, write down what is cryptographically enforced and what is trusted. **Do not describe
this as trustless unless a proof, not an operator, enforces it.**

### 3.3 Exactly-once settlement ☐

One verified private transfer must produce exactly one settlement — under retries, timeouts,
crashes and duplicate intents. Test the failure modes deliberately, not just the happy path.

**Exit test:** _Does one verified transfer produce exactly one Stellar settlement, and can a
deliberately duplicated or replayed intent never produce a second payment?_

---

## Phase 4 — Stellar settlement adapter

**Goal:** intents become real value movement, reusing what already works.

### 4.1 Adapter behind `SettlementProvider` ☐

Most of this exists — `chain/submitter.go`, the relayer, anchor integration. Phase 0.1 already put
it behind the right interface.

### 4.2 Anchor and payout ☐ ⚠

**The real blocker, and it is commercial, not technical.** Withdrawals to a bank account need a
licensed payout partner. No proof system solves this, and it is what stands between the product and
real users.

**Exit test:** _Does a verified private transfer move real value to a recipient on testnet, end to
end?_

---

## Phase 5 — Application integration

**Goal:** the whole flow, from the phone.

### 5.1 Mobile proof generation ☐

Whatever replaces `modules/prova-prover`. Constraint: it must still prove **on-device**, or the
privacy claim weakens — a server that builds your proof knows your amount.

### 5.2 Transfer lifecycle UX ☐

The Phase 0.2 state machine, surfaced. The activity lifecycle work already shipped (pending →
complete/failed with auto-settlement) is the pattern to extend.

### 5.3 Selective disclosure UX ☐

Show what was proved without showing what was hidden — the V2 doc §42 demo moment.

**Exit test:** _Can a user complete and track a private, compliant transfer from the app without
knowing any of this exists?_

---

## Phase 6 — Production hardening

**Goal:** the difference between a demo and a payments product.

- ☐ Key management and rotation (both networks)
- ☐ Threat model written and reviewed (V2 doc §36)
- ☐ Trust assumptions documented per component — no trustlessness claims that are not enforced
- ☐ Monitoring, alerting, audit logs
- ☐ Rate limiting and abuse controls
- ☐ Failure recovery and runbooks
- ☐ Load testing at realistic volume
- ☐ Regulatory review for the actual corridor (V2 doc §37)

**Exit test:** _If this handled real money tomorrow, what would keep you up at night — and is it
written down and mitigated?_

---

## Phase 7 — Migration and cutover

**Goal:** move users across without breaking anyone.

- ☐ Both privacy backends run in parallel behind `PrivacyProvider`
- ☐ Shadow mode: new path proves, old path settles, outputs compared
- ☐ Staged rollout with a documented rollback trigger
- ☐ Migrate existing users' notes and credentials
- ☐ Retire the old path **only after** the new one has settled real value

Per V2 doc §46: keep the rollback path until the new system has earned its retirement.

**Exit test:** _Can the migration be reversed after go-live, without user-visible loss?_

---

## What stays true throughout

Carried from the V2 doc §47, and not negotiable:

1. Sensitive data stays client-side wherever practical
2. Store the minimum; expose the minimum
3. Never expose user secrets
4. Prevent replay and double settlement
5. Settlement is idempotent
6. Every transaction reconciles
7. Separate privacy logic from settlement logic
8. **Do not claim trustlessness where trusted components remain**
9. Build the smallest complete system before expanding

---

## Work log

Every change, newest first, with the commit that carries it. This is the audit trail: a status box
says _what_ is done, this says _what was actually built and when_, so nothing is claimed that cannot
be checked against a diff.

| Date   | Commit    | Phase   | What changed                                                                                                |
| ------ | --------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| 14 Sep | `8af9f72` | —       | README: 1.3.0 APK everywhere, Midnight-first architecture section, feedback table replaced with a form link |
| 14 Sep | `6c81083` | —       | Version 1.3.0 — a minor, not a patch: the 16-input circuit cannot talk to the old pool                      |
| 8 Sep  | `4ed97c5` | 0.3     | Contract test rewritten to a satisfiable statement (see below)                                              |
| 8 Sep  | `a8c78c6` | —       | `cargo fmt` + `clippy -D warnings` across both Rust crates; fixed a call site only `--all-targets` compiles |
| 8 Sep  | `9ea21eb` | 1.1–1.2 | Phase 1 evaluation: baseline measured, Midnight case not yet made                                           |
| 8 Sep  | `6bb6862` | —       | Config plugin: arm64-only native builds, version read from `app.json`                                       |
| 8 Sep  | `745a4ca` | 0.5     | A successful relay clears the stale failure record                                                          |
| 8 Sep  | `6ae0591` | 0.4     | Reconciliation: `StuckTransfers` + `GET /ops/reconcile`                                                     |
| 8 Sep  | `a24e487` | 0.3     | KYC minimum becomes a public input; pool redeployed as `CD645P…`                                            |
| 7 Sep  | `33dc593` | 0.2     | Transfer state machine, enforced in `Store.SetStatus`                                                       |
| 7 Sep  | `ff55014` | 0.1     | `SettlementProvider` / `PrivacyProvider` interfaces                                                         |

### Mistakes worth not repeating

Recorded because each cost real time and each has a cheap rule that prevents it.

| What happened                                                                                                                                           | The rule it taught                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A contract test proved an **unsatisfiable** circuit. Passed in `--release` (arkworks skips its check), panicked in debug. CI runs debug.                | **Verify in the profile CI uses.** "Cannot prove X" is a constraint-satisfaction assertion, never a `prove()` call. |
| `SpendCircuit::new` call site inside `ffi.rs` compiled only under `clippy --all-targets`. `cargo test` never saw it.                                    | **Run every gate the workflow runs**, not the subset you touched.                                                   |
| The deploy script warned when `ANCHOR_SEED` was unset, then called `anchor-pubkey` **without passing it** — so the pool initialised with the dev key.   | **Read the result off-chain after deploying.** Never trust a script's own output.                                   |
| `current_time` was sampled twice — once for the proof, once for submission — with proving in between. Every transfer failed with `Error(Contract, #4)`. | A **public input** must be captured once and reused.                                                                |
| `android/` is gitignored, so fixes made there vanish on the next prebuild.                                                                              | Native build fixes belong in the **config plugin**.                                                                 |

---

## Current status

| Phase                   | Status | Blocking question                                       |
| ----------------------- | ------ | ------------------------------------------------------- |
| 0 — Foundations         | ◐      | 0.1–0.4 ☑ · 0.5 needs a device and a browser            |
| 1 — Midnight decision   | ◐      | 1.1 ☑ · 1.3 ☑ Option C · 1.2 measurement comes from 2.1 |
| 2 — Privacy core        | ☐      | Unblocked — start with 2.1                              |
| 3 — Settlement boundary | ☐      | What enforces intent authenticity?                      |
| 4 — Stellar adapter     | ☐      | Licensed payout partner (commercial)                    |
| 5 — App integration     | ☐      | On-device proving must survive                          |
| 6 — Hardening           | ☐      | —                                                       |
| 7 — Cutover             | ☐      | —                                                       |

### Verified in production — 14 Sep

The Phase 0.3 chain works end to end on the live backend, checked rather than assumed:

| Check                                | Result                            |
| ------------------------------------ | --------------------------------- |
| `min_kyc_level` on-chain (`CD645P…`) | `1`                               |
| `/pool/status` → `minKycLevel`       | `1` — contract read → cache → API |
| Pool reset after the redeploy        | `treeSize: 0`, `queueDepth: 0`    |
| Backend anchor vs contract anchor    | match (`27262bd2…`)               |

Two things to know about the live endpoint:

- **`/pool/status` takes ~25s on a cold call.** That is the uncached contract read; it is cached for
  60s afterwards. A background refresh would remove it if a caller ever cares.
- **`relayError` still shows a `#4` from 24 August.** Stale, from the old pool, before that bug was
  fixed. The self-clearing code only fires on a successful spend and there has not been one on the
  new pool yet, so it clears on the first send.

**What is deployed today** (the baseline this plan starts from, not a prototype): two verified
Soroban contracts on Stellar testnet, an on-device ZK prover, a working shielded pool with
in-circuit KYC, 45 circuit tests, 30 contract tests, 10 onboarded testers and four verified on-chain
private transfers.

**Recommended next action:** Phase 0.1 and 0.2 in parallel — both are pure refactoring with
immediate value — while Phase 1.1 (name the gap) is answered on paper. Phase 1 is cheap and decides
everything after it.
