# Phase 1 — the Midnight decision

> Phase 1 of [progress.md](progress.md). Answers whether the V2 migration in
> [v2-midnight-architecture.md](v2-midnight-architecture.md) should happen at all, before any Compact
> is written.
>
> **Status: 1.1 ☑ · 1.2 ◐ · 1.3 ☑ — custody decided (Option C). Phase 2 is unblocked.** The one
> measurement still missing is a real Midnight circuit's cost, which Phase 2.1 produces as a
> by-product rather than as separate work.

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

| Metric                          | Current (arkworks / BLS12-381 Groth16)        | Midnight                                                              |
| ------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| Spend constraints               | **24,729**                                    | _not measured_                                                        |
| Spend public inputs             | **16**                                        | _not measured_                                                        |
| Setup time (spend)              | **~800 ms**                                   | _not measured_                                                        |
| **Prove time (spend), desktop** | **~700–800 ms**                               | _not measured_                                                        |
| Prove time (shield)             | ~215–240 ms                                   | _not measured_                                                        |
| Prove time (fold)               | ~1,360–1,580 ms                               | _not measured_                                                        |
| On-chain verification           | ~49.0M CPU (measured on Soroban)              | _not measured_                                                        |
| Trusted setup                   | Required — `SETUP_SEED = 42`, **no ceremony** | Required — official SRS exists, **transcript unpublished**            |
| Proving key, shipped            | **0 bytes** — derived at runtime from a seed  | **2.7 MB per circuit**, shipped as a file                             |
| Verifier key                    | 2.2 KB embedded in the contract               | 2 KB per circuit                                                      |
| Compliance circuit size         | part of the 24,729-constraint spend circuit   | **38 IR instructions** (eligibility only)                             |
| Proves on-device                | **Yes** — native Rust module, in production   | **Yes** — `midnight-proofs` 0.8.2 builds for aarch64-linux-android ✅ |

### The number that decides it

**Proving time on a mid-range Android phone.** Under a second on a desktop is comfortable; phones are
roughly 5–15× slower on this workload, which puts the current spend proof in the seconds range —
consistent with what testers experience.

The constraint is not "fast enough to be pleasant". It is: **the proof must be built on the device.**
A design that needs a server to prove has a server that knows the amount, and the product's central
claim is gone. Any alternative that cannot prove on-device is a regression regardless of every other
merit.

### What research settled (14 Sep)

Two of the open questions now have answers, from Midnight's own documentation rather than from
memory. One is decisively good; the other is the biggest risk in this migration.

**⚠️ Correction — the trusted setup question is NOT settled, and an earlier note here was wrong.**

A first pass concluded Midnight uses Halo2 with an Inner Product Argument, which would remove the
setup ceremony entirely. Checking Midnight's own repository contradicts that: `midnight-zk` describes
itself as a **"Plonk proof system using KZG commitments"** over BLS12-381 and Jubjub, and
`midnight-proofs` says the same. **KZG conventionally requires a structured reference string from a
powers-of-tau ceremony** — the property IPA exists to avoid.

Halo2 supports both backends; Midnight took the KZG one. The IPA claim came from general Halo2
material, not from Midnight, and it should not have been recorded as a finding.

What is directly observable from compiling a circuit here:

- No SRS was downloaded, and none is bundled — `~/.compact` holds 95 MB of binaries and nothing that
  looks like ceremony output.
- The 2.7 MB proving keys were generated **locally** from the circuit.

That is consistent with either a ceremony whose reference string is embedded in the `zkir` binary
(18 MB, plausible), or a setup this toolchain performs itself for development. **Those have very
different implications for mainnet**, and the difference is not visible from the outside.

**Researched 16 Sep — partly answered.** Midnight ledger **v7.0.0** switched to "the official
Midnight Structured Reference String" alongside midnight-zk 1.0, and states that **all proofs and
verifier keys generated with the previous SRS became invalid**. Mainnet is dated late March 2026.

| Question                                        | Answer                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Is there a trusted setup?                       | **Yes** — KZG needs one, and Midnight ships an official SRS                                |
| Does a production SRS exist?                    | **Yes**, since ledger v7.0.0                                                               |
| Who ran the ceremony; is the transcript public? | **Not published anywhere findable** — not in the README, the release overview, or the blog |

