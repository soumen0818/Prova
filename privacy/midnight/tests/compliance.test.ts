import { describe, it, expect } from 'vitest';
import {
  createConstructorContext,
  createCircuitContext,
} from '@midnight-ntwrk/compact-runtime';
import * as Compliance from '../build/contract/index.js';
import { COIN_PUBLIC_KEY, CONTRACT_ADDRESS, bytes32, hex, NOW } from './harness.js';

// Prova — the eligibility circuit, executed.
//
// This proves the same statement as `spend.rs` §9 on Soroban: the credential is valid, unexpired,
// and at or above the corridor's minimum. The tests below are the boundary cases, plus what the
// circuit refuses.

interface Credential {
  userId: Uint8Array;
  kycLevel: bigint;
  expiry: bigint;
}

const validCredential = (): Credential => ({
  userId: bytes32(11),
  kycLevel: 3n,
  expiry: 2_000_000_000n,
});

class ComplianceHarness {
  cred: Credential;
  private contract: Compliance.Contract<Record<string, never>>;
  private state: unknown;

  private constructor(cred: Credential) {
    this.cred = cred;
    this.contract = new Compliance.Contract({
      credentialUserId: (c: { privateState: Record<string, never> }) => [c.privateState, this.cred.userId],
      credentialKycLevel: (c: { privateState: Record<string, never> }) => [c.privateState, this.cred.kycLevel],
      credentialExpiry: (c: { privateState: Record<string, never> }) => [c.privateState, this.cred.expiry],
    } as never);
  }

  static async create(cred: Credential = validCredential()): Promise<ComplianceHarness> {
    const h = new ComplianceHarness(cred);
    const init = await h.contract.initialState(createConstructorContext({}, COIN_PUBLIC_KEY));
    // `initialState` hands back a ContractState, whose ledger lives under `.data`; a circuit hands
    // back the ChargedState itself. Normalising here means `ledger` below has one shape to handle
    // and tests never have to know which call produced the state they are looking at.
    h.state = init.currentContractState.data;
    return h;
  }

  get ledger(): Compliance.Ledger {
    return Compliance.ledger(this.state as never);
  }

  private context(id: string) {
    return createCircuitContext(id, CONTRACT_ADDRESS, COIN_PUBLIC_KEY, this.state as never, {});
  }

  async proveEligibility(currentTime: bigint = NOW): Promise<Uint8Array> {
    const res = await this.contract.impureCircuits.proveEligibility(this.context('proveEligibility') as never, currentTime);
    this.state = res.context.callContext.currentQueryContext.state;
    return res.result;
  }

  async setMinKycLevel(level: bigint): Promise<void> {
    const res = await this.contract.impureCircuits.setMinKycLevel(this.context('setMinKycLevel') as never, level);
    this.state = res.context.callContext.currentQueryContext.state;
  }
}

