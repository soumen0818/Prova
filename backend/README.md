# backend

Prova's API service — Go. Orchestrates sign-in, KYC, anchor (SEP) rails, the shielded-pool
off-chain half, and transfer history. It is a **coordinator**, never a custodian of secrets: it
never sees transfer amounts or raw identity, and Postgres holds only commitments, nullifiers,
status, and timestamps — never PII, never amounts.

## Requirements

- Go ≥ 1.25
- Docker + Compose (Postgres + Redis, or run the whole stack in Docker)
- The `prova-prover` CLI binary (built from `../circuits/prover`) — the backend shells out to it for
  every Poseidon/Jubjub operation (KYC credential signing, Merkle paths, fold proofs) rather than
  reimplementing that math in Go, so it can never silently drift from the circuits

## Run for development (Go on host, infra in Docker)

```bash
cp .env.example .env          # see .env.example for what LOCAL DEV vs PRODUCTION values look like
docker compose up -d postgres redis   # just the infra
set -a && source .env && set +a       # bare `go run` does NOT auto-load .env — see the file header
go run ./cmd/api                       # serves on :8080
curl localhost:8080/healthz
```

## Run the whole backend in Docker

```bash
docker compose up --build              # postgres + redis + prover + api + indexer
curl localhost:8080/healthz
```

`docker-compose.override.yml` is auto-merged and provides a **local Postgres** (with
`POSTGRES_PORT`/`REDIS_PORT` overrides for when the defaults collide with something else on your
machine). The ZK prover is built once (`prover-init`) and shared with the API via a volume, so the
API image itself stays small and needs no Rust toolchain.

## Roles & scaling

The **same image** runs different roles via `RUN_MODE`, so state stays external and the app scales
cleanly:

- `RUN_MODE=all` — HTTP API + embedded indexer (default; simplest single-container deploy).
- `RUN_MODE=api` — HTTP API only. Run **N replicas** behind a load balancer (stateless).
- `RUN_MODE=indexer` — the on-chain indexer only. Run **exactly one**, since it assigns Merkle leaf
  indices in queue order and two writers racing on the same range would corrupt the tree.

Compose runs `api` and `indexer` as separate services to model this. Redis is the shared rate-limit
and OTP store across API replicas (falls back to per-instance in-process counters if unset —
degraded, but never open).

## Layout

```
cmd/
  api/                entrypoint — RUN_MODE selects API and/or indexer; graceful shutdown, slog JSON
  verifyproof/         dev-only CLI: submits a proof blob to the deployed verifier, prints accept/reject
internal/
  config/              env-based runtime config (testnet defaults; see config.go for the full list)
  server/              HTTP router + every handler (see "HTTP API" below)
  store/               Postgres persistence — transfers, KYC (PII-free, append-only audit log), pool state
  transfers/            the Phase-2 relay service: accept a proof, submit to the verifier, track lifecycle
  chain/                Soroban submitter (shells out to the `stellar` CLI), event client, on-chain wallet ops
  indexer/              polls verifier `transfer` events, reconciles them into transfer history
  anchor/               minimal SEP-1/SEP-10/SEP-24 client for the deposit rails (SDF testanchor by default)
  kyc/                  the KYC verification state machine + anchor-side credential issuance
  otp/                  real one-time codes: crypto/rand, hashed at rest, 10-minute TTL, attempt-capped
  mailer/               sends the sign-in code by email (stdlib net/smtp — Gmail App Password compatible)
  ratelimit/             per-IP/per-key throttling in front of every unauthenticated endpoint
  pool/                 the shielded pool's off-chain half — see below
migrations/             versioned SQL schema (0001_init, 0002_kyc, 0003_pool), embedded + boot-applied
Dockerfile              multi-stage build → slim glibc runtime (API/indexer)
docker-compose.yml           base stack (external DATABASE_URL)
docker-compose.override.yml  dev-only: local Postgres/Redis with port overrides
```

### `internal/pool/` — the shielded pool's off-chain half

The contract (`contracts/pool`) never hashes and never stores the Merkle tree — see
`contracts/README.md`. Someone off-chain has to maintain the real tree, serve it to wallets, and
submit the batch-fold proofs. That's this package, in four pieces:

| File | Responsibility |
|---|---|
| `service.go` | Answers what a wallet cannot answer for itself: pool status, the note feed to scan, a note's Merkle path, and spent-nullifier lookups. |
| `indexer.go` | Replays on-chain pool events into the off-chain mirror wallets depend on. |
| `folder.go` | Runs `update_root` on a timer — pulls queued commitments, shells out to `prova-prover fold-prove` for the batch proof, submits it. This is what makes queued notes spendable. |
| `relayer.go` | Submits a user's spend on their behalf — never alters anything, since a spend proof already binds every field it contains. |

