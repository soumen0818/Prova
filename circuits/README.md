# circuits

Prova's compliance circuits — Circom + SnarkJS (Groth16 over BN254). The circuit is the
"mathematical rulebook" that proves a transfer is legal without revealing the amount.

## Requirements

- Node 22 (`nvm use 22`) — for SnarkJS + circomlib
- **circom** ≥ 2.1 (the compiler is a separate Rust binary — install it):
  ```bash
  # via cargo:
  cargo install --git https://github.com/iden3/circom.git
  # or download a release binary from github.com/iden3/circom/releases
  ```

## Build pipeline

```bash
npm install          # circomlib + snarkjs
npm run compile      # circom -> build/transfer.{r1cs,wasm,sym}
npm run ptau         # download Powers of Tau (testnet)
npm run setup        # groth16 setup -> proving key
npm run contribute   # add entropy -> final zkey
npm run vkey         # export build/verification_key.json
```

The exported `verification_key.json` is the shared artifact consumed by **both** the Soroban
contract (`../contracts`) and the mobile prover (`../mobile`). Treat it as a versioned release tied
to `@prova/shared`'s proof format.

## Status

Phase 0: a compiling skeleton — range check + commitment + nullifier (`circuits/transfer.circom`).
Phase 1: freeze the public-signal format, run the testnet trusted setup, verify on Soroban.
Phase 3: add the in-circuit KYC-signature (EdDSA) check.
Phase 5: public Powers of Tau ceremony for mainnet keys.
