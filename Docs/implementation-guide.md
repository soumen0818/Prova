# Prova — Phase-Wise Implementation Guide

> Companion to [proposal.md](proposal.md) and [tech-stack.md](tech-stack.md). This is the
> end-to-end build plan for Prova. It takes the product idea and the chosen stack and turns them
> into an ordered sequence of phases, where each phase ships a working, testable artifact and
> de-risks the next.

---

## ⚠️ Standing rule — read before EVERY phase and EVERY task

> **Before writing a single line of code in any phase, first read the entire `Docs/` folder and
> scan the existing codebase across all repos.** Confirm what already exists, what the current
> data shapes are, what the proposal/stack docs say, and where the phase you're about to start
> picks up. Never build in isolation — Prova is a multi-repo system where the circuit, contract,
> backend, and app must agree on shared formats. A change in one repo almost always implies a
> change in `prova-shared` and a matching change in the consumers.

This note applies at the start of **every** phase below. It is intentionally repeated as the first
line of each phase so it can never be skipped.

---

## How to read this guide

- The product is built across **5 repos** (see [tech-stack.md](tech-stack.md) §3):
  `prova-circuits`, `prova-contracts`, `prova-backend`, `prova-mobile`, `prova-shared`.
- Phases are **ordered and dependent** — do not parallelize whole phases. Within a phase, the
  per-repo workstreams can run in parallel once the shared contract for that phase is frozen.
- Each phase has: **Goal**, **What to build (per repo)**, **Exit criteria**, **Risks to watch**.
- "Freeze the shared contract" means: agree the data shapes in `prova-shared`, version them, and
  tag a release before consumers start coding against them.

---

## Phase 0 — Foundations & repo scaffolding

> **⚠️ Before doing anything: read the whole `Docs/` folder and scan the codebase, then start.**

**Goal:** A clean, reproducible 5-repo skeleton with CI, environments, and shared schemas in place,
so every later phase has somewhere to land.

**What to build (per repo):**
- `prova-shared`
  - Repo scaffold + versioning/release setup (semver, changelog).
  - Placeholder schema files: API request/response types (OpenAPI or proto), the proof
    public-input format, the IVMS101 schema, shared error codes, the verification-key format.
  - Publish pipeline: npm package (for TS/mobile), Go module path, optional crate.
- `prova-circuits`
  - Repo scaffold, Circom + SnarkJS toolchain pinned, circomlib vendored, `.ptau` download script.
  - Makefile/justfile for `compile → setup → prove → verify` locally.
- `prova-contracts`
  - Rust + Soroban SDK project, `cargo` workspace, testnet deploy script, Soroban RPC config.
- `prova-backend`
  - Go module, project layout (handlers/services/store), Postgres + Redis docker-compose for local.
  - Config + secrets loading, structured logging, health endpoint.
- `prova-mobile`
  - Expo app with **development build** config (not Expo Go — native modules are coming).
  - `expo-secure-store` wired, navigation, base UI shell, env config per environment.

**Cross-cutting:**
- GitHub Actions CI in every repo (lint, test, build).
- Environments defined: `local`, `testnet/dev`, `staging`, `prod`. Document RPC URLs, network
  passphrases, and which anchor each env points at.
- Secrets management chosen and wired (Doppler / AWS Secrets Manager / Vault).
- Observability bootstrapped: Sentry DSNs (mobile + backend), basic metrics endpoint.

**Exit criteria:** Every repo builds green in CI; mobile dev build runs on a real device; backend
health endpoint responds; a dummy Soroban contract deploys to testnet; `prova-shared` publishes a
`v0.1.0` package consumable by backend and mobile.

**Risks:** Skipping environment/secrets discipline now causes pain in Phase 5. Set it up properly.

---

## Phase 1 — Core ZK on testnet (prove the math works on Stellar)

