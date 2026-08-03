# prova-mobile

Prova's consumer app — React Native + Expo (SDK 56). The wallet, the KYC flow, the send screen, and
the on-device ZK prover live here. Part of the Prova polyrepo (see `../Docs/`).

## Prerequisites

- Node **22 LTS** (managed via nvm: `nvm use 22`)
- A free [Expo account](https://expo.dev) for cloud builds (EAS)
- A **development build**, not Expo Go — the app depends on a custom native module (the Rust ZK
  prover) that Expo Go cannot load. Expo Go can preview pure-UI changes only.

## Getting started

```bash
nvm use 22
npm install
cp .env.example .env   # see .env.example for LOCAL DEV vs PRODUCTION values
npm start              # then press a (Android) with a dev client installed, or w (web) for UI-only work
```

## Scripts

| Script                            | Purpose                      |
| --------------------------------- | ---------------------------- |
| `npm start`                       | Start the Expo dev server    |
| `npm run android` / `ios` / `web` | Start on a specific platform |
| `npm run typecheck`               | `tsc --noEmit`               |
| `npm run lint`                    | `expo lint`                  |
| `npm run format` / `format:check` | Prettier write / verify      |

## Builds (EAS)

Profiles are in `eas.json`:

```bash
eas login
eas init                                    # one-time: link the project
eas build --profile development --platform android
```

- `development` — installable dev client (day-to-day build, replaces Expo Go)
- `preview` — internal APK for testers
- `production` — Play Store app bundle

## Architecture: three keys from one seed

Everything the app does cryptographically traces back to **one master seed** (32 random bytes,
generated once via `expo-crypto`, stored in the platform secure enclave — iOS Keychain / Android
Keystore — and never leaving the device). From that single seed, three independent key sets are
derived by domain-separated HKDF-SHA256 (`src/lib/keys.ts`, `src/lib/wallet.ts`, `src/lib/pool.ts`):

| Derived key                           | Domain label                | Used for                                                                                                                   |
| ------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| ZK secret                             | `prova/zk/v1`               | The legacy per-transfer circuit (v2)                                                                                       |
| Stellar keypair (ed25519)             | `prova/stellar/v1`          | Signing real Stellar transactions (deposits, trustlines)                                                                   |
| Pool owner + encryption keys (Jubjub) | native, via the Rust module | The shielded pool: spending (`owner_sk`) and note-discovery (`enc`) — the current KYC/spend circuits bind to this identity |

Losing the seed means losing the wallet; that's why cloud backup (below) exists. Compromising the
seed means losing everything it derives — that's why it never leaves `expo-secure-store`.

## Project structure

```
src/
  app/                 expo-router routes (file-based). See "Screens" below.
  features/            the four tab screens' actual implementations (home, activity, profile, KYC identity step)
  components/          shared UI: design-system primitives (ui/) + app-level components (see below)
  hooks/               use-pool, use-require-kyc, use-theme, use-color-scheme(.web)
  constants/
    theme.ts            ★ single source of truth for design tokens (colors, type, spacing, radius)
  config/
    env.ts               typed runtime config (EXPO_PUBLIC_* + testnet defaults)
  lib/                 core business logic — see "The lib/ layer" below
modules/prova-prover/  Expo native module bridging to the Rust arkworks prover (Android now, iOS later)
assets/                brand images, fonts, tab icons
```

### Screens (`src/app/`)

| Route                                                         | Screen                                                                                                                                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_layout.tsx`                                                 | Root layout: fonts, `QueryClientProvider`, dark navigation theme, `ToastProvider`, `AppLock` (idle biometric/PIN re-lock), the `Stack` navigator, global connection banner.                   |
| `index.tsx`                                                   | Root gate — loading → `/welcome` (signed out) or the authenticated tab shell.                                                                                                                 |
| `welcome.tsx`                                                 | Signed-out landing: 3-slide value-prop carousel → "Get started" (`/email`) or "Restore your account" (`/restore`).                                                                            |
| `email.tsx` → `otp.tsx` → `profile-setup.tsx` → `set-pin.tsx` | Sign-in: email OTP → verify → create the on-device ZK wallet secret + biometrics → set the 6-digit PIN. Deliberately asks for **no name/phone** here — those come later, during KYC.          |
| `restore.tsx`                                                 | Restore on a new phone: cloud sign-in → fetch the encrypted vault → unlock with PIN (rate-limited: a 30s pause after 5 wrong tries) → rebuild seed, credential, session, balance, recipients. |
| `account.tsx`                                                 | Receive address (QR + copy) and status rows: cloud backup, recovery PIN, biometric lock, social recovery ("coming soon"), KYC status.                                                         |
| `backup.tsx`                                                  | Cloud backup on/off, "back up now", explainer of what's protected.                                                                                                                            |
| `blocked.tsx`                                                 | Policy-block screen (`kyc_required` / `kyc_rejected` / `frozen` / unknown) with tailored copy and actions.                                                                                    |
| `send.tsx`                                                    | The private-transfer flow: recipient → amount → biometric/PIN step-up → on-device proof → submit → result.                                                                                    |
| `deposit.tsx`                                                 | "Add money": instant local credit in `simulated` mode, or the real SEP-24/SEP-10 flow (with signature-review dialogs) in `anchor` mode.                                                       |
| `kyc.tsx`                                                     | Identity (name/phone) → document/selfie capture → submit → poll status → collect the anchor-signed credential.                                                                                |
| `recipients.tsx` / `recipient-new.tsx`                        | Saved beneficiaries: list + add.                                                                                                                                                              |
| `settings.tsx`                                                | Diagnostics (auth mode, network, RPC/Horizon/backend hosts), change PIN, reset wallet, version info.                                                                                          |
| `pool-benchmark.tsx`                                          | On-device proving benchmark: warm-up, key derivation, shield-proof, and note-scan timings, with a UX verdict (spinner vs staged progress vs background job).                                  |
| `+not-found.tsx`                                              | Expo Router's 404 catch-all.                                                                                                                                                                  |

### Tabs (`src/features/`)

`home.tsx` (balance + quick actions + recipients row + recent activity), `activity.tsx` (full
paginated transfer history), `profile.tsx` (identity card, menu, sign out), and
`kyc-identity.tsx` (the name/phone capture sub-step of the KYC flow — phone here is **user-asserted,
not OTP-verified**; the backend has phone-OTP endpoints ready, just not wired into this screen yet).

### The `lib/` layer

The business logic underneath every screen:

**Identity, keys, storage**

- `wallet.ts` — generates and persists the master seed; `resetWallet()` wipes every secure-store key.
- `keys.ts` — HKDF derivation of the ZK secret and Stellar keypair; signs a tx hash directly with
  ed25519 to match the Go SDK byte-for-byte.
- `secure-store.ts` — typed `expo-secure-store` wrapper (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`); throws
  loudly on web rather than silently falling back to something insecure.
