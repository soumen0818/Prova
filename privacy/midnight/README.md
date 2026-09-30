# Prova Midnight privacy layer

[![Midnight CI](https://github.com/soumen0818/Prova/actions/workflows/midnight-ci.yml/badge.svg)](https://github.com/soumen0818/Prova/actions/workflows/midnight-ci.yml)

Prova uses Midnight to prove that a holder has an authentic, unexpired credential at or above the
corridor's required KYC level. A successful proof records a one-time decision bound to a Stellar
nullifier. Stellar remains the settlement and custody layer; this contract never transfers value.

## Current status

| Item | Status |
|---|---|
| Authenticated Compact compliance contract | Complete |
| Holder-bound, issuer-signed private credential | Complete |
| Expiry, minimum KYC, issuer rotation, and anti-replay rules | Complete |
| Automated contract tests | **39 passing locally** |
| GitHub Actions workflow | **Passing** — [public run](https://github.com/soumen0818/Prova/actions/runs/36740035882) |
| Preprod connectivity and deploy preflight | Passing |
| Preprod contract deployment | Initial contract confirmed; managed replacement pending DUST sync and Preprod indexer recovery |
| Product UI/backend integration | Not complete |
| V2 live demo and one-minute video | Not complete |

This table is deliberately evidence-based. The existing website, APK, and Stellar deployment
demonstrate Prova V1; they are not represented as proof that the Midnight V2 flow is live.

## Privacy model

### What a public observer can learn

A Midnight observer can see:

- the contract address and its public code;
- the public policy: minimum KYC level, policy timestamp, policy-authority commitment, and issuer
  public key;
- each opaque 32-byte settlement decision recorded by the contract;
- that a valid proof authorized that decision; and
- when a contract call was finalized.

Once the corresponding Stellar nullifier becomes public, an observer can calculate the same
domain-separated decision and link that Midnight authorization to that Stellar settlement. This
link is intentional: it is the cross-chain hand-off and replay boundary.

### What a public observer cannot learn

The proof does not reveal:

- the holder secret or derived private user identifier;
- the credential identifier;
- the exact KYC level (only that it meets the public minimum);
- the credential expiry (only that it is not earlier than the public policy time);
- the credential signature;
- the transfer amount, sender, recipient, asset, or memo; or
- the Stellar nullifier before it is published on Stellar, assuming it is random and 32 bytes.

The credential issuer necessarily sees the credential attributes while issuing it. The user's local
proof environment sees the private witness. For that reason, the proof server must run on a machine
the user controls; sending witness material to an untrusted hosted proof server would break this
privacy model.

## Security properties implemented

The compliance circuit:

1. verifies a Jubjub Schnorr signature from the configured issuer;
2. binds the signed credential to the holder's secret;
3. signs the user ID, KYC level, expiry, and random credential ID, so none can be altered later;
4. checks expiry against authority-maintained ledger time, never a caller-supplied timestamp;
5. checks the private level against the public minimum;
6. domain-separates the Stellar settlement decision; and
7. rejects reuse of an already-authorized settlement decision.

Policy administration is protected by a private secret commitment. Policy time can only move
forward, and the authority can rotate the issuer key.

## Test locally

Prerequisites:

- Node.js 22;
- npm 10 or newer; and
- Compact toolchain 0.31.1.

Install Compact's devtool from the
[official release](https://github.com/midnightntwrk/compact/releases/tag/compact-v0.5.2), then select
the project compiler:

```bash
compact update 0.31.1
cd privacy/midnight
npm ci
npm test
```

`npm test` compiles all three Compact contracts, type-checks the TypeScript harness, and runs the Vitest suites. The submission-critical
compliance suite exercises valid authorization, forged signatures, post-signature tampering,
credential theft, expiry boundaries, policy authorization, issuer rotation, and settlement replay.

## Preprod deployment

Copy the environment template, create the policy, issuer, and maintenance secrets, then generate a deployment wallet:

```bash
cd privacy/midnight
cp .env.example .env
openssl rand -hex 32                    # place this in POLICY_SECRET
npm run issuer:new
npm run maintenance:new
npm run wallet:new
npm run wallet:status
```

Fund the printed address with Preprod tNIGHT at
[the Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev/). Never paste a seed or policy
secret into the faucet.

Start the locally controlled proof server:

```bash
docker run -d --rm --name prova-midnight-proof-server \
  -p 6300:6300 midnightntwrk/proof-server:8.0.3
```

Then verify every dependency without spending and deploy:

```bash
npm run deploy:check
npm run deploy
npm run deploy:verify
```

The live deployment command waits for NIGHT/DUST synchronization, submits the constructor
transaction, reads the contract state back, and rejects a deployment whose authority, issuer,
minimum, policy time, or empty replay set differs from the requested state.

## Repository map

- `contracts/compliance.compact` — submission contract and public/private boundary.
- `contracts/schnorr.compact` — in-circuit Jubjub Schnorr verification.
- `tests/compliance.test.ts` — compliance security and policy tests.
- `deploy/deploy.mjs` — Preprod preflight, wallet/DUST setup, deployment, and state verification.
- `deploy/verify-deployment.mjs` — read-only verification against the public Preprod indexer.
- `deploy/new-wallet.mjs` — generates the deployment seed without printing it.
- `deploy/new-issuer.mjs` — creates or displays the credential issuer key safely.
- `deploy/new-maintenance-key.mjs` — creates the contract-maintenance signing key safely.
- `scripts/check-toolchain.mjs` — fails fast on an incompatible compiler/runtime/ledger tuple.

## Known limitations before submission

- The initial Preprod contract has a verifiable address, but its SDK-generated maintenance key was not retained after a local post-finalization error. Do not use it as the canonical submission address; a replacement using an explicitly backed-up key is in progress.
- Credential issuance and the user proof call are not yet connected to the product UI/backend.
- Stellar does not yet verify or atomically consume the Midnight decision. Until that enforcement
  path is implemented, the cross-chain relay is a trust boundary.
- Compact 0.23 has no trusted chain-time primitive, so an authorized operator must advance
  `policyTime`. The monotonic rule prevents rolling it backward, but it does **not** make the value
  advance automatically: if updates stop, credentials expired in real time can still pass.
- The V2 demo video, test screenshot, product X profile, and proposal-approval evidence are manual
  submission artifacts and are not yet present in this repository.