> **✅ COMPLETE.** Outcome: Soroban has **no BN254** host functions, so the stack pivoted to
> **BLS12-381 Groth16 via arkworks (Rust)**. A real proof verifies on testnet (contract
> `CB7MT652LPAW5UUEQ4RWQ3CF3RM2Z3RZK7PLXMRWCRKRJB5A3Q23TOSC`), a tampered proof is rejected, and the
> pairing cost (~44.6M CPU insns) fits the budget. Full write-up: [phase1-findings.md](phase1-findings.md).
> The "What to build" below is the original BN254/Circom plan, kept for history — the *implemented*
> stack is arkworks/BLS12-381.

> **⚠️ Before doing anything: read the whole `Docs/` folder and scan the codebase, then start.**

**Goal:** A Groth16 proof generated off-chain verifies on a Soroban contract on Stellar testnet.
This is the single most important de-risking step — if Soroban BN254 verification is too expensive
or unsupported, the whole design changes. **Do the BN254 cost check in week one.**

**What to build (per repo):**
- `prova-circuits`
  - Circom circuit v1: **range check** (`amount ∈ [1, 9999]` via bit-decomposition) + **nullifier**
    (`Poseidon(secret_key, transfer_id)`) + **commitment** (`hash(amount + secret_key)`).
  - SnarkJS testnet trusted setup using Hermez `.ptau`; export proving key + verification key.
  - Test vectors: valid proof, out-of-range proof (must fail), replayed nullifier scenario.
- `prova-shared`
  - **Freeze v1 of the proof public-input format and the verification-key format.** This is the
    contract between circuit, contract, and (later) the mobile prover. Tag a release.
- `prova-contracts`
  - Soroban verifier contract v1: BN254 pairing check against the embedded verification key;
    returns accept/reject. Store nothing yet beyond what's needed to verify.
  - **Gas/cost benchmark:** measure the resource cost of one pairing check on testnet. Document it.
  - Unit + integration tests: valid proof accepts, tampered proof rejects.
- `prova-backend` *(thin slice only)*
  - A dev-only endpoint/CLI that submits a proof to the contract and reports accept/reject — used
    for testing, not the real flow yet.

**Exit criteria:** A proof produced by `prova-circuits` verifies on the deployed Soroban contract on
testnet; an invalid/tampered proof is rejected; the BN254 cost is measured and documented as
acceptable.

**Risks (highest in the project):** Soroban BN254 maturity/cost. If the pairing check is too
expensive, evaluate proof aggregation earlier or a leaner curve/circuit before proceeding.

---

## Phase 2 — Stellar rails + commitment/nullifier store

> **✅ COMPLETE (verified on testnet + SDF testanchor).** The contract is now a state machine:
> `submit(proof, commitment, nullifier)` verifies → rejects replays → records → emits an event
> (contract `CAM5FO22PLIINNETME2CXFPS2WL7WCYOESYTLNYPQMWVKWDADWD4BTJC`). The Go backend relays
> transfers (Postgres lifecycle + Redis idempotency), and SEP-10 auth + SEP-24 deposit run against
> the SDF testanchor. Mobile has a thin connect+deposit screen. See [phase2-findings.md](phase2-findings.md).

> **⚠️ Before doing anything: read the whole `Docs/` folder and scan the codebase, then start.**

**Goal:** The contract becomes a real state machine — it records commitments and nullifiers,
rejects replays, and is fed through a deposit flow from a testnet anchor.

**What to build (per repo):**
- `prova-contracts`
  - Extend the verifier into a stateful contract: **nullifier registry** (reject any repeated
    nullifier → anti-replay/double-spend) + **commitment store**.
  - Emit Soroban **events** for each accepted transfer (commitment, nullifier) — the indexer will
    consume these.
  - Tests: replayed nullifier is rejected; commitment is stored and queryable.
- `prova-backend`
  - **SEP-10** authentication with the testnet anchor.
  - **SEP-24 / SEP-6** deposit flow wiring (deposit AED-equivalent test asset onto Stellar).
  - Transaction submission/relayer path: accept a proof+commitment from a client, submit to the
    contract, handle retries/idempotency (use the Redis-backed job queue).
  - Persist transfer records in Postgres (status, commitment ref, timestamps — never amounts).