- `session.ts` — the signed-in identity record (`email`, `name?`, `phone?`) — distinct from the
  wallet's cryptographic secret.
- `auth-otp.ts` — always calls the real backend; the only client-side fallback is for an
  _unreachable_ backend in dev mode, so the real code path is still exercised in development.
- `pin.ts` — the 6-digit PIN is stored only as a salted-hash **verifier**, never a KDF input — the
  PIN doesn't protect the seed (the enclave does), it gates the UI, so escalating rate-limits (up to
  a 1-hour lockout) are the real defense.
- `vault.ts` — envelope encryption for cloud backup: a random AES-256-GCM DEK encrypts the vault; a
  PIN-derived Argon2id key wraps the DEK. `sealVault()` (slow, full reseal) runs at
  enable/PIN-change; `resealVault()` (fast, cached DEK) runs on every background sync.
- `cloud-backup.ts` — iCloud (CloudKit) on iOS, Google Drive `appDataFolder` on Android; both native
  modules are lazily `require()`'d so a build missing them degrades to "setup required" instead of
  crashing at startup.

**The shielded pool**

- `notes.ts` — the private note store: an AES-256-GCM-encrypted file (not secure-store — that caps
  around 8 notes), keyed by its own enclave-held file key. `leafIndex === null` means "real money,
  not yet foldable" — a distinction the UI must respect. Since the spend circuit is strictly
  1-in-2-out, `selectNoteFor()` can fail on a fragmented balance even when the total is sufficient.
- `pool.ts` — orchestration: `scanForNotes()` (trial-decrypt the on-chain feed to find what's
  yours), `prepareShield()` (deposit), `sendPrivately()` / `cashOut()` (both funnel through one
  `spend()` that picks a note, fetches its Merkle path, checks a fresh KYC credential, and builds the
  proof natively).
- `onchain.ts` — the real testnet flow (`anchor` deposit mode): account activation, trustline,
  SEP-10-authenticated SEP-24 deposit. Every signature goes through an explicit "no blind-signing"
  review dialog before the phone signs.

**The prover bridge**

- `prover.ts` — thin re-export of `modules/prova-prover`'s `prove`/`userId`/`isProverAvailable`.

**Everything else**

- `api.ts` (backend client, typed `ApiError` with server message + code + retry-after),
  `balance.ts` (a separate, simpler local counter the send screen currently reads — a known,
  transitional seam versus the pool's real note-based balance), `kyc.ts` (90-day credential
  lifecycle: expiry, 14-day renewal window, silent renewal), `recipients.ts` (device-local
  beneficiary CRUD), `validation.ts` (thin wrapper over `@prova/shared`'s validators — Unicode-aware
  for Indic scripts), `queries.ts` (React Query setup + typed hooks), `connectivity.ts`
  (network + backend health → one `ConnectionState`, gates money-moving screens),
  `stellar-strkey.ts` (pure-JS SEP-0023 strkey encode/decode), `logger.ts` / `reporting.ts`
  (console logging today, a stable seam for Sentry later — never logs secrets/amounts/PII).

