# Prova

Private, compliant cross-border remittance on Stellar. A zero-knowledge "compliance certificate"
proves a transfer is legal (KYC'd, within limits, not sanctioned, not replayed) **without revealing
the amount or identity**. On-chain you only ever see commitments, nullifiers, and proofs.

> Internal product & architecture docs live in `Docs/` (not tracked in git).

## Monorepo layout

A single git repository, one folder per component, each with its own toolchain:

| Folder | Stack | What it is |
| --- | --- | --- |
| [`mobile/`](mobile/) | React Native + Expo (TS) | The consumer app: wallet, send flow, on-device prover |
| [`backend/`](backend/) | Go | API, SEP/anchor orchestration, Travel-Rule, indexer |
| [`contracts/`](contracts/) | Rust + Soroban | On-chain Groth16 verifier, nullifier registry, commitments |
| [`circuits/`](circuits/) | Circom + SnarkJS | The compliance circuit (range + KYC-sig + nullifier) |
| [`shared/`](shared/) | TypeScript | Cross-component schemas (proof I/O, IVMS101, API types, VK) |

## Prerequisites

| Tool | Version | Used by |
| --- | --- | --- |
| Node | 22 LTS (`nvm use 22`) | mobile, shared, circuits |
| Go | ≥ 1.23 | backend |
| Rust + stellar CLI | rustc ≥ 1.8x, stellar ≥ 27 | contracts |
| circom + snarkjs | circom ≥ 2.1 | circuits |
| Docker + Compose | recent | backend (Postgres + Redis) |

## Getting started (per component)

Each folder has its own `README.md` with setup. Quick map:

```bash
# mobile
cd mobile && nvm use 22 && npm install && npm start

# contracts
cd contracts && cargo build --target wasm32-unknown-unknown --release

# backend
cd backend && docker compose up -d && go run ./cmd/api

# shared
cd shared && npm install && npm run build
```

## CI

All workflows live in [`.github/workflows/`](.github/workflows/) and are **path-filtered** — each one
only runs when its component changes. See each `*-ci.yml`.

## Build order (see `Docs/implementation-guide.md`)

Phase 0 (foundations) → Phase 1 (core ZK on testnet) → Phase 2 (Stellar rails) →
Phase 3 (KYC attestation) → Phase 4 (mobile prover UX) → Phase 5 (real corridor) → Phase 6 (extras).
