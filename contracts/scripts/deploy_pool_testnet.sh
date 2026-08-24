#!/usr/bin/env bash
# Build, deploy and initialize the Prova shielded pool on Stellar testnet.
#
# The pool is a NEW contract, not a replacement for the Phase-2 verifier — it gets its own contract
# id. See Docs/shielded-pool.md.
#
# Prereqs:
#   rust + wasm target, stellar CLI >= 27, and two funded testnet identities:
#
#     stellar keys generate prova-admin  --network testnet --fund   # break-glass key
#     stellar keys generate prova-test   --network testnet --fund   # deployer/relayer
#
#   (stellar-cli 27 has no --global flag; keys generate always stores in
#   ~/.config/stellar/identity/, never in the project folder.)
#
#   ADMIN and DEPLOYER should NOT be the same key. The admin can replace the contract's code, so it
#   is the most dangerous secret in the system: keep it off every server, out of every .env, and out
#   of git. The deployer/relayer only pays fees and can be treated as disposable.
#
# Usage:
#   TOKEN_ID=C...  ./scripts/deploy_pool_testnet.sh
set -euo pipefail

ADMIN="${ADMIN_IDENTITY:-prova-admin}"
DEPLOYER="${STELLAR_IDENTITY:-prova-test}"
NETWORK="${STELLAR_NETWORK:-testnet}"
PROVER="${PROVER_BIN:-../circuits/prover/target/release/prova-prover}"
# soroban-sdk 22 / stellar-cli 27 emit to the wasm32v1-none target dir.
WASM="target/wasm32v1-none/release/prova_pool.wasm"

# The SEP-41 / Stellar Asset Contract the pool custodies (SRT on testnet). Find it with:
#   stellar contract id asset --asset SRT:<ISSUER_G_ADDRESS> --network testnet
TOKEN_ID="${TOKEN_ID:?set TOKEN_ID to the SAC address of the asset the pool will hold}"

echo "==> Building contract (optimized release wasm)"
stellar contract build --optimize

echo "==> Reading the anchor public key from the prover"
# Taken from the prover so the on-chain key always matches the circuit's KYC gadget — never
# hand-copied. Rotatable later via `set_anchor`.
#
# ⚠️  ANCHOR_SEED MUST MATCH THE BACKEND THAT WILL ISSUE CREDENTIALS.
#
# The prover derives this key from ANCHOR_SEED, falling back to a built-in dev key when unset. Run
# this script without the seed your backend uses and the contract is initialised with a DIFFERENT
# anchor: every credential is then signed by one key and checked against another, so every spend
# proof is rejected while deposits, folding and the whole pool look perfectly healthy. That cost a
# week to find once.
#
# Compare before trusting the deployment:
#   curl -s https://<your-api>/anchors/trusted
if [ -z "${ANCHOR_SEED:-}" ]; then
    echo "    ⚠️  ANCHOR_SEED is not set — using the prover's built-in dev key."
    echo "       If the backend sets ANCHOR_SEED, this pool will reject every spend proof."
    echo "       Export the SAME value the backend uses, or fix it afterwards with set_anchor."
fi
ANCHOR_JSON="$("$PROVER" anchor-pubkey)"
ANCHOR_X="$(printf '%s' "$ANCHOR_JSON" | sed -E 's/.*"x":"([^"]+)".*/\1/')"
ANCHOR_Y="$(printf '%s' "$ANCHOR_JSON" | sed -E 's/.*"y":"([^"]+)".*/\1/')"
echo "    anchor x = $ANCHOR_X"
echo "    anchor y = $ANCHOR_Y"

ADMIN_ADDRESS="$(stellar keys address "$ADMIN")"
echo "==> Admin will be $ADMIN_ADDRESS  (identity: $ADMIN)"

echo "==> Deploying to $NETWORK as $DEPLOYER"
POOL_ID="$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$DEPLOYER" \
  --network "$NETWORK")"
echo "    pool contract id = $POOL_ID"

echo "==> Initializing (admin, token, anchor key) — one-shot, cannot be repeated"
stellar contract invoke \
  --id "$POOL_ID" \
  --source "$DEPLOYER" \
  --network "$NETWORK" \
  -- initialize \
  --admin "$ADMIN_ADDRESS" \
  --token "$TOKEN_ID" \
  --anchor_pk_x "$ANCHOR_X" \
  --anchor_pk_y "$ANCHOR_Y"

cat <<EOF

==> Done.

  POOL_CONTRACT_ID=$POOL_ID

Add that to backend/.env. It is a public identifier — safe to commit and share.

Do NOT put the admin secret in backend/.env or on any server. The backend never needs it: it only
reads pool state and submits user transactions with the relayer key. The admin key is used by hand,
from a terminal, for the rare break-glass operations in Docs/shielded-pool.md §10.5.
EOF
