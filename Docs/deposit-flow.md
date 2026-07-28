# Prova — Deposit / "Add money" flow

> How money is added to a Prova wallet. Companion to [proposal.md](proposal.md) (§3 step 3) and
> [environments.md](environments.md). Read before touching deposit or on-chain-wallet code.

---

## Two modes — `DEPOSIT_MODE` (backend) / `EXPO_PUBLIC_DEPOSIT_MODE` (app)

Adding money is decoupled from how login works (previously both keyed off `AUTH_MODE`, so you
couldn't have easy dev login *and* the real deposit flow). Keep the two values in sync.

| Mode | What happens | Use for |
|---|---|---|
| `simulated` | The app credits a **local** testnet balance instantly (a counter in the enclave). No chain. | Fast dev loop, UI work |
| `anchor` | **Real testnet rails**: activate the account → add a trustline → deposit via the anchor → balance read from Horizon. | Testing the real flow |

`anchor` mode is still **testnet** — the asset (default `SRT`) has **no real value**. This is a flight
simulator: real controls, no real plane.

---

## The real (`anchor`) flow

Three one-time setup steps, then the deposit itself:

```
1. Activate   Friendbot funds the user's Stellar account so it exists (testnet only).
2. Trustline  The user opts in to the asset before anyone can send it (see signing, below).
3. Deposit    SEP-10 auth → SEP-24 interactive → the anchor sends the asset to the USER's address.
4. Balance    The app reads the real on-chain balance from Horizon — not a local counter.
```

Step 3 targets the **user's** Stellar address (`account` in the SEP-24 request), fixing an earlier
bug where the deposit was pointed at the backend's own key.

---

## Trustline signing — "server prepares, phone signs" (option A)

A trustline is a signed Stellar transaction, and the user's Stellar secret lives **only on the
phone**. So we never send the secret to the server:

```
app  →  POST /wallet/trustline/prepare {address}
backend: builds the ChangeTrust tx, returns { xdr, hash, network }   ← unsigned
app: signs the 32-byte `hash` with its ed25519 key (secret stays on device)
app  →  POST /wallet/trustline/submit {xdr, publicKey, signature}
backend: AddSignatureBase64(...) verifies + attaches, submits to Horizon
```

- **Why signing the hash is safe here:** Stellar signs the 32-byte transaction hash directly with
  ed25519. `AddSignatureBase64` re-derives the hash from the envelope and verifies the signature
  against the public key before submitting, so a mismatched signature is rejected.
- **Verified byte-for-byte:** the app signs with `@noble/curves` ed25519; a Go `keypair.Sign` over
  the same seed + hash produces the **identical** base64 signature (checked against a fixed vector).
  So no Stellar SDK is bundled into the app — just a raw ed25519 signature over the hash.
- **Nothing is blind-signed:** every prepared transaction carries a plain-language `summary` (built
  by the backend from the operations), and the app shows it in a **review dialog the user must
  approve** before the signature is produced (`reviewAndSign` in `lib/onchain.ts`). Declining is a
  cancel, not an error.

## User-authenticated deposit (SEP-10 as the user)

So the anchor deposits into the *user's* wallet, the **user** completes SEP-10 (not the backend):

```
app  →  POST /sep24/deposit/prepare {address}
backend: fetches a SEP-10 challenge for the user, VALIDATES it (ReadChallengeTx: right server key,
         home domain, and account), returns { xdr, hash, network, webAuth, summary }
app: review + sign the challenge hash
app  →  POST /sep24/deposit/complete {address, xdr, network, publicKey, signature}
backend: attaches the user's signature, exchanges it for the anchor JWT (kept server-side), then
         starts the SEP-24 interactive deposit to the user's address → returns { url }
```

The backend validating the challenge before returning its hash is what protects the (blind-signing)
phone from signing a malicious challenge — the same trust model as the trustline.

---

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /wallet/{address}` | On-chain existence + balances (from Horizon) |
| `POST /wallet/fund` | Activate a testnet account (Friendbot) |
| `POST /wallet/trustline/prepare` | Build the unsigned trustline tx → `{ xdr, hash, network }` |
| `POST /wallet/trustline/submit` | Attach the phone's signature and broadcast |
| `POST /sep24/deposit` | SEP-24 interactive deposit to the user's address |

Mobile: `lib/onchain.ts` (flow), `lib/keys.ts#signStellarHash` (signing), `lib/api.ts` (client).
Backend: `internal/chain/wallet.go` (Horizon ops), `internal/server/wallet_handlers.go`.

---

## Known gaps (before this is "real money")

- **Independent client-side verification.** The app shows the backend's summary, but does not itself
  decode the XDR — so it trusts the backend's description. For testnet + our own backend this is
  fine; **mainnet** should add on-device XDR decoding so the phone verifies the operation itself
  (this is the one reason to consider a Stellar client lib on-device later).
- **Mainnet** also needs real KYC (see [kyc-verification.md](kyc-verification.md)) and a licensed
  anchor. Everything here targets **testnet** and a test asset with no value.
