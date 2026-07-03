# contracts

Prova's on-chain verifier — a Soroban (Rust) smart contract on Stellar.

## What it does

- Verifies the ~200-byte Groth16 proof via a BN254 pairing check (wired in **Phase 1**)
- Rejects replayed **nullifiers** (anti-replay / double-spend)
- Records **commitments** and emits a `transfer` event the backend indexer consumes

On-chain it only ever sees commitments, nullifiers, and proofs — never amounts or identities.

## Layout

```
Cargo.toml            workspace
rust-toolchain.toml   pins stable + wasm32 target
verifier/             the contract crate
  src/lib.rs          contract logic (nullifier registry + commitment store + events)
  src/test.rs         unit tests
scripts/
  deploy_testnet.sh   build + deploy to Stellar testnet
```

## Develop

```bash
cargo test                                          # run unit tests
stellar contract build                              # build optimized wasm
./scripts/deploy_testnet.sh                         # deploy to testnet
```

## Status

Phase 0: nullifier registry + commitment store + events (this skeleton).
Phase 1: add the Groth16 / BN254 pairing verification using the verification key frozen in
`@prova/shared`, and validate gas cost on testnet (the #1 project de-risk).
