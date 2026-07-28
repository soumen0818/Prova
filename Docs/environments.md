# Prova — Environments & Secrets

Companion to [implementation-guide.md](implementation-guide.md) (Phase 0 cross-cutting). Defines the
deployment environments, their Stellar endpoints, and how secrets are handled.

## Environments

| Env | Purpose | Stellar network |
| --- | --- | --- |
| `local` | Developer machine | testnet |
| `dev` / testnet | Shared integration | testnet |
| `staging` | Pre-prod rehearsal | testnet (→ mainnet trial late) |
| `prod` | Live corridor | mainnet |

## Stellar endpoints

| | Testnet | Mainnet |
| --- | --- | --- |
| Horizon | `https://horizon-testnet.stellar.org` | `https://horizon.stellar.org` |
| Soroban RPC | `https://soroban-testnet.stellar.org` | `https://mainnet.sorobanrpc.com` (or Validation Cloud / QuickNode) |
| Network passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |

These defaults are baked into each component:
- mobile → [`mobile/src/config/env.ts`](../mobile/src/config/env.ts)
- backend → [`backend/internal/config/config.go`](../backend/internal/config/config.go)
- contracts → `contracts/scripts/deploy_testnet.sh`

## Anchors (per env)

| Env | UAE (deposit + KYC) | India (payout / NBFC) |
| --- | --- | --- |
| local / dev | SDF testanchor / reference impl | SDF testanchor / reference impl |
| prod | licensed UAE anchor (Phase 5) | licensed Indian NBFC (Phase 5) |

## Secrets management

- **Local:** per-component `.env` (gitignored); commit only `.env.example`. Only `EXPO_PUBLIC_*` /
  non-secret values ship to the client.
- **Device secrets:** the ZK secret key + KYC credential live in the phone's secure enclave via
  [`mobile/src/lib/secure-store.ts`](../mobile/src/lib/secure-store.ts) — never in env, never on a server.
- **Staging/prod:** a managed secrets store (Doppler / AWS Secrets Manager / Vault) injects anchor
  API keys, signing keys, DB creds. Wire in Phase 5; do **not** put real secrets in the repo.

## Golden rule

The backend and chain never see amounts or identities. Secrets that *do* exist (anchor keys, signing
keys, DB creds) are server-side only and rotated through the secrets manager — never committed.
