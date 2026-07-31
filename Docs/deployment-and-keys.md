# Deployment & keys — step by step

> Every key Prova uses, what it can do, where it goes, and the exact commands to deploy the
> contracts. Read §1 before generating anything: two of these keys are far more dangerous than the
> rest, and the difference is not obvious from their names.

---

## 1. The keys, ranked by what they can destroy

| Key | If stolen, an attacker can… | Lives | Ever on a server? |
|---|---|---|---|
| **Pool admin** | Replace the contract's code → **drain the entire pool** | Hardware wallet / CLI keystore | ❌ **Never** |
| **Anchor (KYC) seed** | Forge unlimited "verified" credentials → **compliance collapse** | Backend secret manager | ✅ Yes (backend only) |
| **SMTP app password** | Send mail as you; read nothing | Backend secret manager | ✅ Yes |
| **User master seed** | Spend that one user's money | The phone's secure enclave | ❌ Never |
| **Relayer** | Waste transaction fees; refuse to relay | Backend secret manager | ✅ Yes |
| **Deployer** | Nothing after deployment | CLI keystore | ❌ Not needed |

Two rules follow from that table, and they are the whole of the security model:

1. **The pool admin secret never touches a server, a `.env`, or git.** It can replace the contract,
   so a compromised backend would mean a drained pool. The backend genuinely does not need it.
2. **The anchor seed cannot forge money, but it can forge *compliance*.** An attacker with it signs
   themselves a "verified" credential and uses the pool with no KYC at all. Not theft — a licensing
   problem, which for a remittance business can be worse.

> The relayer key is deliberately low-value. It pays fees and submits transactions that are already
> authorised by a proof; it cannot alter an amount, a recipient or a destination. If it leaks, rotate
> it and move on.

---

## 2. Prerequisites

```bash
# Rust + the wasm target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# Stellar CLI (this repo is tested against 27.x)
cargo install --locked stellar-cli
stellar --version

# Build the prover CLI — deployment reads the anchor key from it, so the on-chain value can never
# be hand-copied wrongly.
cd circuits/prover && cargo build --release
```

---

## 3. Generate the keys

### 3.1 Pool admin — the dangerous one

```bash
stellar keys generate prova-admin --network testnet --fund
stellar keys address prova-admin      # G… — this is what goes on-chain
```

> **CLI version note.** Older guidance for this command used a `--global` flag. As of stellar-cli 27
> (what this repo is tested against) there is no such flag — `stellar keys generate` always stores
> the secret in `~/.config/stellar/identity/`, never in the project folder, so it cannot be committed
> by accident either way. If your CLI is a different version and `stellar keys generate --help` shows
> a `--global` or `--secure-store` option, either is fine; just don't point it at a project-local
> config directory.

- Testnet: a single key on your machine is fine.
- **Before mainnet: move to a 2-of-3 multisig** with `set_admin`. Stellar supports multisig natively.
  Doing it early is cheaper than doing it under pressure.

Only the **public address** ever leaves your machine.

### 3.2 Deployer / relayer

```bash
stellar keys generate prova-test --network testnet --fund
```

One key can do both jobs on testnet. Keep them separate in production: the relayer runs
unattended on a server, the deployer does not need to exist afterwards.

**Do not reuse `prova-admin` for this.** The whole point is that the admin key stays cold.

### 3.3 Anchor (KYC signing) seed

A 32-byte hex Jubjub scalar. The prover CLI has a built-in dev key; generate a real one for anything
beyond local development:

```bash
openssl rand -hex 32       # → ANCHOR_SEED
```

Check what public key it produces — this is what the pool contract will trust:

```bash
ANCHOR_SEED=<hex> ./circuits/prover/target/release/prova-prover anchor-pubkey \
  --anchor-seed <hex>
# → {"x":"…","y":"…"}
```

Rotatable later with `set_anchor` (§6), which is why a leak here is recoverable.

