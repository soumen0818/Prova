#!/usr/bin/env bash
# Build and deploy the Prova verifier to Stellar testnet.
# Prereqs: rust + wasm32 target, stellar CLI >= 27, a funded testnet identity.
#
#   stellar keys generate --global prova-test --network testnet --fund
#   ./scripts/deploy_testnet.sh
set -euo pipefail

IDENTITY="${STELLAR_IDENTITY:-prova-test}"
NETWORK="${STELLAR_NETWORK:-testnet}"
# soroban-sdk 22 / stellar-cli 27 emit to the wasm32v1-none target dir.
WASM="target/wasm32v1-none/release/prova_verifier.wasm"

echo "Building + optimizing contract (release wasm)..."
stellar contract build --optimize

echo "Deploying to $NETWORK as $IDENTITY..."
stellar contract deploy \
  --wasm "$WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK"
