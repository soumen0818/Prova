#!/usr/bin/env bash
# Mutation testing for the transfer circuit.
#
# A passing test suite is a claim, not evidence. This script falsifies the claim: it breaks the
# circuit in specific, plausible ways and checks the tests actually notice. A mutant that survives
# is a check nothing is really testing.
#
# This is not theoretical. The first version of the ownership test passed against a deliberately
# reintroduced ownership bug — a fully exploitable contract, reported green. That is precisely the
# class of failure this whole exercise exists to catch, and only mutation testing surfaced it.
#
# Usage: ./mutants.sh
set -uo pipefail
cd "$(dirname "$0")"

SRC=contracts/transfer.compact
BAK=$(mktemp)
cp "$SRC" "$BAK"
restore() { cp "$BAK" "$SRC"; compact compile "$SRC" build-transfer >/dev/null 2>&1; rm -f "$BAK"; }
trap restore EXIT

pass=0; fail=0

# run_mutant <name> <python-replacement-expression>
run_mutant() {
  local name="$1" old="$2" new="$3"
  cp "$BAK" "$SRC"
  python3 - "$SRC" "$old" "$new" <<'PY'
import sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
if old not in s:
    sys.exit(3)
open(p, 'w').write(s.replace(old, new, 1))
PY
  case $? in
    3) echo "  ?? $name — pattern not found, mutant skipped"; return;;
  esac

  if ! compact compile "$SRC" build-transfer >/dev/null 2>&1; then
    echo "  -- $name — did not compile, not a valid mutant"
    return
  fi

  if npx vitest run >/dev/null 2>&1; then
    echo "  SURVIVED  $name — tests passed against a broken circuit"
    fail=$((fail+1))
  else
    echo "  killed    $name"
    pass=$((pass+1))
  fi
}

echo "Mutation testing transfer.compact"
echo

# 1. Ownership: bind the commitment to a key the spender does not have to hold.
run_mutant "ownership: commitment not bound to spender key" \
  'const inCommitment = tCommitment(inAmount, ownerPk, inRho);' \
  'const inCommitment = tCommitment(inAmount, output2OwnerPk(), inRho);'

# 2. Membership: accept any root the prover can construct.
run_mutant "membership: root check removed" \
  'assert(commitments.checkRoot(computedRoot), "input note is not in the pool");' \
  ''

# 3. Membership: stop tying the path to the rebuilt commitment.
run_mutant "membership: path/commitment binding removed" \
  'assert(path.leaf == inCommitment, "merkle path does not match the input note");' \
  ''

# 4. Double spend: forget to check whether the nullifier was already seen.
run_mutant "double-spend: nullifier freshness check removed" \
  'assert(!nullifiers.member(nullifier), "note already spent");' \
  ''

# 5. Conservation: allow value to vanish, the classic >= slip.
run_mutant "conservation: equality weakened to >=" \
  'assert(inAmount == out1 + out2, "value not conserved");' \
  'assert(inAmount >= out1 + out2, "value not conserved");'

# 6. Conservation: drop the check entirely — money printing.
run_mutant "conservation: check removed" \
  'assert(inAmount == out1 + out2, "value not conserved");' \
  ''

# 7. KYC expiry: off-by-one that locks out or lets through at the boundary.
run_mutant "kyc: expiry boundary flipped to >" \
  'assert(kycExpiry() >= currentTime, "credential has expired");' \
  'assert(kycExpiry() > currentTime, "credential has expired");'

# 8. KYC expiry: removed altogether.
run_mutant "kyc: expiry check removed" \
  'assert(kycExpiry() >= currentTime, "credential has expired");' \
  ''

echo
echo "killed $pass, survived $fail"
[ "$fail" -eq 0 ]
