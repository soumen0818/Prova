# Prova — handoff: finishing the shielded-pool wiring on Linux

> Written for whoever picks this up on the Linux machine. Everything non-Rust was built and verified
> on a Windows box; the Rust prover cannot compile there (§9 of [shielded-pool.md](shielded-pool.md)),
> so the remaining work has to happen where the Android build can actually run.
>
> Read [shielded-pool.md](shielded-pool.md) and [deposit-flow.md](deposit-flow.md) first. This file
> is the delta on top of them.

---

## 1. The goal

Make the app **actually move value**, end to end, on testnet.

Today the Send button produces a ZK proof and records two hashes on-chain — it moves no money. The
shielded pool (contract + circuits + wallet library) is fully built and deployed, but was never
wired into the UI. Closing that gap is the whole job.

Target state for the MVP demo:

```
1. Anchor deposit (SEP-24)  →  SRT lands in the user's own Stellar account   [public]
2. Shield                   →  SRT moves into the pool contract              [private from here]
3. Private send             →  note-to-note transfer inside the pool         [amount hidden]
4. Payout (SEP-31)          →  cash out to a receiving anchor                [simulated last mile]
```

Steps 1 and 2 are done. Steps 3 and 4 are not.

---

## 2. What is already working

### Verified against live testnet

The pool contract is **deployed and live**: `CCIKEXCOFG4PLRQEG4OD3QG76LGEWO6RZFX6WGBPRWEZZQ2SJ5UMJ2G5`
(see [DEPLOYMENTS.md](../contracts/DEPLOYMENTS.md)). Its on-chain interface was fetched and matches
the source.

`backend/internal/chain/shield_live_test.go` submits a deliberately invalid proof to the **real**
contract and asserts it is rejected inside `bls12_381_multi_pairing_check` — which proves every
argument decoded correctly (contract id, function name, argument order, symbol-keyed struct maps in
required key order, byte widths, i128 amount, source-account auth, simulated footprint).

```bash
cd backend && PROVA_LIVE_TESTNET=1 go test ./internal/chain/ -run TestShield -v
```

A funded dev identity exists: `prova-dev` = `GBNYUIOGDP2OM27CPUUWDTUURKSOIEIIJCMOKLNAQQRSSSAG47EBUELR`
(10,000 XLM, SRT trustline established). It was generated on the Windows box, so **it does not exist
on Linux** — regenerate one there:

```bash
stellar keys generate prova-dev --network testnet --fund
```

SEP-10 authentication against `testanchor.stellar.org` was exercised by hand and works.

### Built this cycle

| Area | Files | What |
|---|---|---|
| Denomination | `shared/src/money.ts`, `shared/go/schema/money.go` | Amounts carry a unit; killed the build-time `EXPO_PUBLIC_CURRENCY=AED` that showed dirhams to every user worldwide |
| Shield — chain | `backend/internal/chain/soroban.go`, `shield.go` | Soroban RPC (simulate/send/poll) + `shield` assembly and submission |
| Shield — API | `backend/internal/server/shield_handlers.go`, `shared/{src/shield.ts,go/schema/shield.go}` | `POST /pool/shield/prepare` + `/pool/shield/submit` |
| Shield — app | `mobile/src/lib/{api,onchain,pool}.ts` | `prepareShieldTx`, `submitShieldTx`, `shieldIntoPool`, `shieldToPool` |
| Balance | `mobile/src/hooks/use-money.ts` | One source of truth; picks pool vs local counter by `depositMode` |
| Scanning | `mobile/src/hooks/use-pool.ts` → `usePoolSync` | Scans on start, on a timer, and on app foreground |
| Screens | `home.tsx`, `profile.tsx`, `deposit.tsx`, `_layout.tsx` | Pool balance, confirming shown separately, two-step deposit, prover warm-up |

All of it passes: `go build/vet/test`, mobile `tsc` + `expo lint`, shared tests, prettier, gofmt.

**None of it has run on a device.** That is the point of this handoff.

---

## 3. What still has to be built

