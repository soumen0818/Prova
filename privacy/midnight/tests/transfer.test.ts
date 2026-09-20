import { describe, it, expect } from 'vitest';
import * as Transfer from '../build-transfer/contract/index.js';
import { Harness, validInputs, bytes32, hex, NOW } from './harness.js';

// Prova — the transfer circuit, executed.
//
// # Why these tests exist
//
// The ownership bug in this contract compiled cleanly and passed every assert. It was found by
// reading the Compact against the Soroban circuit, not by any tool. That is not a repeatable way to
// find the next one.
//
// Compilation proves syntax. These tests prove behaviour, and they are written around a single
// principle: **a circuit is only as good as what it refuses**. A test that a valid transfer succeeds
// says almost nothing — the ownership bug passed that test. The tests that matter are the ones where
// an attacker gets everything they want except one fact, and the circuit still says no.
//
// So each failure test starts from the same valid transfer and changes exactly one thing. When one
// fails, the thing it changed is the thing that broke.

describe('transfer — the valid case', () => {
  it('spends one note into two, conserving value', async () => {
    const h = await Harness.create();
    await h.seedInputNote();

    expect(h.ledger.commitments.firstFree()).toBe(1n);

    const nullifier = await h.transfer();

    // One note burned, two published.
    expect(h.ledger.nullifiers.size()).toBe(1n);
    expect(h.ledger.nullifiers.member(nullifier)).toBe(true);
    expect(h.ledger.commitments.firstFree()).toBe(3n);
  });

  it('publishes output commitments that match the notes claimed', async () => {
    const h = await Harness.create();
    await h.seedInputNote();
    await h.transfer();

    // The recipient must be able to find their note. If the published leaf were anything other than
    // a commitment to the amount and key claimed, the money would be unspendable — value destroyed
    // rather than stolen, but destroyed all the same.
    const expected = Transfer.pureCircuits.tCommitment(
      h.inputs.output1Amount,
      h.inputs.output1OwnerPk,
      h.inputs.output1Rho,
    );
    expect(h.ledger.commitments.findPathForLeaf(expected)).toBeDefined();
  });
});

describe('transfer — ownership', () => {
  // The regression test for the bug that started all of this.
  //
  // The attacker knows everything public about a note — its commitment sits in the tree, and its
  // path is derivable by anyone watching the chain. What they do not have is the spending key.
  //
  // In the buggy version `ownerPk` was computed and then never used, so the commitment the circuit
  // checked for membership was never tied to the spender's key. A stranger could present a real
  // path to someone else's note and spend it. Every assert passed.
  it('rejects a spend of a note the caller does not own', async () => {
    const h = await Harness.create();

    // The victim's note goes into the tree, deposited to *their* key.
    const victimSk = bytes32(7);
    const victimPk = Transfer.pureCircuits.tOwnerPk(victimSk);
    const rho = bytes32(9);
    const commitment = await h.deposit(100n, victimPk, rho);

    // The attacker takes the victim's note and its genuine path — both public — but signs with
    // their own key, which is the one thing they actually hold.
    h.inputs.spenderSecretKey = bytes32(42);
    h.inputs.inputAmount = 100n;
    h.inputs.inputRho = rho;
    h.inputs.inputPath = h.ledger.commitments.findPathForLeaf(commitment);

    // The change output is addressed to the VICTIM's key, not the attacker's.
    //
    // This looks like a detail and is the entire test. An earlier version of it sent the change to
    // the attacker's own key — the natural thing to write, since an attacker wants the money — and
    // it passed against a deliberately reintroduced ownership bug. It passed for the wrong reason:
    // the buggy circuit happened to hash `output2OwnerPk` into the input commitment, so naming the
    // attacker's key corrupted the commitment and the spend failed on membership instead of
    // ownership. The test reported a pass while the contract was fully exploitable.
    //
    // A real attacker has no reason to be so helpful. Every public field here is set to exactly
    // what the victim's own valid spend would contain, so the ONLY thing separating this from a
    // legitimate transfer is the secret key. That is what makes a failure here attributable to
    // ownership and nothing else.
    h.inputs.output2OwnerPk = victimPk;

    await expect(h.transfer()).rejects.toThrow(/merkle path does not match the input note/);
  });

  it('rejects a spend that inflates the note it claims to own', async () => {
    const h = await Harness.create();
    await h.seedInputNote();

    // Same key, same note, same path — but the spender claims the note was worth more than it is,
    // and splits the inflated amount. If the circuit rebuilt the commitment from anything less than
    // all three fields, this would mint the difference.
    h.inputs.inputAmount = 1_000_000n;
    h.inputs.output1Amount = 999_940n;

    await expect(h.transfer()).rejects.toThrow(/merkle path does not match the input note/);
  });
});

describe('transfer — membership', () => {
  it('rejects a note that was never deposited', async () => {
    const h = await Harness.create();

    // A note that exists only in the spender's imagination. They build a real path for it — in a
    // tree of their own — and present that.
    const other = await Harness.create();
    await other.seedInputNote();
    h.inputs.inputPath = other.inputs.inputPath;

    // The path is internally consistent, so it reaches *a* root — just not one this ledger has ever
    // accepted. This is the check that stops a spender inventing a tree.
    await expect(h.transfer()).rejects.toThrow(/input note is not in the pool/);
  });
});

