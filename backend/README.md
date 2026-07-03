# backend

Prova's API service (Go). Orchestrates SEP/anchor flows, relays proofs to Soroban, coordinates the
Travel-Rule exchange, and indexes transfer history. It is a **coordinator** — it never sees amounts
or identities (those stay on the phone and at the anchors).

## Requirements

- Go ≥ 1.23
- Docker + Compose (for local Postgres + Redis)

## Run locally

```bash
cp .env.example .env
docker compose up -d        # postgres + redis
go run ./cmd/api            # serves on :8080
curl localhost:8080/healthz
```

## Layout

```
cmd/api/             entrypoint (graceful shutdown, slog JSON logging)
internal/
  config/            env-based config (testnet defaults)
  server/            router + middleware + handlers (health now; SEP/transfer later)
docker-compose.yml   local Postgres + Redis
Dockerfile           multi-stage distroless build
Makefile             run / build / test / up / down
```

## Status

Phase 0: health/readiness endpoints, config, structured logging, local infra (this skeleton —
stdlib only, no external deps yet). Phases 2–5 add: SEP-10/12/24/31 anchor flows, the Soroban
relayer, the Travel-Rule coordinator, and the event indexer. Add deps with `go get` + `make tidy`.