### 3.1 Receive address + recipient pool addresses

`poolAddress()` exists in `mobile/src/lib/pool.ts` and **no screen uses it**. Without it one user
cannot pay another, because `sendPrivately()` needs a `Payee { ownerPk, encPkX, encPkY }` and a
`Recipient` today is only a name, a masked handle and a country.

Needed:

- a Receive screen showing the pool address with QR + copy (`app/account.tsx` shows the *Stellar*
  address — this is a different thing, do not conflate them)
- optional pool-address fields on `Recipient` (`mobile/src/lib/recipients.ts`), plus paste/scan entry
  in `app/recipient-new.tsx`
- the vault snapshot in `lib/vault.ts` carries recipients, so any new field must be optional or
  restore from older backups breaks

### 3.2 Send via the pool

Rewire `mobile/src/app/send.tsx` from `prove()` + `submitTransfer()` (the old verifier path, which
moves nothing) to `sendPrivately()` from `lib/pool.ts`.

Watch for:

- **`InsufficientFunds` carries `largestNote`.** The spend circuit is 1-in-2-out, so a payment needs
  a *single* note that covers it. "Not enough balance" is the wrong message when the total is
  sufficient but fragmented — surface the real reason.
- **A note that is not folded cannot be spent.** `spend()` throws "still confirming" for this. The UI
  must already be showing pending separately (it does), so this should be rare rather than confusing.
- **Drop the local `debit()` call.** In pool mode the balance comes from the chain; debiting a local
  counter as well would double-count.

### 3.3 The send screen's shape — needs a measurement first

`Docs/shielded-pool.md` §10.8 is explicit that on-device spend-proof time decides this, and it is
**still unmeasured on real hardware**:

| Estimated spend proof | Send screen must be |
|---|---|
| under ~5 s | a simple spinner |
| 5–20 s | staged progress + reassurance copy |
| over ~20 s | a background job that notifies on completion — a different flow |

Phase 4's stated target is **≤ 8 s perceived** on a mid-range Android.

Run `mobile/src/app/pool-benchmark.tsx` on the cheapest available handset and record:
warm-up, shield proof (first), shield proof (warm), estimated spend, plus phone model and Android
version. Desktop figures for comparison: warm-up 1,027 ms, shield 226 ms, estimated spend ~840 ms.

**Agreed approach if the number is unknown or middling:** build escalating feedback —
spinner → staged progress → background message — so the UI adapts to whatever the device does.
That covers rows 1 and 2 completely. Row 3 additionally needs the proof to survive backgrounding
plus a notification, which is architecture, not copy. Structure the proving step to be cancel-safe
and resumable so that stays an addition rather than a rewrite.

### 3.4 SEP-31 payout leg

**`testanchor.stellar.org` already implements SEP-31** — its `stellar.toml` declares
`DIRECT_PAYMENT_SERVER`, `ANCHOR_QUOTE_SERVER` (SEP-38), `KYC_SERVER` (SEP-12) and `TRANSFER_SERVER`
(SEP-6). So build a **real sending client against SDF's reference implementation** rather than a mock.

Flow: `GET /info` → SEP-12 customer exchange → SEP-38 quote → `POST /transactions` → Stellar payment
with the returned memo → poll status. Only the final bank credit is simulated; label it as such.

Follow the existing house pattern for the simulated part — `KYCMockDelay` in
`backend/internal/config/config.go` is the precedent (a "Stage A mock provider" with configurable
latency behind the real interface). Name the switch `PAYOUT_MODE=simulated|anchor` to match
`DEPOSIT_MODE`.

`schema.TransferStatus` already has a `paid_out` value reserved for this.

### 3.5 Recipient payout fields, and labels

For an Indian payout SEP-12 will demand: beneficiary legal name, account number + IFSC (or UPI ID),
address/country of residence, and **purpose of remittance** (RBI requires it). Today `Recipient` has
a free-text masked handle.

Then: label the demo honestly — "settled with demo anchor — simulated payout", a settings row naming
the anchor in use, and a README line saying production needs a licensed anchor partnership.

