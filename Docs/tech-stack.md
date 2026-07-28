# Prova — Tech Stack & Implementation Guide

> Companion to [proposal.md](proposal.md). This document captures the recommended technology
> stack, repository structure, third-party providers, and end-to-end technical workflow for
> building Prova — the private, compliant cross-border remittance product on Stellar.

> **⚠️ Phase 1 update (crypto stack changed).** This doc originally specified **BN254 + Circom +
> SnarkJS** on the assumption *"Soroban supports BN254."* That is false — Soroban only exposes
> **BLS12-381** host functions. The ZK stack was pivoted to **BLS12-381 Groth16 via arkworks
> (Rust)**, end-to-end. Rows below are updated; see [phase1-findings.md](phase1-findings.md).

---

## 1. Quick verdict (the picks)

| Layer | Pick | Why in one line |
|---|---|---|
| Mobile app | **React Native + Expo** ✅ | One codebase, native modules for proving + secure enclave |
| On-device prover | **Rust `ark-groth16` prover** (native module / WASM) | Same crate as the circuit; BLS12-381 Groth16. `mopro`/`rapidsnark` were BN254-only — dropped |
| Smart contract | **Rust / Soroban** ✅ | Only language for Soroban; has **BLS12-381** pairing (`pairing_check`) |
| Circuits | **arkworks (Rust): `ark-groth16` + `ark-bls12-381`** | Soroban has no BN254; BLS12-381 is native. (was Circom+SnarkJS) |
| **Backend** | **Go** (primary) — see §2 | First-class Stellar SDK + concurrency for money flows |
| Database | **PostgreSQL** | Financial data needs ACID; nothing else qualifies |
| Cache / queue | **Redis** | Sessions, witness cache, job queue for anchor webhooks |

---

## 2. Backend: Go vs Node/Express vs Nest.js

**Recommendation: Go (primary).**

**Why Go wins here:**
- **Stellar's best SDK is Go.** Horizon and most of SDF's own infrastructure is written in Go.
  The `stellar/go` SDK is first-class for SEP flows, transaction building, and Soroban RPC.
- **It's a money system.** Anchor webhooks, deposit/payout callbacks, Travel-Rule message
  exchange, retries, idempotency — lots of concurrent, long-running, must-not-lose-it work.
  Go's goroutines + strong typing + simple deployment (single binary) fit exactly this.
- **Operational simplicity** for a long-lived product: one static binary, low memory, easy to
  containerize, predictable performance.

**Why not the others:**
- **Node + Express** — too unstructured for a regulated financial backend. Skip.
- **Nest.js** — genuinely good (structured, TypeScript, batteries included). Its one real
  advantage: same language as the Expo app, so you share types. **Pick Nest.js only if the team
  has zero Go experience and wants to ship faster with one language.** Pragmatic fallback, not
  the technically best choice.

> **Bottom line:** Go for technical fit and longevity. Nest.js if team velocity / single-language
> matters more than the Stellar-SDK advantage. Don't use bare Express.

---

## 3. Repo structure (polyrepo)

Separate repos are correct — three skillsets (mobile, backend, cryptography/Rust) move at
different speeds with different CI. Split into **5 repos**:

```
prova-mobile      → React Native / Expo app
prova-backend     → Go API + SEP orchestration + Travel Rule
prova-contracts   → Rust / Soroban verifier contract
prova-circuits    → arkworks (Rust) circuit + Groth16 prover + trusted-setup artifacts
prova-shared      → shared schemas: API types, IVMS101, proto/OpenAPI, error codes
```