**What this means for Prova.** The migration does not _remove_ the trusted-setup problem; it
**transfers** it. Today the assumption is ours and plainly inadequate — `SETUP_SEED = 42` is a
constant in our own source, with no ceremony at all. After migrating it belongs to Midnight's
ceremony, and a real multi-party ceremony run by others is almost certainly stronger than a
hardcoded seed.

But "almost certainly" is doing work there, and it should not have to. **A trusted setup whose
transcript is not published cannot be independently verified**, which is the entire point of holding
one. For a product whose pitch is provable honesty, inheriting an unverifiable assumption is a poor
trade for inheriting a verifiable one.

**Still open, and worth asking Midnight directly:** who contributed, is the transcript published, and
can a third party verify it? Not answerable from public documentation; it needs their Discord or a
GitHub issue. The answer decides whether this is an upgrade or a lateral move.

**Revised verdict.** This is **no longer the strongest argument for migrating** — it was, while it
looked like Midnight removed setups entirely. It is now a _probable modest improvement on an
unverified basis_. The case for Midnight has to rest on something else: developer experience, the
`disclose` discipline the compiler enforces, and its private-state model.

**◐ Proving: the documented path is a server, but the crate looks portable.**

Tested directly rather than inferred: `midnight-proofs` resolves as a normal crate and
`cargo build --target aarch64-linux-android` compiles every dependency until `blst` (the C
BLS12-381 library) fails for want of the NDK's clang — a missing toolchain, not a platform
incompatibility. `circuits/prover/build-android.sh` already solves exactly this for the arkworks
prover, same target, same curve.

So the outcome that would break the product — witnesses leaving the device — is no longer the
likely one. What follows describes the documented default, which remains true and remains the thing
to avoid.

**⚠️ The documented path is a proof server, not the app.** Midnight generates proofs in a **Docker
service on port 6300**, and the documented guidance is browser and Node.js — the SDK's
`proofProvider` is explicitly described as letting a backend do the heavy ZK work. No mobile or
React Native path appears in the documentation.

That matters more here than it would for most projects. Prova's central claim is that **the amount
never leaves the phone**. Today an on-device Rust prover makes that literally true. A proof server
that receives the witness would know the amount — and "local proof server" means _the user's
machine_, which for a web dApp is their laptop and for a phone is nowhere obvious.

Three ways this could go, in order of preference:

| Option                                                  | On-device? | What it would take                                                                               |
| ------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| Embed the prover natively (as the Rust prover is today) | Yes        | Midnight's prover compiled for arm64 Android and bridged, mirroring `modules/prova-prover`       |
| Proof server on the user's own device                   | Yes        | A local service inside the app — heavy, but preserves the claim                                  |
| Remote proof server                                     | **No**     | Would require sending the witness off-device. **This is the one that breaks the product claim.** |

**Phase 2.1 must answer this before anything else.** It is a bigger risk than proving _time_, because
time is a number to optimise and this is a property to preserve or lose.

### Why the Midnight column is still empty

It cannot be filled by reading documentation. These numbers come from building the smallest real
circuit — credential + one compliance rule — and measuring it. **Estimating them would be the exact
failure this phase exists to prevent:** the V2 proposal asserted Midnight was "specifically suited to
programmable privacy" without a single measurement, and that assertion is what put this evaluation
here.

---

## 1.3 — Decide custody — **DECIDED: Option C**

The question the V2 proposal never asks, and the one that gates every phase after this.

### What is at stake

Today the pool contract holds the tokens **and** verifies the proof, in the same transaction. The
contract that checks the proof is the contract that holds the money, so nothing moves without a valid
proof — atomically, with no window in between and no operator who could act differently.

That property is not a nice-to-have. It is the reason a compromised backend cannot steal: the relayer
can refuse to submit, and it can observe that a proof passed through it, and that is the complete
list of its powers. Split proving and custody across two networks and the property is gone unless
something replaces it.

### The decision

| Option                                                                  | Custody          | Trust assumption                                                         | Verdict                                                                         |
| ----------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **A** — Stellar custodies, Midnight proves and authorises               | Soroban pool     | Settlement service relays authorisations faithfully                      | Rejected — a trusted relayer becomes load-bearing                               |
| **B** — Midnight custodies, Stellar settles out                         | Midnight         | A bridge or committee                                                    | Rejected for now — §30 says not to build a bridge before validating the product |
| **C** — Midnight proves compliance, Soroban keeps value and enforces it | **Soroban pool** | None added: the value layer still refuses anything without a valid proof | **CHOSEN**                                                                      |