---

## 4. Deploy

### 4.1 Find the token contract

The pool custodies a SEP-41 / Stellar Asset Contract token. On testnet that is SRT:

```bash
stellar contract id asset --asset SRT:<ISSUER_G_ADDRESS> --network testnet
# → C… — this is TOKEN_ID
```

### 4.2 Deploy the pool

```bash
cd contracts
TOKEN_ID=C... ./scripts/deploy_pool_testnet.sh
```

The script builds, deploys, reads the anchor public key **from the prover** (so the on-chain value
cannot drift from the circuit), initialises, and prints the contract id.

`initialize` is **one-shot**. If you pass the wrong admin address you must redeploy — cheap on
testnet, but check the `G…` before confirming.

### 4.3 Warm the fold proving key

Optional, and worth it: the folder derives this key on first use (~1.5 s). Pre-building it means the
first fold is not the one that pays.

```bash
mkdir -p /var/lib/prova
echo '{"leaves":[],"new":["0000000000000000000000000000000000000000000000000000000000000001"]}' \
  | ./circuits/prover/target/release/prova-prover fold-prove \
      --pk-cache /var/lib/prova/fold_pk.bin > /dev/null
```

~27 MB. A pure cache — deleting it costs time, never correctness. It is stored **uncompressed** on
purpose: the compressed form measured ~11 s to load, because decompressing millions of curve points
costs a modular square root each, which is slower than regenerating the key.

---

## 5. Where each value goes

### `backend/.env`

```bash
# Public identifiers — safe to commit and share.
CONTRACT_ID=C...                     # Phase-2 verifier (existing)
POOL_CONTRACT_ID=C...                # from §4.2

# Low-value: pays fees, submits already-authorised transactions.
RELAYER_KEY=prova-test               # CLI identity name, or an S… seed in Docker

# Signs KYC credentials. Cannot move money; CAN forge compliance.
ANCHOR_SEED=<hex from §3.3>

# Must match the seed the contract's embedded verifying keys were built with.
POOL_SETUP_SEED=42

# Pure cache (§4.3).
POOL_FOLD_KEY_CACHE=/var/lib/prova/fold_pk.bin

# The "how long until my money is spendable" delay users feel.
POOL_FOLD_INTERVAL_SECONDS=8

# Email for sign-in codes. Gmail needs an APP PASSWORD (Security → 2-Step Verification → App
# passwords), not the account password. Leave SMTP_HOST empty to keep using DEV_OTP.
# See Docs/signup-and-validation.md §6.
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=you@gmail.com
SMTP_PASSWORD=<16-char app password>
SMTP_FROM=you@gmail.com
SMTP_FROM_NAME=Prova

# Believe X-Forwarded-For when rate-limiting by IP. FALSE by default: trusting it unconditionally
# makes every per-IP limit bypassable with one header. Set true ONLY behind a proxy you control.
TRUST_PROXY_HEADERS=false
```

> **`prova-admin`'s secret appears nowhere in this file.** If you ever feel the urge to add it, the
> thing you are trying to do belongs in a terminal instead (§6).

### `mobile/.env`

```bash
EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:8080   # Android emulator → host
EXPO_PUBLIC_AUTH_MODE=development
EXPO_PUBLIC_DEV_EMAIL=you@example.com
EXPO_PUBLIC_DEV_OTP=000000
EXPO_PUBLIC_DEPOSIT_MODE=simulated
```

Everything here is inlined into the app bundle at build time. **Never put a secret in an
`EXPO_PUBLIC_*` variable** — assume anyone with the APK can read it.

### On your machine only

| What | Where |
|---|---|
| `prova-admin` secret | `~/.config/stellar/identity/prova-admin.toml` |
| `prova-test` secret | same directory |

Back these up somewhere offline. Losing the admin key means losing the ability to fix the contract —
funds stay safe, but a future bug becomes unfixable.

---

## 6. Admin operations (break-glass)