---

## 4. Environment setup on Linux

Already present per the last report: `rustc 1.96.0`, `cargo 1.96.0`, `stellar 27.0.0`,
`cargo-ndk 4.1.2`, and the `aarch64-linux-android` / `x86_64-linux-android` Rust targets.

Missing — this is the gating dependency for everything:

```bash
sdkmanager "ndk;27.1.12297006" "platform-tools" "platforms;android-35"
export ANDROID_HOME=$HOME/Android/Sdk
export ANDROID_NDK_HOME=$ANDROID_HOME/ndk/27.1.12297006
```

`platform-tools` provides `adb`. Then:

```bash
cd circuits/prover && ./build-android.sh
cd ../../mobile && cp .env.example .env && npx expo run:android
```

`.env` files are gitignored, so `mobile/.env` and `backend/.env` do not travel with the repo.
`backend/.env` holds real secrets (`ANCHOR_SEED`, SMTP) — it is not needed for the benchmark, but is
needed to run the backend. `POOL_CONTRACT_ID` must be set or the shield routes return 503 by design.

Any Android phone over USB works (Developer Options → USB debugging). A flagship gives optimistic
proving times; a cheap handset gives the honest worst case.

---

## 5. Rules that must not be broken

These are load-bearing. Each one exists because breaking it causes a specific, real failure.

1. **Never report an unconfirmed transaction as failed.** `pending` is a real state end to end
   (contract → Go → schema → app). Saying "failed" when money may still land is how someone pays
   twice.
2. **Never add spendable and pending together.** A note cannot move until it is folded into the
   Merkle tree. Summing them offers a tap on money that cannot go anywhere, and the refusal then
   comes from the contract instead of the UI.
3. **The user's secret never reaches the backend.** Shield is "server prepares, phone signs, server
   submits" — it works because the invoker is the transaction source account, so source-account auth
   covers `require_auth()` and the phone only ever signs a 32-byte hash.
4. **Nothing is blind-signed.** Every signature goes through `reviewAndSign` with a plain-language
   summary.
5. **The KYC credential binds to `poolUserId()`**, not the older v2 transfer secret. A mismatch
   produces a proof the contract rejects with no explanation. `spend()` checks this before proving —
   keep that check.
6. **Stroops conversion lives in exactly one place** (`STROOPS_PER_UNIT` in `lib/onchain.ts`).
   Stellar assets have 7 decimals; the app counts whole units.
7. **Don't derive display currency from the user's country.** An American in Dubai is paid in AED.
   Country decides which rails are available; the rail decides the currency. The country picker in
   the KYC screen is a *phone dial code* selector and must not be written to `countryOfResidence`.

---

## 6. Known constraints

- **The prover cannot run on Windows or in CI here.** Native Rust for Android; anything touching
  real proofs must be exercised on a device.
- **Test SRT needs SEP-12 KYC** on `testanchor.stellar.org`. A SEP-6 deposit request succeeds but
  sits at `status: "incomplete"` until customer info is supplied. Max 10 SRT per deposit.
- **Existing testnet users must re-verify KYC** — credentials are now bound to the pool spending key
  (§10.8).
- **Changing `ANCHOR_ASSET` needs a wallet reset in simulated mode.** The local counter does not
  reset, so an old balance would be relabelled with the new asset. The `/healthz` `anchorAsset`
  field plus `useAssetMismatch()` warn about the label, but cannot fix the number. This stops
  mattering once the balance comes from the pool.

---

## 7. How to verify your work

```bash
cd shared  && npm run build && npm test
cd backend && go build ./... && go vet ./... && go test ./...
cd backend && PROVA_LIVE_TESTNET=1 go test ./internal/chain/ -run TestShield   # needs network
cd mobile  && npx tsc --noEmit && npx expo lint
```

Then on the device, in order: deposit via anchor → shield → check the balance shows confirming then
spendable → send to a second wallet → confirm the note is found by the recipient's scan.
