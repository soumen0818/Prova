// Shared test harness for the Compact circuits.
//
// The point of this file is that every test below states one fact about the circuits and nothing
// about how the runtime is wired up. Building a context by hand in each test would mean a typo in
// the setup reads as a circuit failure, which is exactly the confusion these tests exist to remove.

import {
  createConstructorContext,
  createCircuitContext,
} from '@midnight-ntwrk/compact-runtime';
import * as Transfer from '../build-transfer/contract/index.js';

// A coin public key and contract address. Neither circuit touches shielded coins or cross-contract
// calls, so these only need to be well-formed, not meaningful.
export const COIN_PUBLIC_KEY = '0'.repeat(64);
export const CONTRACT_ADDRESS = '00'.repeat(32);

/** 32 identical bytes — a readable stand-in for a key or nonce. */
export const bytes32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/**
 * The private inputs to `transfer`, as plain values.
 *
 * Witnesses in Compact are functions the runtime calls during execution. Tests want to *state*
 * values, so the harness holds a mutable record and the witness functions read from it. That also
 * makes the attack cases natural to write: take a valid set, change one field, expect a failure.
 */
export interface TransferInputs {
  spenderSecretKey: Uint8Array;
  inputAmount: bigint;
  inputRho: Uint8Array;
  output1Amount: bigint;
  output1OwnerPk: Uint8Array;
  output1Rho: Uint8Array;
  output2Amount: bigint;
  output2OwnerPk: Uint8Array;
  output2Rho: Uint8Array;
  kycLevel: bigint;
  kycExpiry: bigint;
  // Supplied by the harness after the deposit, since a path can only be found once the leaf is in
  // the tree. Tests that tamper with membership overwrite it.
  inputPath: unknown;
}

/**
 * A transfer that should pass: one note of 100 owned by `sk`, split into 60 to a stranger and 40 in
 * change back to the spender, with a credential well above the bar and far from expiry.
 *
 * Every failure test below is this object with exactly one field changed, so whatever the test
 * proves is attributable to that field alone.
 */
export const validInputs = (): TransferInputs => {
  const sk = bytes32(7);
  return {
    spenderSecretKey: sk,
    inputAmount: 100n,
    inputRho: bytes32(9),
    output1Amount: 60n,
    output1OwnerPk: bytes32(1),
    output1Rho: bytes32(2),
    output2Amount: 40n,
    output2OwnerPk: Transfer.pureCircuits.tOwnerPk(sk),
    output2Rho: bytes32(3),
    kycLevel: 3n,
    kycExpiry: 2_000_000_000n,
    inputPath: null,
  };
};

/** A time comfortably inside the credential's validity window. */
export const NOW = 1_700_000_000n;

/**
 * A live contract whose witnesses read from a mutable `inputs` record.
 *
 * `deposit` seeds the tree; `transfer` spends. State is threaded between them by hand because each
 * circuit call returns a new context rather than mutating one — the same way a real client would
 * carry state forward between transactions.
 */
export class Harness {
  inputs: TransferInputs;
  private contract: Transfer.Contract<Record<string, never>>;
  private state: unknown;

  private constructor(inputs: TransferInputs) {
    this.inputs = inputs;
    const read = <K extends keyof TransferInputs>(key: K) => (ctx: { privateState: Record<string, never> }): [Record<string, never>, TransferInputs[K]] =>
      [ctx.privateState, this.inputs[key]];

    this.contract = new Transfer.Contract({
      spenderSecretKey: read('spenderSecretKey'),
      inputAmount: read('inputAmount'),
      inputRho: read('inputRho'),
      output1Amount: read('output1Amount'),
      output1OwnerPk: read('output1OwnerPk'),
      output1Rho: read('output1Rho'),
      output2Amount: read('output2Amount'),
      output2OwnerPk: read('output2OwnerPk'),
      output2Rho: read('output2Rho'),
      kycLevel: read('kycLevel'),
      kycExpiry: read('kycExpiry'),
      inputPath: read('inputPath'),
    } as never);
  }

  static async create(inputs: TransferInputs = validInputs()): Promise<Harness> {
    const h = new Harness(inputs);
    const init = await h.contract.initialState(
      createConstructorContext({}, COIN_PUBLIC_KEY),
    );
    // `initialState` hands back a ContractState, whose ledger lives under `.data`; a circuit hands
    // back the ChargedState itself. Normalising here means `ledger` below has one shape to handle.
    // Without this, reading the ledger before the first circuit call throws — which no test happened
    // to do, so the inconsistency sat here harmlessly until the compliance suite hit it.
    h.state = init.currentContractState.data;
    return h;
  }

  /** The ledger as the chain would see it. */
  get ledger(): Transfer.Ledger {
    return Transfer.ledger(this.state as never);
  }

  private context(circuitId: string) {
    return createCircuitContext(circuitId, CONTRACT_ADDRESS, COIN_PUBLIC_KEY, this.state as never, {});
  }

  /** Publish a note commitment, advancing the ledger. */
  async deposit(amount: bigint, ownerPk: Uint8Array, rho: Uint8Array): Promise<Uint8Array> {
    const res = await this.contract.impureCircuits.deposit(this.context('deposit') as never, amount, ownerPk, rho);
    this.state = res.context.callContext.currentQueryContext.state;
    return res.result;
  }

  /** Spend, advancing the ledger. Throws if any assert in the circuit fails. */
  async transfer(currentTime: bigint = NOW): Promise<Uint8Array> {
    const res = await this.contract.impureCircuits.transfer(this.context('transfer') as never, currentTime);
    this.state = res.context.callContext.currentQueryContext.state;
    return res.result;
  }

  /**
   * Deposit the note described by the current inputs and record its membership path.
   *
   * This is the setup every spend test shares: the note must be in the tree, and the path must be
   * the one the circuit will rebuild the commitment from.
   */
  async seedInputNote(): Promise<Uint8Array> {
    const ownerPk = Transfer.pureCircuits.tOwnerPk(this.inputs.spenderSecretKey);
    const commitment = await this.deposit(this.inputs.inputAmount, ownerPk, this.inputs.inputRho);
    this.inputs.inputPath = this.ledger.commitments.findPathForLeaf(commitment);
    return commitment;
  }
}