- `prova-mobile` *(thin slice)*
  - Minimal "connect + deposit" screen driving the SEP flows through the backend, to prove the
    rails end-to-end. No proving on device yet (use a test proof or backend-side prover for now).
- `prova-shared`
  - Freeze the transfer-submission API shape (what the client sends to the backend) and the event
    schema the indexer reads.

**Exit criteria:** A test user can deposit via a testnet anchor; a transfer with a valid proof is
recorded on-chain with its commitment + nullifier; a replayed transfer is rejected; the backend
tracks the transfer lifecycle.

**Risks:** Anchor testnet flows can be finicky — use SDF's anchor reference/testanchor and document
the exact SEP versions.

---

## Phase 3 — KYC attestation circuit (the compliance breakthrough)

> **✅ COMPLETE (verified on testnet).** Circuit v2 verifies an **anchor-signed KYC credential inside
> the proof** (Poseidon-challenge Schnorr/EdDSA over Jubjub) + expiry + level, with zero identity
> on-chain. A KYC proof verifies + records on testnet (contract
> `CBQ2HVIYASMYNRIKWM54JUA3A4OGQOWRP42BLMRRB262YQINAA36GD5U`). Backend issues credentials (SEP-12
> shape) via the prover CLI; mobile stores the credential in the secure enclave. Expired/forged
> credentials fail. See [phase3-findings.md](phase3-findings.md).

> **⚠️ Before doing anything: read the whole `Docs/` folder and scan the codebase, then start.**

**Goal:** The circuit now also proves the sender holds a valid anchor-signed KYC credential —
verified *inside* the proof — without any identity data touching the chain. This is Prova's core
innovation.

**What to build (per repo):**
- `prova-circuits`
  - Circuit v2: add **KYC-signature verification inside the circuit** — verify the anchor's
    signature over `sign(pubkey + kyc_level + expiry)` using EdDSA (circomlib), as a private input.
  - Add expiry/kyc-level checks. Public output stays minimal: "holds a valid credential from an
    authorised anchor", plus the existing range + nullifier outputs.
  - New trusted-setup artifacts for the larger circuit; new test vectors (valid credential, expired
    credential, forged signature → must fail).
- `prova-shared`
  - Define the **attested credential format** (`pubkey + kyc_level + expiry + anchor signature`) and
    the anchor public-key/verification-key distribution format. Freeze + version.
- `prova-backend`
  - **SEP-12 KYC handoff**: route the user's documents to the anchor; receive the anchor-signed
    credential back; relay it to the app (backend never stores raw identity — anchor does).
  - Integrate the anchor-side KYC vendor path (Sumsub/Onfido) in the anchor integration layer.
  - Store/serve the set of trusted anchor public keys (so app + contract know which signatures count).
- `prova-contracts`
  - Update the embedded verification key to the v2 circuit. Confirm the on-chain verifier accepts
    the KYC-inclusive proof. Re-measure cost (circuit got bigger).
- `prova-mobile` *(thin slice)*
  - KYC screen: capture docs → backend → receive credential → store credential in secure enclave.

**Exit criteria:** A user completes KYC once, receives a signed credential stored only in their
wallet, and can generate a proof that verifies (on-chain) they are KYC'd — with no passport/name/DOB
anywhere on-chain. Expired/forged credentials fail.

**Risks:** In-circuit signature verification is constraint-heavy and slows proving — measure proving
time now, because Phase 4 depends on it being tolerable.

---

## Phase 4 — Mobile prover UX (where ZK consumer apps live or die)

> **✅ Core done (on-device prover works; on-physical-device run is the one manual step).** The
> arkworks prover is compiled to an Android native library and called via an Expo native module
> (AsyncFunction → native thread). An on-device-format proof verifies on live testnet; the backend
> relays v2 proof blobs (fixed) and an indexer builds history. Rebuild the app (`npx expo
> run:android`) to run proving on the device and measure latency. See [phase4-findings.md](phase4-findings.md).

> **⚠️ Before doing anything: read the whole `Docs/` folder and scan the codebase, then start.**

**Goal:** Move proof generation fully on-device with acceptable, honest latency. The amount never
leaves the phone. Target ≤ 8s *perceived* on a mid-range Android.

