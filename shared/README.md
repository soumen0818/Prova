# @prova/shared

Cross-component schemas — the spine of the Prova polyrepo. The circuits, the Soroban contracts, the
Go backend, and the Expo app all agree on the shapes defined here, in two mirrored forms: a
TypeScript package (`src/`, consumed by `mobile/`) and a Go module (`go/schema/`, consumed by
`backend/`). **Neither is generated from the other** — every file has a hand-maintained twin, and a
change to one is not complete until its twin and every consumer are updated in the same commit. That
discipline is the entire point of this package: without it, a polyrepo silently drifts into mobile
and backend disagreeing on a data shape.

## What's inside

| TypeScript (`src/`) | Go (`go/schema/`) | Frozen contract |
| --- | --- | --- |
| `proof.ts` | `proof.go` | The Groth16 proof + public-input + verification-key wire format. **v1**, `PROOF_FORMAT = 'bls12-381-groth16-v1'`. BLS12-381, not BN254 — Soroban has no BN254 host functions. Points are Soroban's uncompressed big-endian encoding (`G1` = 96 bytes, `G2` = 192 bytes, `Fp2 = c1‖c0`). |
| `ivms101.ts` | `ivms101.go` | Travel-Rule data — the sealed envelope exchanged edge-to-edge between the UAE and India anchors. **Never goes on-chain in cleartext**; travels encrypted to the beneficiary anchor's public key (primary path) or off-chain via a Travel-Rule network (fallback). |
| `api.ts` | `api.go` | Backend request/response contracts (mobile ↔ Go). Frozen for Phase 2: the transfer-submission shape and the `TransferStatus` lifecycle. |
| `events.ts` | `events.go` | The Soroban event schema the indexer reads — the `transfer` event's topic + data shape, matching `contracts/verifier`'s `env.events().publish(...)` exactly. |
| `credential.ts` | `credential.go` | The anchor-attested KYC credential: `sign(userId, kycLevel, expiry)` via Poseidon-challenge Schnorr/EdDSA over Jubjub, verified *inside* the Groth16 circuit. Identity never touches the chain — only `userId = Poseidon(secret, domain)`, which reveals nothing. |
| `kyc.ts` | `kyc.go` | The KYC verification lifecycle contract (mobile ↔ backend). Carries **no PII** by design — only the opaque `userId`, a tier, and a status; documents go straight from the device to the verification provider. |
| `pool.ts` | `pool.go` | The shielded pool contract — **the single source of truth** for the note format, Merkle tree parameters (`DEPTH`, `BATCH`, `ROOT_HISTORY`), the spend/shield/fold circuits' public-input order, and the on-chain event shape. The circuit, the Soroban contract, the backend indexer, and the wallet must all agree bit-for-bit; nothing here changes without a version bump and a coordinated redeploy (new trusted setup + new verifying key + contract upgrade). |
| `errors.ts` | `errors.go` | Stable error codes every client branches on (`invalid_proof`, `kyc_required`, `credential_expired`, `nullifier_already_used`, …). Add codes, never repurpose one. |
| `validation.ts` | `validation.go` | Input validation rules — email, national phone-by-country (Unicode-aware, Indic scripts included), OTP shape, name, recipient handle/country, amount ranges. **The single source of truth for both the app and the backend.** Client-side validation is a courtesy (a pleasant form); server-side is the actual control, since anything can call the API directly — so the rules live once, in a form both languages mirror exactly, with matching test cases on both sides. Never tighten one side without the other. |
| `index.ts` | `schema.go` | Barrel export + `SCHEMA_VERSION`. |

## Usage

**TypeScript** (`mobile/` consumes this as a local workspace package):

```bash
cd shared
npm install
npm run build       # emits dist/ with types
npm run typecheck
```

**Go** (`backend/` imports `github.com/prova/shared`):

```bash
cd shared/go
go build ./...
go test ./...        # validation_test.go asserts the same cases as validation.test.ts
```

## Versioning rule

Any breaking change to a shape here is **cross-cutting by definition** — bump `SCHEMA_VERSION` in
`src/index.ts` (and the matching constant in `go/schema/schema.go`), and update every consumer
(`mobile/`, `backend/`, and — for the proof/pool formats specifically — `circuits/` and
`contracts/`) in the same commit. `proof.ts`/`proof.go` are frozen as v1; `pool.ts`/`pool.go` is
frozen as v3 (mirroring the circuit generation in `circuits/README.md`). A version bump on either
implies a coordinated redeploy: new trusted setup, new verifying key baked into the contract, and
every consumer updated together — never a rolling, uncoordinated change.
