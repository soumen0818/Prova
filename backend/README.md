# backend

Prova's API service (Go). Orchestrates SEP/anchor flows, relays proofs to Soroban, coordinates the
Travel-Rule exchange, and indexes transfer history. It is a **coordinator** — it never sees amounts
or identities (those stay on the phone and at the anchors). It also never stores amounts: Postgres
holds only commitments, nullifiers, status, and timestamps.

## Requirements

- Go ≥ 1.25
- Docker + Compose

## Run for development (Go on host, infra in Docker)

```bash
cp .env.example .env
docker compose up -d postgres redis   # just the infra
go run ./cmd/api                       # serves on :8080
curl localhost:8080/healthz
```

## Run the whole backend in Docker

```bash
docker compose up --build              # postgres + redis + prover + api + indexer
curl localhost:8080/healthz
```

`docker-compose.override.yml` is auto-merged and provides a **local Postgres**. The ZK prover is
built once (`prover-init`) and shared with the API via a volume, so the API image stays small.

## Roles & scaling

The **same image** runs different roles via `RUN_MODE`, so state stays external and the app scales
cleanly:

- `RUN_MODE=all` — HTTP API + embedded indexer (default; simplest single-container deploy).
- `RUN_MODE=api` — HTTP API only. Run **N replicas** behind a load balancer (stateless).
- `RUN_MODE=indexer` — the on-chain indexer only. Run **exactly one** so events aren't ingested
  multiple times.

Compose runs `api` and `indexer` as separate services to model this. Redis is the shared idempotency
lock across API replicas.

## Deploy (VPS + external database)

State is externalized, so a production node is: **API + indexer + Redis in Docker on a VPS**, with
Postgres from any provider. The DB holds no amounts/PII, so a managed provider is privacy-safe.

```bash
# On the VPS — external/managed DB, no local Postgres:
export DATABASE_URL="postgres://…"          # e.g. Supabase
export DB_SIMPLE_PROTOCOL=true              # Supabase POOLED endpoint (pgBouncer, txn mode)
export CONTRACT_ID="C…" SOROBAN_RPC_URL="https://…"
docker compose -f docker-compose.yml up --build -d
```

- **Managed Postgres (Supabase, etc.):** point `DATABASE_URL` at it. Use the **session pooler /
  direct** connection, or set `DB_SIMPLE_PROTOCOL=true` for the transaction-mode **pooled** endpoint
  (it doesn't support prepared statements).
- **Self-hosted Postgres:** keep using a Postgres container with a persistent volume (the dev
  override shows the shape); you own backups.

The schema lives in `migrations/*.sql` and is applied on boot (idempotent). You can also run those
files by hand against a managed database.

## Layout

```
cmd/api/             entrypoint — RUN_MODE selects API and/or indexer; graceful shutdown, slog JSON
internal/
  config/            env-based config (testnet defaults)
  server/            router + handlers (health, auth/OTP, transfers, SEP, KYC)
  store/             Postgres store (applies embedded migrations; Supabase-safe pgx config)
  transfers/         relay service (idempotent by nullifier)
  chain/             Soroban submitter + events client
  indexer/           on-chain event → history reconciler
migrations/          versioned SQL schema (embedded + runnable against any Postgres)
Dockerfile           multi-stage build → slim glibc runtime (API/indexer)
docker-compose.yml           base stack (external DATABASE_URL)
docker-compose.override.yml  dev-only: local Postgres
```

## Status

Phases 2–4 are wired: SEP-10/12/24 anchor flows, phone-login OTP, the transfer relay, the on-chain
event indexer, and KYC credential issuance. The relay signs via the `stellar` CLI (bundled in the
image) behind the `chain.Submitter` interface — set `RELAYER_KEY` to a funded secret seed in Docker.
A native Go-SDK RPC submitter (no CLI) is a planned follow-up so the image needs no external binary;
it should land with a testnet integration test before becoming the default.
