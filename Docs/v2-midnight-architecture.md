# Prova V2 — Midnight privacy + Stellar settlement (proposal review)

> A proposal to split Prova across two networks: **Midnight** for privacy and compliance,
> **Stellar** for settlement. This document records the proposal, checks it against what is
> actually built today, and gives a recommendation.
>
> Companion to [proposal.md](<proposal .md>), [shielded-pool.md](shielded-pool.md) and
> [kyc-verification.md](kyc-verification.md). **Read those first** — the recommendation below
> depends on what the current system already does, and that is easy to underestimate.

---

## 0. The proposal in one paragraph

Move privacy, zero-knowledge proofs, credentials and compliance policy onto Midnight. Keep Stellar
for assets, anchors, liquidity and settlement. Prova becomes the application layer that orchestrates
both, joined by an explicit **settlement intent** — a verified statement from the privacy layer that
authorises a settlement on the value layer.

Tagline: _Private remittances. Verifiable compliance. Global settlement._

---

## 1. What the proposal gets right

These points are correct and worth keeping regardless of which network the privacy layer runs on.

**The settlement-intent boundary.** §16 says Midnight and Stellar must not be treated as if they
share state, and that the boundary has to be explicit. That is the single most important sentence in
the document. Any two-network design that hand-waves this produces a bridge, and bridges are where
this class of system fails.

**Honesty about the trust model.** §17 and §18 separate the MVP trust model (a trusted settlement
service) from the long-term one, and §30 says not to claim trustlessness before earning it. This is
the correct instinct and matches how the existing relayer is already documented — it can refuse and
it can observe, and it cannot steal or redirect.

**Privacy ≠ anonymity.** §35 is right, and it is the thing most privacy projects get wrong in their
marketing. Timing, IP, anchor records and recipient details all leak regardless of the proof system.

**Provider interfaces.** §20 and §21 — `PrivacyProvider` and `SettlementProvider` — are good
engineering. Keeping Stellar-specific code out of the business layer is worth doing on its own
merits, today, with no Midnight involved.

**Positioning.** §31's "privacy-preserving compliance infrastructure" is a stronger frame than
"blockchain remittance app", which is a crowded category.

**Migration discipline.** §46's insistence on a rollback path, and §30's "do not port the Soroban
contract line-by-line", are both correct.

---

## 2. The central factual problem

The proposal is written as though Prova's privacy layer is a gap to be filled. It is not. It is the
part of the system that is finished.

§29 lists what should be reworked:

| Proposal says rework           | What it actually is today                                            |
| ------------------------------ | -------------------------------------------------------------------- |
| "Soroban-specific ZK verifier" | Deployed, verified on testnet, 30 contract tests                     |
| "Custom Groth16 verification"  | BLS12-381 Groth16 via Soroban's native `pairing_check` host function |
| "arkworks proving pipeline"    | Runs on-device in a native Rust module; 45 circuit tests pass        |
| "Stellar-only privacy state"   | A working shielded pool: notes, commitments, nullifiers, Merkle tree |

More specifically, every capability the proposal assigns to Midnight is **already enforced inside
the existing spend circuit**, as constraints — not as backend checks:

```rust
// circuits/prover/src/pool/spend.rs — §9 of the circuit
let user_id = gadgets::hash2(cs.clone(), &self.cfg, &owner_sk, &domain)?;
let m = poseidon_sponge(cs.clone(), &self.cfg, &[&user_id, &kyc_level, &expiry])?;
verify_signature(cs.clone(), &self.cfg, &anchor_pk, &sig_r, &sig_s, &m)?;

// expiry >= current_time
let _ = (&expiry - &current_time).to_bits_le_with_top_bits_zero(TIME_BITS)?;
// kyc_level >= MIN_KYC_LEVEL
let _ = (&kyc_level - &min_level).to_bits_le_with_top_bits_zero(KYC_BITS)?;
```

Mapped against the proposal's own §8 checklist of what should be provable:

| §8 requirement                   | Status today                                                        |
| -------------------------------- | ------------------------------------------------------------------- |
| Credential is authentic          | ✅ EdDSA signature verified **in-circuit**                          |
| Credential belongs to the user   | ✅ `user_id = Poseidon(ownerSk, domain)`, bound to the spending key |
| Credential has not expired       | ✅ `expiry >= current_time` as a constraint                         |
| Required KYC level satisfied     | ✅ `kyc_level >= MIN_KYC_LEVEL` as a constraint                     |
| Transaction within limits        | ✅ range-checked; tier limits enforced                              |
| Transaction not already executed | ✅ nullifier, checked on-chain before the pairing                   |

So §39's "MVP features" list — private transfer, compliance verification, nullifier/replay
protection, settlement, reconciliation — describes a system that exists and has moved real value on
testnet.

**This does not make the proposal wrong.** It changes what the proposal is: not a plan to _build_
privacy, but a plan to _replace_ a working privacy implementation with a different one. That is a
much higher bar, and the document does not argue for it on those terms.

---

## 3. What the proposal does not address

Four questions have to be answered before this becomes a plan rather than a direction.

### 3.1 What does Midnight do that the current circuit cannot?