### `components/`

`ui/` holds the design-system primitives (`Button`, `Card`, `Collapsible`, `GlassIconButton`,
`Screen`). App-level components: `app-shell.tsx` (the authenticated tab shell + floating Send FAB),
`app-lock.tsx` (idle re-lock), `connection-banner.tsx` / `connection-gate.tsx` (soft warning vs. hard
block on bad connectivity), `document-capture.tsx` (KYC camera capture), `pin-pad.tsx` /
`pin-prompt.tsx` (PIN entry UI + modal step-up), `payment-result.tsx` (send outcome receipt),
`state-view.tsx` (generic empty/error/success layout), `illustrations.tsx`, `toast.tsx`,
`themed-text.tsx` / `themed-view.tsx`, `error-boundary.tsx`.

## The native prover module (`modules/prova-prover/`)

Bridges the JS app to the Rust arkworks Groth16 prover built in `../circuits/prover`. Android-only
today (`expo-module.config.json` declares `"platforms": ["android"]`); iOS follows the same pattern
later.

```
JS (modules/prova-prover/index.ts, typed API)
  → src/ProvaProverModule.ts   requireOptionalNativeModule('ProvaProver') — resolves to null
                                gracefully if the native module isn't built in (e.g. Expo Go)
  → android/.../ProvaProverModule.kt   7 AsyncFunctions (proving never blocks the JS thread),
                                        loads libprova_prover.so, calls matching `external fun` JNI
  → circuits/prover/src/jni_bridge.rs   → ffi.rs / pool::ffi   (the actual Rust/arkworks prover)
```

Exposed calls: `prove` (legacy transfer circuit), `userId`, `poolKeys` (derive pool keys from the
master seed), `poolShieldProve`, `poolSpendProve` (the heaviest call — one note in, two out, Merkle
membership + value conservation + KYC all proven together), `poolScan` (batch trial-decryption),
`poolWarmUp` (pre-derives proving keys, ~1s, meant to run at app start before it can land on a
user's first send). Every call marshals JSON in, JSON (or an `error:`-prefixed string) out. On web,
a stub always throws "not available on web — run on Android."

`.so` files for `arm64-v8a` (device) and `x86_64` (emulator) are cross-compiled by
`circuits/prover/build-android.sh` straight into `android/src/main/jniLibs/` — see `circuits/README.md`.

## Key dependencies

- **Routing/UI**: `expo-router` (file-based, typed routes), `react-native-reanimated` +
  `react-native-worklets`, `expo-blur` / `expo-glass-effect` / `expo-linear-gradient`
- **Crypto**: `@noble/curves` (ed25519), `@noble/hashes` (SHA-256, HKDF, PBKDF2, Argon2id),
  `@noble/ciphers` (AES-GCM), `@scure/base` (base32/base64) — audited pure-JS primitives for
  everything that isn't Groth16/Poseidon/Jubjub (which is native, see above)
- **Storage/security**: `expo-secure-store`, `expo-file-system`, `expo-local-authentication`
- **Backup**: `react-native-cloud-storage`, `@react-native-google-signin/google-signin`
- **Data**: `@tanstack/react-query` — the sole state/data-fetching library
- **Shared contract**: `@prova/shared` (local workspace package) — validation rules, country/phone
  tables, schema version, mirrored server-side in Go

## Conventions

- **Never hardcode colors/spacing** — import tokens from `@/constants/theme`.
- Build screens inside `<Screen>` so background, glow, and safe areas stay consistent.
- Secrets (master seed, PIN verifier, KYC credential, vault box) only ever go through
  `lib/secure-store.ts` — never plain storage, never `AsyncStorage`.
- Design language: dark-first, one chartreuse-yellow accent, rounded glassy components. See
  [`../Docs/design-system.md`](../Docs/design-system.md).

## Status

Sign-in (email OTP), KYC (identity → documents → credential), PIN + biometric security, cloud
backup/restore, recipients, and the on-device shielded-pool flow (shield/scan/send/cash-out) are all
wired against the real backend and the real Rust prover. `send.tsx` currently reads a simpler local
`balance.ts` counter rather than the pool's own note-based balance — flagged above as a transitional
seam to close. Phone-number verification is captured but not yet OTP-checked (`kyc-identity.tsx`);
the backend endpoints exist and are tested, just not called from this screen yet. On-device proving
latency on a real low-end Android has not yet been benchmark-run outside `pool-benchmark.tsx`'s
desktop-adjacent numbers — see [`Docs/implementation-guide.md`](../Docs/implementation-guide.md) Phase 4.