**The one rule that makes polyrepo not painful:** put all cross-boundary contracts (API
request/response types, the proof's public-input format, IVMS101 schema, the verification key)
in `prova-shared`, publish it as a versioned package (npm for TS, a Go module, a crate), and
**version-pin** it in every consumer. This avoids the classic polyrepo bug where mobile and
backend disagree on a data shape.

`prova-circuits` is critical to keep separate: the compiled circuit + verification key is a
**shared artifact** consumed by *both* the mobile prover and the Soroban contract. If the circuit
changes, both must update in lockstep — treat the verification key as a versioned release artifact.

---

## 4. Full stack by layer (with tools/providers)

**A. Mobile (Expo)**
- Expo + React Native, **EAS Build** for native builds (custom native modules → use Expo
  "development builds", not Expo Go).
- **Secure key storage:** `expo-secure-store` → backed by iOS Keychain / Android Keystore
  (the "secure enclave").
- **State/data:** TanStack Query + a Stellar JS SDK for read-only chain queries.
- **The prover (the hard part):** the circuit + prover are **arkworks (`ark-groth16` /
  `ark-bls12-381`)** in `circuits/prover`. For on-device proving, compile that same Rust prover to a
  **native module / WASM** and run it off the JS thread. (The original `mopro`/`rapidsnark` plan was
  BN254-specific and no longer applies now that we're on BLS12-381.)

**B. Circuits / ZK**
- **arkworks (Rust):** `ark-groth16` + `ark-bls12-381`, `ark-r1cs-std` for the constraints, Poseidon
  from `ark-crypto-primitives` (EdDSA/KYC-signature gadget comes in Phase 3).
- Trusted setup: seeded (testnet-grade) now → public Powers of Tau ceremony for mainnet (Phase 5).
- The BLS12-381 point encoding Soroban expects (uncompressed, big-endian, `Fp2 = c1‖c0`) is
  documented in [phase1-findings.md](phase1-findings.md).

**C. Smart contract**
- Rust + Soroban SDK, deployed to **Stellar Testnet** first.
- **Soroban RPC provider:** SDF's free RPC for dev; **Validation Cloud / QuickNode /
  Blockdaemon** for production-grade RPC.

**D. Backend (Go)**
- `stellar/go` SDK, Postgres (via `sqlc` or GORM), Redis, a job queue (`asynq` or River) for
  webhooks/retries.
- SEP implementations: SEP-10 (auth), SEP-12 (KYC handoff), SEP-24/SEP-6 (deposit/withdraw),
  **SEP-31** (cross-border payments — the core remittance flow).
- **Indexer:** to build transaction history you must read Soroban events. Use **Mercury** or
  **Goldsky** (Stellar/Soroban indexing), or run your own event ingester.

---

## 5. Third-party providers / services checklist

- **Blockchain:** Stellar Testnet → Mainnet; Soroban RPC (SDF / Validation Cloud / QuickNode);
  Friendbot (testnet funding).
- **Anchors (the real moat):** a UAE-licensed anchor + an Indian NBFC anchor. For dev, use SDF's
  **testanchor / anchor reference implementation**.
- **KYC vendor** (anchor side): **Sumsub / Onfido / Jumio**.
- **Travel Rule network:** **Notabene** (most common), or TRP / TRUST / Sygna / OpenVASP — for
  the IVMS101 VASP-to-VASP exchange.
- **Auth / phone OTP:** **Twilio Verify** or **Firebase Auth**.
- **Push notifications:** Expo Push (wraps FCM + APNs).
- **Hosting:** backend on **Fly.io / Railway** (early) → **AWS/GCP** (scale); managed Postgres
  (Neon / Supabase / RDS); Redis (Upstash / managed).
- **Artifact/object storage:** Cloudflare R2 or S3 — to serve circuit + proving-key downloads to
  the app.
- **Secrets:** Doppler / AWS Secrets Manager / HashiCorp Vault (anchor API keys, signing keys).
- **Observability:** Sentry (mobile + backend crashes), Prometheus + Grafana or Datadog.
- **CI/CD:** GitHub Actions everywhere; EAS for mobile releases.

---

## 6. Technical workflow (end-to-end, plain language)

How the pieces talk to each other for one transfer:

1. **Sign up** — App generates a Stellar keypair + a ZK secret key, stores both in the phone's
   secure enclave. Backend (Go) creates the user record, verifies phone via Twilio.
2. **KYC once** — App sends documents to the anchor through the backend (SEP-12). The anchor's
   KYC vendor (Sumsub) verifies, then the anchor **signs a credential**
   `sign(pubkey + kyc_level + expiry)`. Backend relays this signed credential back to the app,
   which stores it in the enclave. Nothing identity-related touches the chain.
3. **Deposit** — App initiates SEP-24 deposit; anchor credits value onto Stellar. Backend
   orchestrates and tracks the flow.
4. **Enter amount** — The instant the send screen opens, the app **pre-computes the witness** in
   the Rust native module (background thread). This hides half the proving time.
5. **Confirm → proving** — The Rust/arkworks prover generates the ~200-byte BLS12-381 Groth16 proof
   on-device (range + KYC-signature + nullifier). Honest progress bar runs while it works. The
   amount never leaves the phone.
6. **Submit** — App sends `proof + commitment + nullifier + sealed IVMS101 envelope` to the
   Soroban contract (directly, or via the Go backend as a relayer for retry/gas handling). The
   contract runs **one BLS12-381 pairing check**, rejects replayed nullifiers, stores the commitment.
7. **Payout + Travel Rule** — Backend coordinates the two anchors: the encrypted IVMS101 blob is
   decryptable only by the India anchor (or exchanged off-chain via Notabene). India NBFC pays out
   to Amma.
8. **History / disclosure** — Backend's indexer reads Soroban events to build Ravi's history;
   selective-disclosure proofs are generated on-device when he wants to share a fact.

**The dividing line:** secrets + proving live **on the phone**; verification + anti-replay live
**on Soroban**; orchestration, anchors, Travel Rule, history live **in the Go backend**. The
backend never sees amounts or identities either — it's a coordinator, not a viewer.

---

## 7. What to build first (de-risking order)

Follow the proposal's phases, but front-load the two things most likely to kill the project:

1. ~~**Validate Soroban BN254 cost** (Phase 1)~~ — **DONE, and it did change the design.** Soroban
   has no BN254 host functions; pivoted to BLS12-381 Groth16 (arkworks). A real proof verifies on
   testnet at ~44.6M CPU insns, within the 100M cap. See [phase1-findings.md](phase1-findings.md).
2. **Prototype the mobile prover with `mopro`/`rapidsnark` on a real mid-range Android** — measure
   proving time. This is risk #1 in the proposal. If it's 30s, you need a leaner circuit before
   building anything else.

Everything else (anchors, Travel Rule, polished UX) is integration work that only matters once
those two are green.