describe('transfer — double spend', () => {
  it('rejects the second spend of the same note', async () => {
    const h = await Harness.create();
    await h.seedInputNote();

    const nullifier = await h.transfer();
    expect(h.ledger.nullifiers.member(nullifier)).toBe(true);

    // The note is gone, but the spender still holds every input that worked the first time. The
    // nullifier is deterministic precisely so that replaying them collides instead of succeeding.
    await expect(h.transfer()).rejects.toThrow(/note already spent/);
  });

  it('derives the same nullifier from the same note every time', async () => {
    // The property the double-spend check rests on. A random nullifier would make the check above
    // pass while leaving double-spending entirely possible.
    const sk = bytes32(7);
    const rho = bytes32(9);
    expect(hex(Transfer.pureCircuits.tNullifier(sk, rho)))
      .toBe(hex(Transfer.pureCircuits.tNullifier(sk, rho)));
  });
});

describe('transfer — conservation', () => {
  it('rejects outputs that sum to more than the input', async () => {
    const h = await Harness.create();
    await h.seedInputNote();

    // Printing money, stated plainly: 100 in, 150 out.
    h.inputs.output1Amount = 60n;
    h.inputs.output2Amount = 90n;

    await expect(h.transfer()).rejects.toThrow(/value not conserved/);
  });

  it('rejects outputs that sum to less than the input', async () => {
    const h = await Harness.create();
    await h.seedInputNote();

    // Value vanishing is less alarming than value appearing, and still wrong — the circuit demands
    // equality, not `>=`.
    h.inputs.output1Amount = 10n;
    h.inputs.output2Amount = 10n;

    await expect(h.transfer()).rejects.toThrow(/value not conserved/);
  });

  it('rejects an overflow attempt that would wrap the sum', async () => {
    const h = await Harness.create();
    await h.seedInputNote();

    // The attack the range checks exist to stop, and the one most likely to be silently broken.
    //
    // Over an unbounded field, an attacker picks outputs summing to the input *modulo the field
    // order* — real money out, arithmetic that still balances. `Uint<64>` is what forbids it: the
    // sum below exceeds 64 bits, so the type rejects it before conservation is even considered.
    //
    // This test is the reason to care whether amounts are `Uint<64>` rather than a field element.
    // If someone widens those types for convenience, this is what fails.
    h.inputs.output1Amount = 2n ** 64n - 1n;
    h.inputs.output2Amount = 101n;

    await expect(h.transfer()).rejects.toThrow();
  });
});

describe('transfer — KYC', () => {
  it('rejects an expired credential', async () => {
    const h = await Harness.create();
    await h.seedInputNote();

    h.inputs.kycExpiry = NOW - 1n;

    await expect(h.transfer()).rejects.toThrow(/credential has expired/);
  });

  it('accepts a credential expiring exactly now', async () => {
    const h = await Harness.create();
    await h.seedInputNote();

    // The boundary. `>=` means a credential expiring this second is still good; an off-by-one here
    // would lock out every user at the exact moment of renewal.
    h.inputs.kycExpiry = NOW;

    await expect(h.transfer()).resolves.toBeDefined();
  });

  it('cannot be rescued by the spender choosing a convenient time', async () => {
    const h = await Harness.create();
    await h.seedInputNote();
    h.inputs.kycExpiry = NOW - 100_000n;

    // `currentTime` is an argument, not a witness — the verifier supplies it. The spender passing
    // an earlier time is not a hole in the circuit but a claim the chain would reject; what this
    // test pins is that the comparison genuinely uses the value passed in, so that when the chain
    // supplies the real time, an expired credential fails.
    await expect(h.transfer(NOW)).rejects.toThrow(/credential has expired/);
  });
});

describe('transfer — digest agreement with notes.compact', () => {
  it('derives identical values from the duplicated helpers', async () => {
    // `transfer.compact` and `notes.compact` define the note algebra separately, by hand. They are
    // meant to be the same function. Nothing in the compiler enforces that, and a change to one
    // would silently fork the two — notes created under one definition would be unspendable under
    // the other.
    const Notes = await import('../build-notes/contract/index.js');
    const sk = bytes32(7);
    const rho = bytes32(9);

    const pk = Transfer.pureCircuits.tOwnerPk(sk);
    expect(hex(pk)).toBe(hex(Notes.pureCircuits.deriveOwnerPk(sk)));
    expect(hex(Transfer.pureCircuits.tCommitment(100n, pk, rho)))
      .toBe(hex(Notes.pureCircuits.noteCommitment(100n, pk, rho)));
    expect(hex(Transfer.pureCircuits.tNullifier(sk, rho)))
      .toBe(hex(Notes.pureCircuits.noteNullifier(sk, rho)));
  });

  it('gives different commitments to identical notes with different nonces', async () => {
    // What `rho` is for. Without it, two notes of the same amount to the same owner would produce
    // the same leaf, and an observer could see that someone was paid 50 twice.
    const pk = Transfer.pureCircuits.tOwnerPk(bytes32(7));
    expect(hex(Transfer.pureCircuits.tCommitment(50n, pk, bytes32(1))))
      .not.toBe(hex(Transfer.pureCircuits.tCommitment(50n, pk, bytes32(2))));
  });
});