**Why the tree math lives in Rust, not Go:** the tree is Poseidon-hashed, and the on-chain root, the
in-circuit membership check, and this off-chain mirror must agree bit-for-bit. A second Poseidon
implementation in Go would be a permanent opportunity for silent drift — and drift here doesn't fail
loudly, it just makes notes permanently unspendable. So this package shells out to the
`prova-prover` CLI (`merkle-path`, `fold-prove`) exactly as KYC credential issuance already does,
keeping the hash in exactly one place across the whole system.

## HTTP API

Every route is registered in `internal/server/server.go`. None require a session before sign-in —
which is exactly why `ratelimit` sits in front of all of them.

| Route | Purpose |
|---|---|
| `GET /healthz`, `GET /readyz` | Liveness / readiness (readyz also reflects `MAINTENANCE_MODE`). |
| `POST /auth/otp/request`, `POST /auth/otp/verify` | Sign-in via **email** one-time code — the email is the account identifier. |
| `POST /kyc/phone/request`, `POST /kyc/phone/verify` | Verify a contact **phone** number — separate from sign-in on purpose: the phone is an anchor-required attribute, not the account identity, so changing it never costs the account. |
| `GET /countries` | The dialing-country list the picker offers, served from the same table the server validates against. |
| `POST /transfers`, `GET /transfers`, `GET /transfers/{id}` | Legacy per-transfer relay + lifecycle + history (circuit v2). |
| `POST /sep10/auth`, `POST /sep24/deposit` | Dev anchor deposit rails. |
| `POST /sep24/deposit/prepare`, `POST /sep24/deposit/complete` | User-authenticated deposit — the user signs SEP-10, so funds land in the user's own wallet. |
| `GET /pool/status`, `GET /pool/notes`, `GET /pool/path/{commitment}`, `POST /pool/spent`, `POST /pool/spend` | The shielded pool: find my note, prove my note's Merkle path, check spent status, submit a spend. Without these a wallet holds note secrets but has no way to build a spend proof at all. |
| `GET /wallet/{address}`, `POST /wallet/fund`, `POST /wallet/trustline/prepare`, `POST /wallet/trustline/submit` | Real (testnet) on-chain wallet: activate via Friendbot, add a phone-signed trustline, read balances. |
| `POST /kyc/verifications`, `GET /kyc/verifications/{userId}`, `POST /kyc/verifications/webhook`, `POST /kyc/verifications/{userId}/decide` | The KYC verification lifecycle (`Docs/kyc-verification.md`). No endpoint here ever accepts PII. |
| `POST /kyc/credential`, `POST /kyc/credential/renew`, `GET /anchors/trusted` | Credential issuance — gated on a stored `approved` verification, never on the caller's say-so — plus the trusted anchor public-key set. |

## Deploy (VPS + external database)

State is fully externalized, so a production node is just **API + indexer + Redis in Docker on a
VPS**, pointed at Postgres from any provider — the DB holds no amounts/PII, so a managed provider is
privacy-safe.

```bash
export DATABASE_URL="postgres://…"          # e.g. Supabase
export DB_SIMPLE_PROTOCOL=true              # Supabase POOLED endpoint (pgBouncer, txn mode)
export CONTRACT_ID="C…" SOROBAN_RPC_URL="https://…"
docker compose -f docker-compose.yml up --build -d
```

- **Managed Postgres (Supabase, etc.):** point `DATABASE_URL` at it. Use the session pooler / direct
  connection, or set `DB_SIMPLE_PROTOCOL=true` for the transaction-mode **pooled** endpoint (it
  doesn't support prepared statements).
- **Self-hosted Postgres:** a Postgres container with a persistent volume, as the dev override
  shows — you own backups.

The schema lives in `migrations/*.sql` and applies on boot (idempotent, embedded via
`migrations/embed.go`). Same files also run by hand against any managed database.

Full environment variable reference, what's LOCAL DEV vs PRODUCTION, and the deployment/key-generation
walkthrough for the on-chain side this backend depends on live in
[`Docs/deployment-and-keys.md`](../Docs/deployment-and-keys.md) and `.env.example`.

## Status

Every phase through the shielded pool is wired end-to-end: sign-in (email OTP with a real SMTP
mailer), phone verification, the KYC state machine + credential issuance, SEP-10/SEP-24 anchor
deposit rails, the legacy per-transfer relay + indexer, and the full pool off-chain stack (indexer,
folder, relayer, service). The relayer/folder sign via the `stellar` CLI (bundled in the Docker
image) behind the `chain.Submitter` interface — set `RELAYER_KEY` to a funded secret seed in
production. A native Go-SDK RPC submitter (no external CLI dependency) is a planned follow-up so the
image needs no bundled binary; it should land with a testnet integration test before becoming the
default.
