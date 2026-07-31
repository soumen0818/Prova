<p align="center">
  <img src="mobile/assets/images/brand-symbol.png" alt="Prova" width="420">
</p>

<h3 align="center">Private, compliant cross-border remittance on Stellar.</h3>
<p align="center"><em>The stamp is a zero-knowledge proof.</em></p>

<p align="center">
  <a href="#architecture">Architecture</a> ·
  <a href="#how-a-transfer-actually-works">How it works</a> ·
  <a href="#repository-layout">Repo layout</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="#documentation-map">Docs</a>
</p>

---

## What Prova is

**Prova** — from *"proof."* A remittance app where a transfer is accepted because it can be
**proven** legal, not because a bank, a forex desk, and three correspondent banks all got to see the
amount and the identity behind it. Think of a sealed letter with a notary stamp: the post office
never opens the letter, it just trusts the stamp. Here the stamp is a zero-knowledge proof.

The problem it solves: privacy and compliance are normally opposites — every payment system has to
*see* your data to verify it's legal. Prova's ZK "compliance certificate" proves a transfer is
KYC'd, within limits, and not a replay, **without revealing the amount or the identity behind it**.
On-chain, an observer only ever sees commitments, nullifiers, and proofs.

- **First corridor:** UAE → India.
- **Rails:** Stellar (speed, cost, and an existing anchor/SEP network for fiat on/off-ramps).
- **What Prova adds:** the one missing layer — privacy in transit, with compliance intact.

Full product framing, the persona this is built for, and the business case live in
[`Docs/proposal .md`](Docs/proposal%20.md).

## Architecture

Three trust boundaries, drawn from where secrets and computation actually live — not from which
repo a file happens to sit in:

```mermaid
flowchart TB
    subgraph phone["📱 Phone — secrets + proving"]
        seed["Master seed\n(secure enclave)"]
        prover["Rust prover\n(arkworks, on-device)"]
        wallet["Wallet UI\n(Expo / React Native)"]
    end

    subgraph chain["⛓ Soroban — verification + anti-replay"]
        verifier["verifier contract\n(circuit v2)"]
        pool["pool contract\n(circuit v3, custodies tokens)"]
    end

    subgraph server["☁ Go backend — coordinator, never a viewer"]
        api["API"]
        indexer["indexer / folder"]
        anchors["anchor + KYC orchestration"]
    end

    subgraph anchor["🏦 Licensed anchors"]
        uae["UAE anchor"]
        india["India anchor"]
    end

    wallet -->|build proof| prover
    prover -->|proof + commitment + nullifier| api
    api -->|relay| verifier
    api -->|relay| pool
    api <-->|SEP-10/24/12, Travel Rule| anchors
    indexer -->|read events| pool
    indexer -->|read events| verifier
    wallet <-->|status, history, Merkle paths| api

    style phone fill:#0E0E11,color:#fff,stroke:#E6F94E
    style chain fill:#0E0E11,color:#fff,stroke:#E6F94E
    style server fill:#0E0E11,color:#fff,stroke:#DCCBF7
    style anchor fill:#0E0E11,color:#fff,stroke:#DCCBF7
```

**The rule that makes this work:** secrets and proving live **on the phone**. Verification and
anti-replay live **on Soroban**. Orchestration, anchors, Travel Rule, and history live **in the Go
backend** — which never sees an amount or a raw identity either. It's a coordinator, not a viewer.

## How a transfer actually works

1. **Sign up.** The app generates a master seed on-device (secure enclave), creates a backend
   account keyed by email, and signs in with an emailed one-time code.
2. **Verify once (KYC).** Identity documents go from the phone to the verification provider —
   never through Prova's servers. On approval, the anchor **signs a credential**
   (`sign(userId, kycLevel, expiry)`) that the phone stores and never uploads anywhere.
3. **Add money.** The app deposits value into the shielded pool via a real anchor rail (SEP-24) or,
   in dev, a simulated instant credit.
4. **Send.** The phone selects a note, fetches its Merkle membership path from the backend, and
   generates a Groth16 proof **on-device** proving: it owns a note in the tree, the nullifier is
   fresh, value is conserved across the two outputs, and its KYC credential is valid — all without
   revealing the amount to anyone, including Prova's own servers.
5. **Submit.** The proof goes to the Soroban pool contract (directly, or relayed by the backend for
   retry handling). The contract runs one BLS12-381 pairing check, rejects replays, and queues the
   new notes.