**What to build (per repo):**
- `prova-mobile`
  - **Native Rust prover module** bound via **`mopro` + `rapidsnark`** (preferred) — generates the
    Groth16 proof on a native thread, off the JS thread. (Plain WASM-via-JSI is the documented
    fallback if native binding stalls.)
  - **Pre-computation:** start witness generation the instant the send screen opens.
  - **Honest progress bar** during proving; UI stays responsive ("Securing your transfer… 8s").
  - **Secure enclave usage:** ZK secret key + KYC credential read from `expo-secure-store`; keys
    never leave the device.
  - Full send flow on device: enter amount → pre-compute witness → confirm → prove → submit to
    contract (via backend relayer) → "Sent ✅".
  - Wallet basics: balance, recipient selection, transfer history (read from backend/indexer).
- `prova-backend`
  - **Indexer** consuming Soroban events (Mercury/Goldsky or self-hosted) to build per-user history.
  - **Push notifications** (Expo Push) on transfer success/failure.
  - Serve circuit + proving-key artifacts to the app from object storage (R2/S3), versioned.
- `prova-circuits`
  - **Circuit minimisation pass**: prove exactly what's required, nothing more — every constraint
    removed shortens proving time. Re-benchmark on real devices.

**Exit criteria:** A real transfer is generated end-to-end on a physical mid-range Android within the
latency target; UI never freezes; on success a block-explorer link shows a commitment and **no
amount**; history populates from the indexer.

