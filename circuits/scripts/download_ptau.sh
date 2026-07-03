#!/usr/bin/env bash
# Download a Powers of Tau file for testnet (Hermez ceremony). For mainnet, use the output of
# Prova's own public ceremony (Phase 5), not this.
set -euo pipefail

mkdir -p build
PTAU="build/pot12_final.ptau"
URL="https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_12.ptau"

if [ -f "$PTAU" ]; then
  echo "$PTAU already present."
  exit 0
fi

echo "Downloading Powers of Tau (pot12)..."
curl -L "$URL" -o "$PTAU"
echo "Saved to $PTAU"