6. **Fold.** A permissionless off-chain folder batches queued notes into the Merkle tree with its
   own proof (the contract can't hash — see `contracts/README.md`), making them spendable.
7. **Payout + Travel Rule.** For a cash-out, the two anchors exchange the required Travel-Rule data
   as a sealed, encrypted envelope — decryptable only by the receiving anchor, never on-chain.
8. **History.** The backend's indexer reads on-chain events to build a private history the wallet
   can display; nothing PII- or amount-bearing is ever stored server-side.

## Repository layout

A single git repository, one folder per component, each with its own toolchain, tests, and CI
workflow. Every component below has its own detailed `README.md` — this file is the map, not the
manual.

| Folder | Stack | What it is |
| --- | --- | --- |
| [`mobile/`](mobile/) | React Native + Expo (TS) | The consumer app: wallet, KYC, send flow, cloud backup, the native ZK prover bridge |
| [`backend/`](backend/) | Go | API, sign-in, SEP/anchor orchestration, KYC state machine, the shielded pool's off-chain half (indexer + folder + relayer) |
| [`contracts/`](contracts/) | Rust + Soroban | Two on-chain programs: the per-transfer verifier and the shielded pool (real token custody) |
| [`circuits/`](circuits/) | Rust + arkworks | The ZK circuits (BLS12-381 Groth16) and the on-device prover, shared by mobile, backend, and contracts |
| [`shared/`](shared/) | TypeScript + Go | Cross-component schemas — proof format, IVMS101, API types, error codes, the pool/note format — mirrored, not generated, in both languages |

### Full file structure

```
Prova/
├── mobile/                          Expo app (React Native, TypeScript)
│   ├── src/
│   │   ├── app/                     expo-router screens (sign-in, KYC, send, deposit, settings, …)
│   │   ├── features/                tab implementations (home, activity, profile, KYC identity step)
│   │   ├── components/              design-system primitives + app-level components
│   │   ├── lib/                     keys, vault, pool, prover bridge, API client, validation, …
│   │   ├── hooks/, constants/, config/
│   ├── modules/prova-prover/        Expo native module → JNI → the Rust prover
│   └── assets/                      brand images, fonts, icons
│
├── backend/                         Go API service
│   ├── cmd/api/                     entrypoint (RUN_MODE selects API / indexer / both)
│   ├── cmd/verifyproof/             dev CLI: submit a proof, print accept/reject
│   ├── internal/
│   │   ├── server/                  HTTP router + every handler
│   │   ├── transfers/, chain/, indexer/, anchor/     legacy per-transfer relay + Soroban + SEP rails
│   │   ├── pool/                    the shielded pool's off-chain half (service, indexer, folder, relayer)
│   │   ├── kyc/, otp/, mailer/, ratelimit/           identity, sign-in, and abuse controls
│   │   ├── store/                   Postgres persistence (PII-free, amount-free)
│   │   └── config/
│   └── migrations/                  versioned SQL, embedded + boot-applied
│
├── contracts/                       Soroban (Rust) — Cargo workspace
│   ├── verifier/                    circuit-v2 per-transfer proof verifier
│   ├── pool/                        circuit-v3 shielded pool (token custody, notes, Merkle root)
│   ├── scripts/                     deploy_testnet.sh, deploy_pool_testnet.sh
│   └── DEPLOYMENTS.md               live contract IDs, tx hashes, verification checks
│
├── circuits/
│   └── prover/                      the real crate — everything else in circuits/ is a retired
│       ├── src/lib.rs                Circom/BN254 prototype
│       ├── src/credential.rs         KYC credential: anchor-signed Jubjub EdDSA
│       ├── src/pool/                 shield / spend / fold circuits + Merkle tree + note encryption
│       ├── src/ffi.rs, jni_bridge.rs  the mobile native-module bridge
│       └── src/bin/prova_prover.rs   the CLI: setup, proving, artifact generation, dev tools
│
├── shared/                          cross-component schemas (mirrored, not generated)
│   ├── src/                         TypeScript — consumed by mobile/
│   └── go/schema/                   Go — consumed by backend/
│
├── Docs/                            product, architecture, and phase-by-phase design docs
├── .github/workflows/               one path-filtered CI workflow per component
└── README.md                        this file
```

## Prerequisites

| Tool | Version | Used by |
| --- | --- | --- |
| Node | 22 LTS (`nvm use 22`) | mobile, shared |
| Go | ≥ 1.25 | backend |
| Rust + wasm32 target | stable (see `contracts/rust-toolchain.toml`) | contracts, circuits |
| Stellar CLI | ≥ 27 | contracts (deploy), circuits (dev tools) |
| Docker + Compose | recent | backend (Postgres + Redis) |
| Expo dev client | — | mobile (Expo Go cannot load the native prover module) |

## Getting started

Each folder's own `README.md` has the full setup. Quick map:

```bash
# shared — build first; mobile and backend both depend on it
cd shared && npm install && npm run build
cd shared/go && go build ./...

# circuits — build the prover; backend and contracts both depend on the binary/artifacts it produces
cd circuits/prover && cargo build --release

# contracts
cd contracts && cargo test && stellar contract build --optimize

# backend
cd backend && cp .env.example .env && docker compose up -d postgres redis && go run ./cmd/api

# mobile
cd mobile && nvm use 22 && npm install && cp .env.example .env && npm start
```

Deploying the contracts to testnet, generating keys, and understanding which secret goes where (and
which never touches a server at all) is a full step-by-step in
[`Docs/deployment-and-keys.md`](Docs/deployment-and-keys.md) — read §1 first, since two of Prova's
keys are far more dangerous than the rest and the difference isn't obvious from their names.

## Documentation map

`Docs/` is the authoritative source for anything architectural — this repo's standing rule is to
read it before starting any non-trivial change, since Prova is a multi-repo system where the
circuit, contract, backend, and app must agree on shared formats.

| Doc | Covers |
| --- | --- |
| [`proposal .md`](Docs/proposal%20.md) | The product case: the problem, the persona, why ZK + Stellar, why it's defensible |
| [`tech-stack.md`](Docs/tech-stack.md) | Stack choices and why, the polyrepo split, the end-to-end technical workflow |
| [`implementation-guide.md`](Docs/implementation-guide.md) | The phase-by-phase build plan and exit criteria — the roadmap below is generated from this |
| [`shielded-pool.md`](Docs/shielded-pool.md) | The note/UTXO design, the Merkle-fold architecture, the full must-not-break invariant list |
| [`kyc-verification.md`](Docs/kyc-verification.md) | The verification state machine, credential issuance rules, tiers |
| [`deposit-flow.md`](Docs/deposit-flow.md) | How money enters a Prova wallet (simulated vs. real anchor rails) |
| [`account-recovery.md`](Docs/account-recovery.md) | Cloud backup, envelope encryption, the restore flow |
| [`signup-and-validation.md`](Docs/signup-and-validation.md) | Sign-up, field validation (client + server), rate limiting, email delivery |
| [`deployment-and-keys.md`](Docs/deployment-and-keys.md) | Every key, what it can do, where it goes, step-by-step contract deployment |
| [`environments.md`](Docs/environments.md) | Environment matrix and secrets handling |
| [`design-system.md`](Docs/design-system.md) | The UI style guide — dark theme, chartreuse accent, rounded glassy fintech look |
| [`branding-assets.md`](Docs/branding-assets.md) | Every brand/marketing image, spec, and generation prompt |

## CI

All workflows live in [`.github/workflows/`](.github/workflows/) and are **path-filtered** — each
one runs only when its component changes (`mobile-ci.yml`, `backend-ci.yml`, `contracts-ci.yml`,
`circuits-ci.yml`, `shared-ci.yml`, `docker-ci.yml`).

## Roadmap

| Phase | Ships | Status |
| --- | --- | --- |
| 0 — Foundations | 5-component scaffold, CI, environments, shared schemas | Done |
| 1 — Core ZK on testnet | A Groth16 proof verifies on Soroban | Done — pivoted BN254→BLS12-381 after discovering Soroban has no BN254 host functions |
| 2 — Stellar rails | Commitment/nullifier store, testnet anchor deposit flow | Done |
| 3 — KYC attestation | In-circuit anchor-signed credential check | Done |
| 4 — Mobile prover UX | On-device proving, honest progress, the shielded pool | Core done — on-device latency benchmarking on real low-end hardware is the one remaining manual step |
| 5 — Real corridor | Licensed anchors, Travel Rule, public trusted-setup ceremony, audit | Not started |
| 6 — Extraordinary | Selective disclosure, proof aggregation, compliance-proof-as-an-API | Not started |

Full detail, exit criteria, and risks per phase: [`Docs/implementation-guide.md`](Docs/implementation-guide.md).

## Privacy & security model, in one table

| Layer | Sees amounts? | Sees identity? | Holds custody? |
| --- | --- | --- | --- |
| Phone (secure enclave) | Yes — that's where it's computed | Yes — that's where credentials live | No — never on-chain balances of its own |
| Soroban contracts | No — only commitments/nullifiers | No | Yes — the pool contract custodies real tokens |
| Go backend | No | No — only an opaque `userId` hash | No |
| Licensed anchors | Only their own leg (deposit/payout) | Yes — that's their regulatory role | Only during on/off-ramp |

If you take one thing from this table: **the backend is the least trusted-with-secrets component in
the whole system, on purpose.** It coordinates a lot and stores none of what would matter if it were
breached.