### Why C

**It adds no trust.** A and B both convert a contract-enforced guarantee into an operator-enforced
one — A through a relay service, B through a bridge. C changes neither what holds the money nor what
decides whether it may move. The Soroban pool keeps doing both, exactly as it does today.

**It makes Midnight real without betting the product on it.** Compliance proving moves to Midnight
and is exercised for real — credentials, policy, selective disclosure — while the value layer is
untouched. If Midnight turns out slower on a phone than arkworks, or its trusted-setup story is no
better, the fallback is to keep using the Stellar proof and lose nothing.

**It is the only option that can ship incrementally.** A and B are cutover designs: the day you
switch, custody changes. C runs both proofs side by side, compares them, and moves the boundary only
when the evidence says to.

### What C means concretely

```text
Phone
  ├─ Midnight proof  → compliance: credential valid, not expired, KYC level met, limits respected
  └─ Soroban proof   → value: note ownership, no double-spend, conservation

Soroban pool contract
  └─ verifies the value proof and moves the tokens   ← unchanged, still atomic
```

Two proofs, two questions, one custodian. The Midnight proof answers _"is this person allowed to do
this?"_; the Soroban proof answers _"does this person own this note, and have they spent it before?"_

### The honest cost

**A compliance proof the value layer does not check is advisory.** That is the real trade, and it
must not be glossed: if the backend chose to ignore the Midnight proof, the Soroban contract would
still accept the spend, because it verifies note ownership rather than eligibility.

Two things bound that. First, the Soroban circuit **already enforces KYC in-circuit** today
(credential signature, expiry, `kyc_level >= min_kyc_level`), and that stays — so compliance is not
left to the advisory layer alone during the transition. Second, the path to removing the gap is
known: once the Midnight proof is trusted, the compliance constraints come **out** of the Soroban
circuit and a Midnight proof reference goes **in** as a public input the contract checks. That is a
circuit change on a system already proven to accept new public inputs (Phase 0.3 did exactly this for
`min_kyc_level`).

Until that step lands, the system's compliance guarantee is the one it has today, and no claim is
made that Midnight is enforcing anything on-chain.

### Exit test

> _Is the custody model decided, and is its trust assumption written down?_ — **yes.** Custody stays
> with the Soroban pool. No new trusted component is introduced. The compliance proof is advisory
> until the value layer verifies a Midnight proof reference directly, and that limitation is stated
> here rather than discovered later.

---

## Recommendation — proceed to Phase 2 under Option C

Custody is settled (1.3), so the blocking question is answered and Phase 2 can start. What follows is
how to start it **without betting the product on an unmeasured platform**.

### The order that keeps every step useful

1. **Build the smallest real Midnight circuit first** — credential validity plus one policy rule —
   and fill the empty column in 1.2. This is Phase 2.1, and it doubles as the measurement the
   decision still lacks. Half a day of work that turns a preference into evidence.

2. **Measure on-device proving before anything else depends on it.** A proof that cannot be built on
   the phone means a server that knows the amount, and the product's central claim is gone. This is
   the one number that could still reverse the direction, so it should be known early rather than
   discovered in Phase 5.

3. **Run both proofs side by side.** Option C allows this: the Soroban proof keeps enforcing value
   and compliance while the Midnight proof is generated, verified and compared. Nothing ships to a
   user until the two agree on the same transfers.

4. **Only then move compliance out of the Soroban circuit.** The end state is the Midnight proof
   reference as a public input the pool contract checks, with the KYC constraints removed from the
   spend circuit. Phase 0.3 already proved this contract accepts new public inputs, so the mechanism
   is known — but it is a redeploy and a forced app update, so it happens once, at the end, with
   evidence behind it.

### What still has no answer

**Does Midnight remove the trusted setup?** Today's is `SETUP_SEED = 42`, testnet-grade. Mainnet
needs either a real ceremony or a proof system that does not want one. If Midnight removes it, that
is a genuine advantage the current stack cannot match — and it is answerable from documentation
before writing a line of Compact.

### Worth building regardless

**2-in-2-out spends.** The one named, real limitation users already hit — _"your balance is split
across notes, the most you can send in one transfer is X"_ — and it needs no platform change. It also
makes the 1.2 comparison sharper, because a more complex circuit is where a different proof system's
advantages would actually show.
