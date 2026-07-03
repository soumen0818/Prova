# @prova/shared

Cross-component schemas — the spine of the Prova monorepo. The Circom circuit, Soroban contract,
Go backend, and Expo app all agree on the shapes defined here.

## What's inside (`src/`)

| File | Contract |
| --- | --- |
| `proof.ts` | Groth16 proof, public signals (commitment/nullifier), verification key |
| `ivms101.ts` | Travel-Rule data + the sealed encrypted envelope (proposal §9) |
| `api.ts` | Backend request/response types (mobile ↔ Go) |
| `errors.ts` | Stable error codes clients branch on |
| `index.ts` | Barrel + `SCHEMA_VERSION` |

## Usage

```bash
npm install
npm run build      # emits dist/ with types
```

Consumed by `mobile/` (and conceptually mirrored in `backend/` Go structs and `contracts/` Rust
types). Within this monorepo it can be referenced via a workspace path or published to a private
registry.

## Versioning rule

Any breaking change to these shapes is **cross-cutting** — bump `SCHEMA_VERSION` in `index.ts` and
update every consumer in the same commit (the whole point of the monorepo). The proof I/O format is
frozen to v1 in Phase 1.
