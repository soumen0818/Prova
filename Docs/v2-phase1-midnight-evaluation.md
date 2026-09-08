# Phase 1 — the Midnight decision

> Phase 1 of [progress.md](progress.md). Answers whether the V2 migration in
> [v2-midnight-architecture.md](v2-midnight-architecture.md) should happen at all, before any Compact
> is written.
>
> **Status: 1.1 and the baseline half of 1.2 are done. The decision is blocked on one thing only —
> measurements from a real Midnight circuit, which cannot be faked or estimated.**

---

## 1.1 — Name the gap

The question: **what can Midnight express that the current circuit cannot?**

### What the current circuit already does

Measured, not asserted (`cargo test --release --test pool_circuits report_circuit_sizes`):

| Circuit    | Constraints | Public inputs | Witnesses |
| ---------- | ----------- | ------------- | --------- |
| **spend**  | 24,729      | 16            | 24,374    |
| **shield** | 6,684       | 7             | 6,557     |

Every capability §8 of the V2 proposal lists as something to build is already enforced **in-circuit**:

| §8 requirement                 | Where it lives today                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| Credential is authentic        | EdDSA-over-Jubjub verified inside the circuit                       |
| Credential belongs to the user | `user_id = Poseidon(ownerSk, domain)`, bound to the spending key    |
| Credential not expired         | `expiry >= current_time`                                            |
| KYC level satisfied            | `kyc_level >= min_kyc_level` — **now a public input** (Phase 0.3)   |
| Amount within limits           | Range-checked to `AMOUNT_BITS`                                      |
| Not already executed           | Nullifier, rejected on-chain before the pairing                     |
| Recipient can find the money   | Encrypted notes are public inputs, so a relayer cannot corrupt them |

### The candidate gaps, and what Phase 0.3 did to one of them

The strongest argument in the original proposal was **policy flexibility**: a compiled-in constant
meant a corridor could not change its rules without a new circuit, a new trusted setup and a forced
app update.

**That argument is now spent.** Phase 0.3 moved the KYC minimum to a public input supplied by the
contract, so policy changes are one admin call. It cost a redeploy once and never again. The same
technique extends to any other scalar policy — tier limits, jurisdiction codes, validity windows —
without leaving Groth16.

What remains genuinely unanswered:

| Candidate gap                                          | Status                       | How to settle it                                                                                                                                                                                         |
| ------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Compact is more maintainable than arkworks gadgets** | Plausible, unmeasured        | Write the credential circuit in both; compare lines, and how long a policy change takes                                                                                                                  |
| **Multi-input / multi-asset spends**                   | Real limitation today        | The circuit is 1-in-2-out. A 2-in-2-out would end the "balance split across notes" problem users already hit. **But this is achievable in arkworks too** — it is a circuit change, not a platform change |
| **No trusted setup**                                   | Would be a genuine advantage | Today's setup is `SETUP_SEED = 42`, testnet-grade. Mainnet needs a real ceremony _or_ a system without one. Does Midnight remove it?                                                                     |
| **Credential tooling**                                 | Unknown                      | Would it replace `circuits/prover/src/credential.rs`?                                                                                                                                                    |

**Conclusion for 1.1.** One capability is named and real — **multi-input spends** — and it does not
require Midnight. The one property that would justify a platform change is **eliminating the trusted
setup**, and nobody has confirmed Midnight does that.

> **Exit test — "is there at least one capability the current system cannot do that a real user need
> requires?"** Not yet met. The nearest candidate (2-in-2-out) is a circuit change on the existing
> stack.

---

## 1.2 — Measure, do not assume

### Baseline, measured

Hardware: AMD Ryzen 5 7235HS, 8 threads. `cargo test --release`.

Timings are ranges across two runs, not single measurements: the spread on this machine was ~15%
(spend proved in 702 ms and 799 ms on consecutive runs). Quoting one run to the millisecond would
imply a precision that is not there, and any Midnight comparison has to clear that noise floor to
mean anything.

| Metric                          | Current (arkworks / BLS12-381 Groth16)      | Midnight       |
| ------------------------------- | ------------------------------------------- | -------------- |
| Spend constraints               | **24,729**                                  | _not measured_ |
| Spend public inputs             | **16**                                      | _not measured_ |
| Setup time (spend)              | **~800 ms**                                 | _not measured_ |
| **Prove time (spend), desktop** | **~700–800 ms**                             | _not measured_ |
| Prove time (shield)             | ~215–240 ms                                 | _not measured_ |
| Prove time (fold)               | ~1,360–1,580 ms                             | _not measured_ |
| On-chain verification           | ~49.0M CPU (measured on Soroban)            | _not measured_ |
| Trusted setup                   | Required (`SETUP_SEED = 42`, testnet-grade) | _unknown_      |
| Proves on-device                | **Yes** — native Rust module, in production | _not measured_ |

### The number that decides it

**Proving time on a mid-range Android phone.** Under a second on a desktop is comfortable; phones are
roughly 5–15× slower on this workload, which puts the current spend proof in the seconds range —
consistent with what testers experience.

The constraint is not "fast enough to be pleasant". It is: **the proof must be built on the device.**
A design that needs a server to prove has a server that knows the amount, and the product's central
claim is gone. Any alternative that cannot prove on-device is a regression regardless of every other
merit.

### Why the Midnight column is empty

It cannot be filled by reading documentation. These numbers come from building the smallest real
circuit — credential + one compliance rule — and measuring it. **Estimating them would be the exact
failure this phase exists to prevent:** the V2 proposal asserted Midnight was "specifically suited to
programmable privacy" without a single measurement, and that assertion is what put this evaluation
here.

---

## 1.3 — Decide custody

**Not started, and it is the question the V2 proposal never asks.**

Today the pool contract holds the tokens _and_ verifies the proof, in one transaction. The contract
that checks the proof is the contract that holds the money — nothing moves without a valid proof,
atomically. Split across two networks and that property is gone.

| Option                                                       | Custody                  | Trust assumption                                    |
| ------------------------------------------------------------ | ------------------------ | --------------------------------------------------- |
| **A** — Stellar custodies, Midnight proves                   | Soroban pool (unchanged) | Settlement service relays authorisations faithfully |
| **B** — Midnight custodies, Stellar settles out              | Midnight                 | A bridge or committee between the two               |
| **C** — Midnight proves compliance only, Soroban keeps value | Soroban pool             | Compliance proof is advisory to the value layer     |

There is no neutral choice. **A** and **C** convert a contract-enforced property into an
operator-enforced one; **B** needs a bridge, which §30 of the proposal itself says not to build
before validating the product.

---

## Recommendation

**Do not start Phase 2.** Not because Midnight is wrong, but because the case for it is not yet made
and Phase 0 has already delivered what the migration was going to be justified by.

Three things would change this, in order of cost:

1. **Confirm whether Midnight eliminates the trusted setup.** Documentation answers this. If yes, it
   is a real advantage the current stack cannot match without a ceremony, and the strongest argument
   available.
2. **Build the smallest Midnight circuit and fill the empty column.** Especially on-device proving
   time. Half a day, and it converts a preference into a decision.
3. **Decide custody (1.3) before writing any Compact.** A design that discovers its trust model
   afterwards has already chosen one by accident.

### What to build instead, right now

**2-in-2-out spends.** It is the one named, real limitation, users already hit it — "your balance is
split across notes, the most you can send in one transfer is X" — and it needs no platform change.
It would also make the Phase 1.2 comparison sharper, because a more complex circuit is where a
different proof system's advantages would actually show.
