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
- ☐ Recapture `payment_failed.png` — **needs a device.** It shows the pre-fix copy ("the proof was
  rejected") and the pre-fix balance behaviour. Requires installing the next build and forcing a
  failure.
- ☐ Mobile-width website screenshot — **needs a browser.** For the submission's "mobile responsive"
  requirement; both current site shots are desktop.

**Phase 0 exit test:** _Is the current product measurably better, and could a different privacy
backend be dropped in without touching business logic?_

---

## Phase 1 — The Midnight decision (spike, not a build)

**Goal:** answer whether the migration should happen at all.
**Risk:** low cost, high leverage. This is the cheapest phase and the most important.

Everything downstream assumes the answer is yes. Do not skip it because the answer feels obvious.

### 1.1 Name the gap ☐

Write one page: **what can Midnight express that the current circuit cannot?**

Candidate answers worth testing — none of these is yet established:

- Compact is materially more maintainable than hand-written arkworks gadgets
- Midnight's private state model supports policies a 1-in-2-out circuit cannot (multi-input,
  multi-asset, multi-party)
- Its credential tooling replaces bespoke work in `circuits/prover/src/credential.rs`
- Policy can change without a trusted setup ceremony per change

**Exit test:** is there at least one capability, written down concretely, that the current system
cannot do and a real user need requires?

### 1.2 Measure, do not assume ☐

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

### 1.3 Decide custody ☐ ⚠

**The question the V2 proposal does not ask.** Today the Soroban pool contract holds the tokens, so
the contract that verifies the proof is the contract that holds the money — atomic, in one
transaction. Splitting across two networks breaks that.

Pick one, explicitly, and write down its trust assumption:

| Option                                                                  | Custody                  | Trust assumption                                                 |
| ----------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| **A** — Stellar keeps custody, Midnight proves                          | Soroban pool (unchanged) | Settlement service is trusted to relay authorisations faithfully |
| **B** — Midnight custodies, Stellar settles out                         | Midnight                 | Bridge or committee between the two                              |
| **C** — Hybrid: Midnight for compliance proof only, Soroban keeps value | Soroban pool             | Compliance proof is advisory to the value layer                  |

Option **C** is the least disruptive and preserves the current security model; option **B** is the
most architecturally pure and the most work. There is no neutral choice — each trades something.

**Phase 1 exit test:** _Is there a written, measured case that Midnight does something the current
system cannot, and is the custody model decided?_

> **Gate.** If this test fails, stop here. Phase 0 has already improved the product, the V2
> principles are adopted, and the honest outcome is "we evaluated it and it did not earn the
> migration". That is a legitimate result, not a failure.

---

## Phase 2 — Midnight privacy core

**Goal:** a private transfer, provable and non-replayable, on Midnight.
**Depends on:** Phase 1 passing its gate.

### 2.1 Credential circuit ☐

Port the credential model — issuer signature, `user_id` binding, expiry, KYC level — to Compact.
Match the existing semantics exactly; the current model is tested and works.

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

## Current status

| Phase                   | Status | Blocking question                                     |
| ----------------------- | ------ | ----------------------------------------------------- |
| 0 — Foundations         | ◐      | 0.1–0.4 ☑ · 0.5 needs a device and a browser          |
| 1 — Midnight decision   | ☐      | What can Midnight do that the current circuit cannot? |
| 2 — Privacy core        | ☐      | Gated on Phase 1                                      |
| 3 — Settlement boundary | ☐      | What enforces intent authenticity?                    |
| 4 — Stellar adapter     | ☐      | Licensed payout partner (commercial)                  |
| 5 — App integration     | ☐      | On-device proving must survive                        |
| 6 — Hardening           | ☐      | —                                                     |
| 7 — Cutover             | ☐      | —                                                     |

**What is deployed today** (the baseline this plan starts from, not a prototype): two verified
Soroban contracts on Stellar testnet, an on-device ZK prover, a working shielded pool with
in-circuit KYC, 45 circuit tests, 30 contract tests, 10 onboarded testers and four verified on-chain
private transfers.

**Recommended next action:** Phase 0.1 and 0.2 in parallel — both are pure refactoring with
immediate value — while Phase 1.1 (name the gap) is answered on paper. Phase 1 is cheap and decides
everything after it.
