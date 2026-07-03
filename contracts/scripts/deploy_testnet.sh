#!/usr/bin/env bash
# Build and deploy the Prova verifier to Stellar testnet.
# Prereqs: rust + wasm32 target, stellar CLI >= 27, a funded testnet identity.
#
#   stellar keys generate --global prova-test --network testnet --fund
#   ./scripts/deploy_testnet.sh
set -euo pipefail

IDENTITY="${STELLAR_IDENTITY:-prova-test}"
NETWORK="${STELLAR_NETWORK:-testnet}"
WASM="target/wasm32-unknown-unknown/release/prova_verifier.wasm"

echo "Building contract (release wasm)..."
stellar contract build

echo "Optimizing..."
stellar contract optimize --wasm "$WASM" || true

echo "Deploying to $NETWORK as $IDENTITY..."
stellar contract deploy \
  --wasm "$WASM" \
  --source "$IDENTITY" \
  --network "$NETWORK"