The document never says. It asserts Midnight is "specifically suited to programmable privacy" (§5),
but every concrete capability it lists is already implemented. Without a specific gap — a policy that
cannot be expressed as a constraint, a proof system property that is genuinely absent — the migration
buys nothing that is currently missing.

There are plausible answers. Compact may be far more maintainable than hand-written arkworks gadgets.
Midnight's private state model may make multi-party or multi-asset policies tractable in a way a
1-in-2-out circuit is not. Its credential tooling may remove work that is currently bespoke. **Any of
those would be a real reason.** None of them is stated.

### 3.2 What happens to custody?

This is the hard one, and the proposal does not mention it.

Today the Soroban pool contract **custodies the tokens**. Value is inside the pool; a spend is a
state transition on custodied value; the proof and the value are enforced by the same contract in the
same transaction. Nothing can move without a valid proof, because the contract that checks the proof
is the contract that holds the money.

Split across two networks, that atomicity is gone. Midnight proves; Stellar settles; something in
between decides. The proposal calls that something a "settlement intent" and, in §17, a trusted
backend. That is a coherent MVP choice — but it converts a property currently enforced by a contract
into a property enforced by an operator. **That is a reduction in the security model**, and the
document presents it as a neutral architectural boundary.

§18's long-term answer is "cryptographically verifiable authorization" validated by a settlement
adapter. Making that real means Stellar verifying a Midnight proof, or a bridge, or a trusted
committee. Each is a substantial project. §30 rightly says not to build a bridge before validating
the product — but §18 needs one.

### 3.3 What does the hackathon submission become?

The README currently claims a deployed shielded pool, two verified testnet contracts, four on-chain
transfers, and ten users with a documented report-to-fix loop. Those claims are backed by artefacts a
reviewer can check.

A partial migration risks a submission that describes an architecture rather than a working product.
The strongest position is a working system; the second strongest is a working system plus a credible
roadmap. A half-migrated system is weaker than either.

### 3.4 Where is the corridor evidence?

§38 is right that one corridor should be proven end-to-end. The gap in the current product is not
privacy — it is the **last mile**: withdrawals to a bank account need a licensed payout partner. That
is a commercial problem, and no amount of proof-system work solves it. The proposal reorganises the
part that works and leaves the part that blocks real users untouched.

---

## 4. Assessment

**As a direction: sound.** The separation of concerns is real, the boundary discipline is right, and
the positioning is stronger than what the product currently claims.

**As a migration plan: not yet justified.** It proposes replacing the most finished, most tested,
most differentiated part of the system without stating what the replacement gains, and it silently
weakens custody atomicity in the process.

**The one-sentence version:** the architecture is a good description of where Prova could go, and not
yet an argument for why it should leave where it is.

---

## 5. Recommended sequence

Ordered so that each step is useful even if the next never happens.

### Step 1 — Take the parts that need no migration

Do these now. They improve the current system regardless of any decision about Midnight.

- Introduce `PrivacyProvider` and `SettlementProvider` (§20, §21). This is refactoring, not
  rewriting, and it is what would make a future swap cheap.
- Implement the transfer state machine (§23). The current flow has real states — proving, relaying,
  folding — that are not modelled explicitly.
- Make policy configuration data rather than constants (§10). `MIN_KYC_LEVEL` is a compile-time
  constant in the circuit today; corridor-specific policy cannot be expressed.
- Adopt the reconciliation and idempotency requirements (§24, §25). Partly present already —
  `/pool/status`, nullifier checks — but not systematic.

### Step 2 — Answer the gap question before writing any Compact

Write one page: _what can Midnight express that the current circuit cannot?_ If there is no concrete
answer, the migration has no engineering case and the discussion should end there. If there is,
that answer is the specification for Step 3.

### Step 3 — Build the smallest honest proof of concept

§40's Phase 1, with one addition the proposal omits: **decide what custodies the value.** Compare
against the current system on constraint count, proving time on a mid-range Android phone, and
verification cost. Those are the numbers that decide this, and none of them are in the document.

### Step 4 — Only then decide

With a working PoC and measured numbers, the decision is evidence-based. Without them it is a
preference.

---

## 6. What not to do

Restating §30, plus what this review adds:

- **Do not remove the Soroban implementation.** It is the working product and the submission evidence.
- **Do not migrate before the last mile.** A licensed payout partner unblocks real users; a new proof
  system does not.
- **Do not describe the current architecture as a prototype.** It is deployed, tested and has moved
  real value on testnet.
- **Do not present the settlement intent as security-neutral.** It replaces contract-enforced
  atomicity with an operator, and that trade must be stated wherever it appears.

---

## 7. Verdict

**Adopt the principles now. Defer the migration until the gap is named and measured.**

The proposal's engineering discipline — explicit boundaries, honest trust models, provider
interfaces, minimum disclosure, "build the smallest complete system" — is worth adopting immediately,
and most of it costs nothing but refactoring.

The network change is a different decision, and it should be made on evidence the document does not
yet contain: what Midnight expresses that the current circuit cannot, what happens to custody, and
what it costs on a real phone. Those three answers turn a good direction into a good plan.
