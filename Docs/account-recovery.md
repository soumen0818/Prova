# Prova — Account Backup & Recovery

> Companion to [proposal.md](proposal.md) (§4.2, the privacy boundary) and
> [tech-stack.md](tech-stack.md). This is the authoritative spec for how a Prova account is created,
> secured on the device, backed up, and recovered on a new device. **Read this before touching any
> wallet / key / auth code.**

---

## 0. Decisions (frozen)

These were agreed with the product owner and are the ground rules for the whole feature:

1. **Self-built, free.** No paid key-management provider (Web3Auth etc.) for now. Cost = $0. We may
   migrate to a managed KMS after funding — the design is kept swappable.
2. **One master seed.** A single 32-byte master secret is generated on-device; **both** the ZK
   secret and the Stellar key are *derived* from it. We only ever back up the master.
3. **Backup = encrypted box in the cloud + PIN.** The master is encrypted with a key derived from
   the user's PIN, and only the **ciphertext** is stored (cloud + local). The cloud (Google/Apple)
   never sees anything it can open.
4. **Biometric = local convenience.** Fingerprint/Face unlocks a local copy for day-to-day use and
   authorizes payments; the PIN is the fallback and the cloud-decryption key.
5. **Social recovery is deferred.** There is exactly one accepted, unrecoverable case (§6). Social /
   identity recovery will be added later to close it.

Non-goals for this phase: guardians/social recovery, proof aggregation, multi-device sync.

---

## 1. The two keys, from one seed

Prova has two secrets that do completely different jobs (proposal §4.2):

| Key | Job | Never leaves device as… |
|---|---|---|
| **ZK secret** | Privacy/proving — seeds `commitment`, `nullifier`, KYC `user_id` | plaintext |
| **Stellar key** | The money account (`G…` receive address the anchor credits) | plaintext |

Both are derived deterministically from a single **master seed** so there is only one thing to back
up:

```
master        = 32 secure-random bytes           (expo-crypto CSPRNG)
zkSecret      = HKDF-SHA256(master, "prova/zk/v1")      → reduced into the BLS12-381 scalar field
stellarSeed   = HKDF-SHA256(master, "prova/stellar/v1") → 32-byte ed25519 seed → Stellar keypair
```

- `zkSecret` keeps the **existing hex format** the prover already consumes, so the circuit / FFI
  interface does not change — only its *source* changes (derived, not raw-random).
- `stellarSeed` → `Keypair` (ed25519) → public `G…` address + secret `S…`.
- This is the standard hierarchical-derivation pattern (one seed → many keys), same idea as a wallet
  seed phrase, but the phrase is never shown.

---

## 2. The vault (what gets backed up)

The **vault** is the small bundle we protect and back up:

```jsonc
{
  "v": 1,
  "master": "<32-byte hex>",        // the only true secret
  "kycCredential": { ... } | null,  // convenience; the anchor can also re-issue it
  "createdAt": 1700000000
}
```

Everything else (ZK secret, Stellar key, addresses) is re-derived from `master`, so it is **not**
stored in the vault.

### Encryption (the "box")

```
salt        = 16 random bytes
vaultKey    = Argon2id(pin, salt, {mem, time, parallelism})   // memory-hard KDF
nonce       = 12 random bytes
ciphertext  = AES-256-GCM(vaultKey, nonce, encode(vault))
box         = { v, salt, nonce, kdf: {…params}, ciphertext }  // opaque; safe to store anywhere
```

- **Argon2id** (memory-hard) makes brute-forcing a 6-digit PIN from the box expensive. Parameters
  are stored in the box so future re-encryption can raise them.
- **AES-256-GCM** gives authenticated encryption (tamper-evident).
- The `box` contains **no plaintext secret** — only ciphertext + public params.

---

## 3. Where things are stored