Rare, run by hand, never from a web service. **There is deliberately no admin dashboard**: a web
panel would put the most destructive capability in the system behind a password on the internet,
turning a cold key into a hot one.

```bash
export POOL=C...          # POOL_CONTRACT_ID
export ADMIN=prova-admin

# Halt deposits and transfers. WITHDRAWALS ARE NEVER PAUSED.
stellar contract invoke --id $POOL --source $ADMIN --network testnet -- \
  set_paused --paused true

# Rotate the KYC signing key after a compromise.
# Takes effect immediately and invalidates every outstanding credential, honest ones included —
# which is exactly what you want if the key has leaked. For a planned rotation, re-issue first.
stellar contract invoke --id $POOL --source $ADMIN --network testnet -- \
  set_anchor --anchor_pk_x <x> --anchor_pk_y <y>

# Ship a fix.
stellar contract install --wasm target/wasm32v1-none/release/prova_pool.wasm --network testnet
stellar contract invoke --id $POOL --source $ADMIN --network testnet -- \
  upgrade --new_wasm_hash <hash from install>

# Hand the role to a multisig before mainnet.
stellar contract invoke --id $POOL --source $ADMIN --network testnet -- \
  set_admin --new_admin G...
```

Every one of these emits an on-chain event. Admin action is not trustless, but it is never silent.

---

## 7. Run it

```bash
# One indexer and one folder — exactly one. Leaf indices are assigned in queue order, and two
# writers racing on the same range would corrupt it.
cd backend && RUN_MODE=all go run ./cmd/api

# The app needs a native build: the prover is a Rust module, absent from Expo Go.
cd mobile && npx expo run:android
```

### Confirm it works

```bash
curl -s localhost:8080/healthz
curl -s localhost:8080/pool/status
# → {"treeSize":0,"queueDepth":0,"batch":8}
```

**`queueDepth` is the number to watch.** If it climbs and stays up, the folder has stalled: deposits
and transfers keep working and no money is at risk, but nothing new becomes spendable.

---

## 8. Before mainnet

Testnet-only shortcuts that must not survive the move:

| Item | Why it cannot ship |
|---|---|
| **Seeded trusted setup** | `POOL_SETUP_SEED=42` makes the toxic waste public — anyone can forge proofs. Mainnet needs a real multi-party ceremony |
| **Single admin key** | Move to 2-of-3 multisig via `set_admin` |
| **`AUTH_MODE=development` with SMTP unset** | The fixed `DEV_OTP` is accepted. Set SMTP, or production refuses sign-in |
| **Gmail as the mail sender** | Caps at ~500/day and sends from a personal address. Move to a transactional provider before launch |
| **No Redis in production** | Rate limits fall back to per-instance counters — weaker across replicas (`Docs/signup-and-validation.md` §5) |
| **Unaudited** | The pool holds custodied funds. `Docs/shielded-pool.md` lists the audit scope, including the in-circuit encryption, which is assembled here rather than called from a library |
| **On-device proving unmeasured** | Run `pool-benchmark` on a low-end handset — it decides the shape of the send screen |

---

## 9. If something goes wrong

| Symptom | Likely cause |
|---|---|
| Every fold rejected | `POOL_SETUP_SEED` does not match the seed the contract's verifying keys were built with |
| Every spend rejected | KYC credential bound to the old v2 identity — re-verify (`Docs/shielded-pool.md` §10.8) |
| `queueDepth` climbing | Folder stopped, or its relayer key is unfunded |
| Notes never become spendable | Same as above — check the folder's logs first |
| `/pool/*` returns 503 | `POOL_CONTRACT_ID` is unset, or Postgres is unreachable |
| `initialize` fails | Already initialised. It is one-shot; redeploy if the admin address was wrong |
| Folds slow (~3 s) | `POOL_FOLD_KEY_CACHE` unset or unwritable — the key is being regenerated every time |