describe('proveEligibility', () => {
  it('accepts a valid, unexpired credential', async () => {
    const h = await ComplianceHarness.create();
    await expect(h.proveEligibility()).resolves.toBeDefined();
  });

  it('rejects an expired credential', async () => {
    const h = await ComplianceHarness.create();
    h.cred.expiry = NOW - 1n;
    await expect(h.proveEligibility()).rejects.toThrow(/credential has expired/);
  });

  it('accepts a credential expiring exactly now', async () => {
    // `>=`. A credential valid through this second is valid.
    const h = await ComplianceHarness.create();
    h.cred.expiry = NOW;
    await expect(h.proveEligibility()).resolves.toBeDefined();
  });

  // The level boundary — `>=`, not `>` — is the check the Soroban circuit has a dedicated test for.
  // Getting it wrong silently excludes every user sitting precisely at the threshold, which is the
  // largest group, since anchors issue the minimum that satisfies the corridor.
  //
  // These cannot raise the minimum first: `policyAuthority` defaults to 32 zero bytes and no
  // reachable credential hashes to it (see the deployed-defaults block below), so a fresh contract's
  // minimum is stuck at 0. The boundary is therefore exercised at the only threshold a deployed
  // contract actually has. This is a real limitation of the current contract, not of the test —
  // when a constructor sets the authority, these should be rewritten to sweep a raised minimum.
  it('accepts a credential at exactly the minimum level', async () => {
    const h = await ComplianceHarness.create();
    expect(h.ledger.minKycLevel).toBe(0n);

    h.cred.kycLevel = 0n;
    await expect(h.proveEligibility()).resolves.toBeDefined();
  });

  it('accepts a credential above the minimum level', async () => {
    const h = await ComplianceHarness.create();
    h.cred.kycLevel = 5n;
    await expect(h.proveEligibility()).resolves.toBeDefined();
  });

  it('binds the returned commitment to the credential and the time', async () => {
    // The commitment is what lets a Midnight eligibility proof be tied to the Soroban spend it
    // authorises. If it did not vary with the credential, the proof would only say "some valid
    // credential exists", which is a different and much weaker claim.
    const a = await ComplianceHarness.create();
    const first = await a.proveEligibility(NOW);

    const b = await ComplianceHarness.create();
    b.cred.userId = bytes32(12);
    const other = await b.proveEligibility(NOW);
    expect(hex(other)).not.toBe(hex(first));

    // And it varies with time, so an old proof is not byte-identical to a fresh one and cannot be
    // replayed as one.
    const c = await ComplianceHarness.create();
    const later = await c.proveEligibility(NOW + 1n);
    expect(hex(later)).not.toBe(hex(first));
  });

  it('is deterministic for the same credential at the same time', async () => {
    const a = await ComplianceHarness.create();
    const b = await ComplianceHarness.create();
    expect(hex(await a.proveEligibility(NOW))).toBe(hex(await b.proveEligibility(NOW)));
  });
});

describe('setMinKycLevel', () => {
  it('rejects a caller who does not know the policy secret', async () => {
    const h = await ComplianceHarness.create();
    // The authority is a commitment; this credential does not hash to it.
    h.cred.userId = bytes32(99);
    await expect(h.setMinKycLevel(5n)).rejects.toThrow(/not authorised to change policy/);
  });

  it('leaves the policy unchanged after a rejected attempt', async () => {
    const h = await ComplianceHarness.create();
    const before = h.ledger.minKycLevel;
    h.cred.userId = bytes32(99);
    await expect(h.setMinKycLevel(5n)).rejects.toThrow();
    expect(h.ledger.minKycLevel).toBe(before);
  });
});

describe('deployed defaults — what an uninitialised contract actually permits', () => {
  // Neither `minKycLevel` nor `policyAuthority` has a constructor, so both start at zero. That is
  // not a bug in the circuits, but it is a live deployment hazard, and it is the kind of thing that
  // is invisible until something executes. These tests pin the real behaviour so that when a
  // constructor is added, they fail and have to be revisited deliberately.

  it('admits any credential, because the default minimum is zero', async () => {
    const h = await ComplianceHarness.create();
    expect(h.ledger.minKycLevel).toBe(0n);

    // A level-0 credential — the weakest expressible — satisfies a freshly deployed corridor.
    h.cred.kycLevel = 0n;
    await expect(h.proveEligibility()).resolves.toBeDefined();
  });

  it('locks the policy permanently, because the default authority is unreachable', async () => {
    // `policyAuthority` defaults to 32 zero bytes — a value nobody chose and, being a hash preimage
    // problem, one nobody can produce a credential for.
    //
    // The good news: a fresh deployment cannot be seized. I expected the opposite — that the zero
    // default would be trivially claimable — and checked instead of assuming. `bytes32(0)` does not
    // hash to zero, and finding a userId that does means inverting `persistentHash`.
    //
    // The bad news is the same fact from the other side: the minimum is frozen at 0 forever. The
    // contract cannot enforce any corridor policy at all, and there is no path to fixing it after
    // deployment. That combination — permissive default, unchangeable — is the part that matters
    // before this goes near a testnet.
    const h = await ComplianceHarness.create();
    expect(hex(h.ledger.policyAuthority)).toBe('00'.repeat(32));

    h.cred.userId = bytes32(0);
    await expect(h.setMinKycLevel(4n)).rejects.toThrow(/not authorised to change policy/);
    expect(h.ledger.minKycLevel).toBe(0n);
  });
});
