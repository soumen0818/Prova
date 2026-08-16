# Deploying the backend to a single machine (EC2 or any VPS)

Everything — API, indexer, folder, Postgres, Redis, TLS — on one box, from the compose files already
in `backend/`.

This is the right shape while Prova is on testnet: one machine, one operator, no real money. What
changes when real funds are involved is listed at the end, and it is mostly not about hosting.

---

## Why not serverless

Three things in this backend rule it out, and they are worth knowing before someone suggests Lambda:

- **The folder runs on a timer.** Every 8 seconds it batches queued notes into the Merkle tree.
  Until it runs, deposits and change are "confirming" and cannot be spent. A function that only
  executes on an HTTP request means that with no traffic, nobody's money ever becomes spendable.
- **The indexer polls the chain continuously** to build the note feed wallets scan.
- **It shells out to two binaries** — the `stellar` CLI and the Rust prover — and fold proving is
  CPU-bound with a proving key cached on local disk.

---

## 1. The machine

| | |
| --- | --- |
| Instance | `t4g.small` (ARM) or `t3.small` — **not** `t3.micro` |
| Disk | 20 GB+ |
| Ports open | **443 and 80 only** (plus 22 from your own address) |

Avoid burstable micro instances: fold proving is CPU-bound and will drain CPU credits, and a
throttled folder means money stuck as "confirming".

ARM is safe — `backend/Dockerfile` detects `TARGETARCH` and pulls the matching Stellar CLI build.

Nothing else needs to be open. Postgres, Redis and the API are not reachable from outside the
machine (see step 4).

## 2. Install Docker

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER   # log out and back in
```

## 3. Clone and configure

```bash
git clone <your repo> prova && cd prova/backend
cp .env.production.example .env
```

Fill in `.env`. On testnet only four values actually need your attention:

| Variable | How to get it |
| --- | --- |
| `RELAYER_KEY` | `stellar keys generate prova-relayer --network testnet` then `stellar keys show prova-relayer`. Use the raw `S…` secret, **not** the identity name — a name is read from `~/.config/stellar`, which does not exist in a container, and every send would fail at submission. Fund the `G…` address at `friendbot.stellar.org`. |
| `COMPLIANCE_TOKEN` | `openssl rand -hex 32`. Empty means `/ops` is unauthenticated. The web app's value must match. |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24`. Used by the compose overlay; the stack refuses to start without it. |
| `API_DOMAIN` | The hostname pointing at this machine, e.g. `api.prova.app`. Caddy gets a certificate for it. |

`SMTP_*` you already have. Everything else can keep its development value on testnet.

**Quote any value containing a space, `#`, or quotes.** Unquoted, `#` starts a comment and a space
ends the value — both have silently truncated a secret in this project already.

## 4. Point DNS at the machine

An `A` record for `API_DOMAIN` → the instance's public IP. Caddy cannot obtain a certificate until
this resolves.

## 5. Start it

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

**Both `-f` flags are required.** Naming the files explicitly stops Docker auto-merging
`docker-compose.override.yml`, which is the *development* overlay: it hardcodes the Postgres
password as `prova:prova` and publishes Postgres on a host port. Harmless on a laptop; an open
database on a public address.

What the production overlay changes:

- Postgres and Redis publish **no** host ports — reachable only on the internal compose network.
  Redis runs without a password, and a published Redis port is among the most reliably exploited
  mistakes on the internet.
- The API binds to `127.0.0.1`, so the only route in is Caddy. Otherwise anyone could skip TLS by
  talking to `:8080`.
- Caddy terminates TLS and renews certificates by itself.

Verify:

```bash
curl -s https://$API_DOMAIN/healthz          # {"status":"ok",...}
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f indexer
```

The API log line `backend listening` and the absence of `COMPLIANCE_TOKEN is not set` are the two
things worth reading at boot.

## 6. Point the app at it

In `mobile/.env`:

```
EXPO_PUBLIC_API_BASE_URL=https://api.your-domain.com
```

Then rebuild the APK. `localhost` only worked over USB with `adb reverse`.

---

## Backups — the part self-hosting makes yours

The database holds two very different things:

- **Pool indexer state** — rebuildable by re-reading the chain. Losing it costs a resync.
- **The KYC audit trail** — *not* rebuildable. It is the append-only record of every verification
  decision, and the one thing a regulator asks to see.

So the backup exists for the second. A nightly dump off the machine:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U prova prova | gzip > prova-$(date +%F).sql.gz
```

Put it in cron, ship it to S3, and **restore it once** to prove the file is usable. An untested
backup is a belief, not a backup.

---

## What changes for real money

Hosting is the least of it:

- **`POOL_SETUP_SEED`** must come from a public Powers of Tau ceremony, with the contract's
  verification key updated to its output. On testnet `42` is fine — forging proofs mints worthless
  tokens. With real funds it is the single hardest blocker, and no configuration can substitute.
- **A licensed payout anchor**, without which money cannot leave the pool to a bank.
- **A licensed verification vendor**, so identity review is a real check rather than a person
  approving an opaque hash.
- **Managed Postgres**, once losing the audit trail has consequences.
- **A fresh `ANCHOR_SEED`** in a secret manager, published on-chain with `set_anchor`.