**Risks (proposal's #1 product risk):** proving latency on low-end phones. Mitigations are
pre-computation + lean circuit + native thread. If still too slow, revisit circuit size before any
mainnet work.

---

## Phase 5 — Real corridor, Travel Rule & public ceremony (production readiness)

> **⚠️ Before doing anything: read the whole `Docs/` folder and scan the codebase, then start.**

**Goal:** Turn the working testnet system into a live, legally-defensible single corridor (UAE → IN)
with real licensed anchors, Travel-Rule compliance, a public trusted setup, and a security-audited
contract.

**What to build (per repo / workstream):**
- **Anchors & corridor**
  - Onboard one **UAE-licensed anchor** (deposit + KYC) and one **Indian NBFC anchor** (payout).
  - Implement **SEP-31** cross-border payment flow between the two anchors via the backend.
  - Legal agreements + regulatory sign-off workstream (non-engineering, but track it here).
- **Travel Rule** (`prova-backend` + `prova-shared`)
  - **Primary mechanism:** the **sealed IVMS101 envelope** — encrypt originator+beneficiary data to
    the beneficiary anchor's public key; it travels with the transfer; only the IN anchor decrypts.
  - **Fallback/interop:** VASP-to-VASP off-chain exchange via **Notabene / TRP / TRUST**, keyed by
    transfer ID, for anchors requiring the established pattern.
  - Freeze the IVMS101 envelope format + encryption scheme in `prova-shared`.
- **Trusted setup** (`prova-circuits`)
  - Run the **public Powers of Tau ceremony** with community participants; publish the final
    proving/verification keys. Update the contract's embedded verification key to the ceremony output.
  - Treat the ceremony as marketing (transparency = trust).
- **Security & hardening** (all repos)
  - Independent **security audit** of the Soroban contract and the circuit.
  - Pen-test the backend; key-management review (enclave, anchor signing keys, secrets).
  - Mainnet deployment runbooks, monitoring/alerting, incident response.
- **Regulatory**
  - Pursue the **RBI / CBUAE opinion letter** confirming the ZK proof satisfies the Travel Rule —
    the precedent moat.

**Exit criteria:** A real (limited-amount, within-corridor) transfer completes end-to-end on mainnet
through licensed anchors; Travel-Rule data is exchanged sealed/edge-to-edge; the contract uses
ceremony-produced keys; audit findings are resolved.

**Risks:** Anchor onboarding is slow (start with exactly one each side); regulator acceptance is a
milestone not a given; FEMA/CBUAE legal complexity — keep scope to one corridor and within-limit
amounts initially.

---

## Phase 6 — "Extraordinary" features (design for from day one, ship now)

> **⚠️ Before doing anything: read the whole `Docs/` folder and scan the codebase, then start.**

**Goal:** Add the differentiators that turn Prova from a single app into ecosystem infrastructure.
These should be *designed for* in earlier phases (especially the contract and circuit shapes) but
are shipped here.

**What to build:**
- **Selective disclosure** (`prova-circuits` + `prova-mobile`)
  - Circuits + on-device flow that let a user prove a fact about their history (e.g. "sent ≥ X over
    12 months") to one party without revealing amounts to anyone else.
- **Proof aggregation** (`prova-contracts` + `prova-circuits`)
  - Batch ~50 proofs into a single on-chain verification → ~50× fee reduction at scale. The contract
    should have been designed to accommodate this from Phase 3 — implement it here.
- **"Prova Inside" — compliance-proof-as-an-API** (`prova-backend` + `prova-shared`)
  - Expose the compliance-proof *format* as a documented, versioned API other Stellar remittance
    companies can integrate. This is the infrastructure-layer business.

**Exit criteria:** Selective-disclosure proofs verify for a third party with zero amount leakage;
aggregated batch verification works and demonstrably lowers per-transfer cost; the Prova Inside API
has external documentation and at least one integration path proven.

---

## Cross-phase: the always-on workstreams

These run continuously across all phases, not just one:

- **`prova-shared` discipline** — every cross-repo format change is versioned here first, then
  consumed. This is the spine that keeps the polyrepo coherent.
- **KYC & verification** — the identity layer that makes the compliance proof *mean* something has
  its own spec: [kyc-verification.md](kyc-verification.md) (state machine, approval rules, gated
  issuance, credential lifecycle, tiers). Account backup/recovery is in
  [account-recovery.md](account-recovery.md); the deposit rails are in
  [deposit-flow.md](deposit-flow.md).
- **The shielded pool** — [shielded-pool.md](shielded-pool.md) is the plan for the **real value
  layer**: the note/UTXO model, circuit v3 (Merkle membership + value conservation), and a Soroban
  contract that actually custodies tokens. Until it lands, the "private balance" is a local counter
  and a ZK transfer proves a statement without moving value. Its §10 is the remaining Rust spec.
- **Testing** — unit tests per repo; circuit test vectors (valid + must-fail cases); contract
  integration tests on testnet; end-to-end transfer tests; device-matrix proving-latency tests.
- **Security** — threat-model reviews each phase; the formal audit in Phase 5; ongoing dependency
  and key-management hygiene.
- **Observability** — Sentry, metrics, and structured logs from Phase 0 onward; transfer-success and
  proving-latency dashboards.
- **Docs** — keep `Docs/` authoritative. Any architectural decision updates the relevant doc so the
  standing rule ("read the whole Docs folder first") stays meaningful.

---

## Phase summary (at a glance)

| Phase | Ships | Key de-risk |
|---|---|---|
| **0 — Foundations** | 5 repos scaffolded, CI, envs, shared schemas | Project hygiene |
| **1 — Core ZK on testnet** ✅ | Proof verifies on Soroban (BLS12-381) | **De-risked: Soroban has no BN254 → pivoted to BLS12-381/arkworks** |
| **2 — Stellar rails** ✅ | Commitment/nullifier store + deposit flow | Done — testnet submit/replay + testanchor SEP-10/24 |
| **3 — KYC attestation** ✅ | In-circuit KYC signature check | Done — Jubjub EdDSA verified in-circuit, testnet |
| **4 — Mobile prover UX** 🟢 | On-device proving, honest progress | Prover native lib works; on-device latency run pending rebuild |
| **5 — Real corridor + ceremony** | Live anchors, Travel Rule, audit, mainnet | Regulator + anchor onboarding |
| **6 — Extraordinary** | Selective disclosure, aggregation, Prova Inside API | Scale economics |

> The golden thread: **secrets + proving on the phone, verification + anti-replay on Soroban,
> orchestration + anchors + Travel Rule + history in the Go backend** — and the backend never sees
> amounts or identities either.
