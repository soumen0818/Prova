pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

// ⚠️ SUPERSEDED (Phase 1): Soroban has no BN254 host functions, so the ZK stack was moved to
// BLS12-381 Groth16 via arkworks. The live circuit + prover is `circuits/prover/` (Rust).
// This BN254 Circom circuit is kept for reference only. See Docs/phase1-findings.md.
//
// Prova compliance circuit — Phase 0 skeleton.
//
// Proves, without revealing the amount:
//   1. amount is within [1, maxAmount]   (range check)
//   2. commitment = Poseidon(amount, secret)
//   3. nullifier  = Poseidon(secret, transferId)   (anti-replay, unlinkable)
//
// Phase 1 freezes the public-signal format in @prova/shared and runs the trusted setup.
// Phase 3 adds the in-circuit KYC-signature (EdDSA) check.
template Transfer(maxAmount) {
    // Private inputs — never leave the phone.
    signal input amount;
    signal input secret;
    signal input transferId;

    // Public outputs.
    signal output commitment;
    signal output nullifier;

    // amount <= maxAmount
    component lte = LessEqThan(32);
    lte.in[0] <== amount;
    lte.in[1] <== maxAmount;
    lte.out === 1;

    // amount > 0
    component gtz = GreaterThan(32);
    gtz.in[0] <== amount;
    gtz.in[1] <== 0;
    gtz.out === 1;

    // commitment = Poseidon(amount, secret)
    component c = Poseidon(2);
    c.inputs[0] <== amount;
    c.inputs[1] <== secret;
    commitment <== c.out;

    // nullifier = Poseidon(secret, transferId)
    component n = Poseidon(2);
    n.inputs[0] <== secret;
    n.inputs[1] <== transferId;
    nullifier <== n.out;
}

// FEMA/UAE within-limit ceiling (placeholder value).
component main = Transfer(9999);