| Item | Location | Who can read it |
|---|---|---|
| `master` (plaintext) | Secure enclave (`expo-secure-store`, biometric-gated) | Only this device, after biometric |
| Encrypted `box` | Secure enclave (local copy) **+** cloud (Google Drive appData / iCloud) | Nobody without the PIN |
| PIN | **Never stored** (only its Argon2 output is used transiently) | Only the user's memory |
| Stellar `G…` address | Derivable/public | Public — it's a receive address |

**Golden rule holds:** only ciphertext ever leaves the phone; the master's plaintext never does.

---

## 4. App lock & payment authorization

Matches how consumer payment apps work (UPI apps, Venmo, Revolut): one PIN + biometric convenience.

- **Onboarding:** set a **6-digit PIN** → derive `vaultKey` → build + store the `box` (local +
  cloud). Store `master` in the enclave gated by biometric (`requireAuthentication`).
- **Open the app:** biometric unlocks the enclave `master`. Biometric unavailable/failed → enter PIN
  → derive `vaultKey` → decrypt local `box`.
- **Authorize a payment (send):** biometric (or PIN) step-up before proving/relaying a transfer.
- **Change PIN:** when the user is authenticated, re-encrypt the `box` under the new PIN and
  re-upload.

---

## 5. Factors & recovery matrix

Three things can gate access; you need the right combination:

- **Phone** — the device (holds the enclave `master` + a local `box`).
- **Cloud** — Google/Apple account (holds the `box`).
- **PIN** — opens any `box`.

| Situation | What you have | Recoverable? |
|---|---|---|
| Normal use | Phone + biometric | ✅ instant |
| Forgot PIN, still have phone | Phone (biometric unlocks master) | ✅ → set a new PIN |
| Lost phone, remember PIN | Cloud `box` + PIN | ✅ on new phone |
| **Lost phone + forgot PIN** | Only the cloud `box`, cannot open it | ❌ **accepted gap (§6)** |

---

## 6. The one accepted gap

> **Lost phone AND forgot PIN at the same time → the account cannot be recovered.**

Why: losing the phone removes the only thing that could open the box *without* the PIN; forgetting
the PIN removes the only key to the box. Cloud login returns the box but nothing can open it.

This is the deliberate cost of deferring social recovery. **Future work (§9)** closes it with
*identity recovery* (re-verify via phone OTP + KYC to release a recovery factor) — the natural fit
for a KYC'd remittance product. Until then, onboarding must clearly tell users: **remember your PIN;
it cannot be reset once the phone is gone.**

---

## 7. Recovery flow (new phone), step by step

1. Install Prova on the new phone; sign in to the OS Google/Apple account (normal phone setup).
2. Sign in to Prova with **phone number + OTP**.
3. App **downloads the `box`** from Google Drive / iCloud.
4. User enters the **PIN** → Argon2id → `vaultKey` → decrypt `box` → recover `master`.
5. Re-derive ZK secret + Stellar key. **Everything is back:** same `G…` address, KYC, history.
6. Store `master` in the new enclave (biometric-gated); re-enable biometric; keep the local `box`.

Target: under 60 seconds, no seed phrase shown.

---

## 8. Account Details screen

A single screen (from Profile) with everything account-related:

- **Receive address** — the Stellar `G…` with copy + QR.
- **Backup status** — Cloud backup ✅/❌ + last-synced time; PIN set ✅; Biometric ✅.
- **KYC status** — verified / level / expiry.
- **Recovery** — "Social recovery: coming soon" (placeholder for §9).
- **Security** — change PIN, re-run cloud backup, sign out (with a clear "you need your PIN to
  restore" warning).

---

## 9. Future — closing the gap (not this phase)

When funded / prioritized, add a recovery factor so "lost phone + forgot PIN" is survivable:

- **Identity recovery (recommended):** the backend releases a recovery share **only** after strong
  identity re-verification (phone OTP + re-KYC through the anchor). Bank-like, fits regulation. Trade-
  off: the backend becomes a recovery participant (must never hold enough to open a box alone).
- **Social recovery (guardians):** Shamir-split a recovery share across 2 trusted contacts.
- **Recovery code:** a one-time offline code (rejected for now — it's a seed phrase by another name).

Any of these upgrades the model from "cloud + PIN" to a true 2-of-N; design storage so a third
factor can be added without re-onboarding users.

---

## 10. Libraries & crypto choices

Pure-JS, audited, Expo-friendly (no fragile native crypto):

- **[`@noble/hashes`](https://github.com/paulmillr/noble-hashes)** — HKDF-SHA256, Argon2id.
- **[`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers)** — AES-256-GCM.
- **[`@noble/curves`](https://github.com/paulmillr/noble-curves)** or **`@stellar/stellar-base`** —
  ed25519 + Stellar `strkey` address encoding.
- **`expo-crypto`** — CSPRNG (`getRandomBytes`).
- **`expo-secure-store`** — enclave (`requireAuthentication` for biometric gating).
- **`expo-local-authentication`** — biometric prompts (already used).
- **Cloud backup** — `react-native-cloud-storage` (Google Drive appData + iCloud) or a thin native
  module. Requires a dev build (we already ship one). Stores only the ciphertext `box`.

---

## 11. Build plan (phased)

| Phase | Ships | Notes |
|---|---|---|
| **A1** ✅ | Single master seed + derive ZK + Stellar; store in enclave; **Account Details** screen showing the `G…` address | **Done.** See status note below |
| **A2** ✅ | 6-digit PIN setup + biometric app-lock + payment step-up | **Done.** See status note below |
| **A3** ✅ | Build + encrypt the `box`; store locally | **Done.** Argon2id + AES-GCM; see status note below |
| **B** ✅ | Cloud backup (Drive/iCloud) + new-device recovery flow | **Done.** See status note + setup below |
| **C**  | (future) identity/social recovery — closes §6 gap | Post-funding |

### A1 — status (done)

Shipped:
- `mobile/src/lib/keys.ts` — `master` → `zkSecret` (HKDF-SHA256, existing hex format) + Stellar keypair.
- `mobile/src/lib/stellar-strkey.ts` — `G…`/`S…` encoding, **verified byte-for-byte against
  `@stellar/stellar-base` (5/5 vectors)**.
- `mobile/src/lib/wallet.ts` — `ensureAccount()` generates/reads the master and derives+persists
  everything; `getOrCreateSecret()` keeps its signature so proving/KYC are unchanged.
- `mobile/src/lib/secure-store.ts` — `masterSeed` + `stellarPublic` enclave slots.
- `mobile/src/app/account.tsx` — Account Details screen (address + QR + copy, backup/KYC status),
  linked from Profile.

Verified: strkey vectors pass; derivation deterministic; `tsc` + lint clean. Pure-JS crypto
(`@noble/*`, `@scure/base`) — no native crypto. **Needs an on-device rebuild** (`npx expo
run:android`) because `expo-clipboard` is a native module; the address only renders on device (no
SecureStore on web).

### A2 — status (done)

Shipped:
- `mobile/src/lib/pin.ts` — 6-digit PIN as a **salted native SHA-256 verifier** (expo-crypto; never
  the raw PIN) with **rate-limiting**: after 5 wrong tries, escalating lockout (30s → 1m → 5m → 15m
  → 1h). Constant-time compare. A fast hash is correct here: the verifier only *gates the UI* (the
  master seed is protected by the hardware keystore, not the PIN), and its real defenses are the
  enclave + rate-limit — the memory-hard Argon2id lives on the *cloud* vault (§B). Pure-JS KDFs are
  also far too slow on Hermes for an every-unlock path (an early PBKDF2 verifier took ~5 s on-device;
  the native hash is instant). Legacy PBKDF2 (v1) records are still accepted until the PIN is changed.
- `mobile/src/components/pin-pad.tsx` — reusable dots + keypad.
- `mobile/src/app/set-pin.tsx` — enter→confirm setup, used by onboarding (mandatory) and Settings
  (change). Onboarding is now `profile-setup → set-pin → app`.
- `mobile/src/components/app-lock.tsx` — locks on a wallet + any factor; unlock via biometric
  (auto-prompted) **or** PIN, with live lockout countdown.
- `mobile/src/components/pin-prompt.tsx` + `send.tsx` — **payment step-up**: biometric, or PIN
  fallback, required before proving/relaying a transfer.
- `settings.tsx` (Set up / Change PIN) and `account.tsx` (live PIN + biometric status).

Verified: PIN round-trip / wrong-PIN / lockout state machine checked; `tsc` + lint clean (incl. the
React-Compiler rules). Same rebuild caveat as A1 (native modules; on-device only).

### A3 — status (done)

Shipped:
- `mobile/src/lib/vault.ts` — `sealVault(pin)` / `openVault(pin)` / `hasVault` / `clearVault`. The
  vault (`master` + KYC credential) is encrypted with **Argon2id → AES-256-GCM**. Only the
  ciphertext `box` is stored (locally now; Phase B uploads the same box). Wrong PIN or tampering →
  GCM auth fails → returns `null`.
- **Argon2id params: 9 MiB, t=4, p=1** (OWASP config; low peak memory for low-end Android). Params
  are stored in the box so they can be raised later.
- Wired: the Argon2id seal is **deferred off the onboarding path** for speed (the local box has no
  benefit before cloud). The vault is created when **cloud backup is enabled (Phase B)**; a PIN
  change **re-seals only if a vault already exists** (keeps an existing backup in sync);
  `resetWallet` clears the box.
- Libraries added: `@noble/ciphers` (AES-256-GCM), `@noble/hashes/argon2`. Pure-JS; decode via
  `@noble/ciphers` `bytesToUtf8` (no reliance on Hermes `TextDecoder`).

Verified in Node against the real libs: **seal→open roundtrip, wrong-PIN → null, tampered
ciphertext → null**; AES-GCM roundtrip + tamper-reject; Argon2id timing benchmarked. `tsc` + lint
clean.

**KYC-credential caveat:** the box captures whatever credential exists at seal time. If KYC is
completed *after* the PIN is set, the credential enters the box on the next PIN change (a re-seal);
either way it is **re-issuable by the anchor after restore**, so recovery of funds never depends on
it (only the `master` is essential, and that is always sealed).

### B — status (done)

Shipped:
- **Vault v2 — envelope encryption (DEK/KEK).** A random 32-byte **DEK** seals the vault JSON with
  AES-256-GCM; the PIN-derived Argon2id **KEK** only *wraps* the DEK. Re-sealing after data changes
  is therefore pure AES (~1 ms, verified) and runs silently in the background; the slow Argon2id
  runs only at backup-enable / restore / PIN-change, so the **KEK uses heavier params (19 MiB,
  t=4)** for stronger offline brute-force resistance on the cloud copy.
- **Vault contents** now rebuild the whole account: `master`, profile (phone+name), KYC credential,
  balance snapshot, recipients (`mobile/src/lib/vault.ts`).
- **`mobile/src/lib/cloud-backup.ts`** — iOS → iCloud (CloudKit, no sign-in); Android → Google
  Drive hidden `appDataFolder` via one-tap Google sign-in (`drive.appdata` scope only). Only the
  ciphertext box is uploaded (~1 KB). Typed `BackupError` codes; Google Sign-In loaded lazily so
  pre-Phase-B builds degrade to "rebuild required" instead of crashing.
- **Backup screen** (`/backup`) — turn on (PIN prompt → seal → upload), status hero (account, last
  synced), back-up-now, turn off (deletes the cloud copy, destructive-confirmed).
- **Restore screen** (`/restore`, from Welcome's "Already used Prova?") — cloud sign-in → download
  box → PIN (throttled: 5 tries → 30 s pause; each try costs an Argon2id anyway) → full rebuild:
  master → re-derived keys, session, KYC credential, balance, recipients; local PIN verifier
  re-armed; the restored box adopted as the local vault; backup stays enabled.
- **Auto-sync** (silent, best-effort, never breaks the calling flow): after send, deposit, KYC
  completion, recipient add; PIN change re-seals under the new PIN and pushes the new box (old-PIN
  boxes become stale ciphertext).
- Libraries: `react-native-cloud-storage` (config plugin handles the iCloud entitlement),
  `@react-native-google-signin/google-signin` (free "Original" API). Both are native → **rebuild
  required** (`npx expo run:android`).

Verified: envelope lifecycle in Node against the real libs — seal → fast reseal (1 ms) → open with
right PIN (data + DEK recovered), wrong PIN → null, tampering on either layer (data ct / wrapped
key) → null, JSON wire roundtrip intact. `tsc` + lint clean.

### B — Google Drive setup (one-time, Android)

Backup on Android needs a Google OAuth client (free). Until this is done, the app shows "Google
backup is not configured for this build":

1. In [Google Cloud console](https://console.cloud.google.com/) create/select a project → enable
   the **Google Drive API**.
2. **OAuth consent screen:** External → add your Google account as a test user → add the scope
   `https://www.googleapis.com/auth/drive.appdata`.
3. **Credentials → Create credentials → OAuth client ID:**
   - **Android** client: package `com.prova.app`, SHA-1 of the debug keystore
     (`keytool -list -v -keystore %USERPROFILE%\.android\debug.keystore -alias androiddebugkey -storepass android`).
   - **Web application** client (no redirect URIs needed) — its ID is what the app uses.
4. Put the **web** client ID in `mobile/.env`:
   `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=…apps.googleusercontent.com`, then rebuild
   (`npx expo run:android`).

iOS needs no OAuth setup — iCloud works via the entitlement the config plugin adds (requires an
Apple developer account when building for a real device).

### Full-system audit (after Phase B)

Every recovery-relevant flow was traced end-to-end; two findings surfaced and were **fixed**:

1. **PIN change didn't require the current PIN** — an unlocked phone in the wrong hands could
   silently re-key the account *and* the cloud backup (re-sealed under the attacker's PIN). Fixed:
   change-PIN now demands the current PIN (rate-limited) or biometrics (which also keeps the
   spec's §5 "forgot PIN, have phone" reset path working).
2. **Backup enable with no PIN set** (legacy/edge accounts) showed an unpassable PIN prompt.
   Fixed: the backup screen routes to PIN setup first.

Verified clean in the same pass: onboarding creates master → derives keys → mandatory PIN;
enable-backup seals only under a *verified* PIN; auto-sync is silent/best-effort and cannot break
payment flows; PIN change re-seals + re-uploads (old-PIN boxes become stale ciphertext); restore
rebuilds master/keys/session/KYC/balance/recipients, re-arms the PIN verifier, and keeps backup
on; sign-out keeps the wallet (same device, same wallet by design); wallet reset wipes every local
key/box/meta but leaves the cloud copy so the account stays restorable; a failed upload never
records a successful sync; no plaintext secret ever leaves the enclave in any flow.

Known limits (accepted): Argon2id runs on the JS thread (~2–4 s, one-time operations, busy UI
shown — a native KDF is a future optimization); the §6 lost-phone+forgot-PIN gap stands until
social/identity recovery; on-device restore of the balance is a snapshot (testnet-only concept —
mainnet uses chain/anchor state).

### Migration note
Existing dev wallets hold a raw-random ZK secret (not master-derived). Testnet has no real users, so
we adopt the master model going forward; a dev wallet without a `master` is treated as "reset &
re-create." No production migration needed yet.

---

## 12. Security / non-custodial guarantees

- The master's **plaintext never leaves the device**; only the PIN-encrypted `box` does.
- **No server and no cloud can open a box** — the PIN (never stored) is required. Prova stays
  non-custodial through Phase B.
- When identity recovery (§9) is added, the backend must provably hold **less than** a full opener,
  or the product silently becomes custodial — an explicit design constraint for that phase.
