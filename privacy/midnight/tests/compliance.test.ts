import { describe, it, expect } from 'vitest';
import {
  createConstructorContext,
  createCircuitContext,
} from '@midnight-ntwrk/compact-runtime';
import * as Compliance from '../build/contract/index.js';
import { COIN_PUBLIC_KEY, CONTRACT_ADDRESS, bytes32, hex, NOW, REQUIRED_KYC } from './harness.js';

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

/**
 * The secret behind the deployed policy authority, and its commitment.
 *
 * The contract stores only the commitment; holding `POLICY_SECRET` is what authorises a change.
 * Deriving it through the contract's own exported circuit rather than rehashing it here is the
 * point — if the two ever disagreed, the tests would agree with themselves and not with the chain.
 */
const POLICY_SECRET = bytes32(77);
const POLICY_COMMITMENT = Compliance.pureCircuits.policyCommitment(POLICY_SECRET);

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

  static async create(
    cred: Credential = validCredential(),
    minKyc: bigint = REQUIRED_KYC,
    authority: Uint8Array = POLICY_COMMITMENT,
  ): Promise<ComplianceHarness> {
    const h = new ComplianceHarness(cred);
    const init = await h.contract.initialState(
      createConstructorContext({}, COIN_PUBLIC_KEY),
      authority,
      minKyc,
    );
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
  // An earlier version of these tests could only probe the boundary at 0, because the contract had
  // no constructor and its minimum was stuck there permanently. They now sweep several thresholds,
  // which is what actually pins `>=`: at every level, exactly-the-minimum passes and one below
  // fails. A `>` would break the first half of that at every single threshold.
  for (const minimum of [0n, 1n, 3n, 255n]) {
    it(`accepts a credential at exactly the minimum (${minimum})`, async () => {
      const h = await ComplianceHarness.create(validCredential(), minimum);
      expect(h.ledger.minKycLevel).toBe(minimum);

      h.cred.kycLevel = minimum;
      await expect(h.proveEligibility()).resolves.toBeDefined();
    });

    if (minimum > 0n) {
      it(`rejects a credential one level below the minimum (${minimum})`, async () => {
        const h = await ComplianceHarness.create(validCredential(), minimum);
        h.cred.kycLevel = minimum - 1n;
        await expect(h.proveEligibility()).rejects.toThrow(/KYC level below the required minimum/);
      });
    }
  }

  it('accepts a credential above the minimum level', async () => {
    const h = await ComplianceHarness.create(validCredential(), 2n);
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
  // This test could not exist before the constructor. With `policyAuthority` defaulting to 32 zero
  // bytes, no credential could ever satisfy the check, so the *authorised* path was unreachable and
  // only the rejection could be tested. A policy that can never be changed is not a policy either.
  it('lets the holder of the policy secret change the minimum', async () => {
    const h = await ComplianceHarness.create();
    expect(h.ledger.minKycLevel).toBe(REQUIRED_KYC);

    h.cred.userId = POLICY_SECRET;
    await h.setMinKycLevel(4n);
    expect(h.ledger.minKycLevel).toBe(4n);
  });

  it('lets the policy be lowered as well as raised', async () => {
    // Corridors relax as well as tighten; a one-way ratchet would be a different contract.
    const h = await ComplianceHarness.create(validCredential(), 5n);
    h.cred.userId = POLICY_SECRET;
    await h.setMinKycLevel(2n);
    expect(h.ledger.minKycLevel).toBe(2n);
  });

  it('actually changes who is eligible', async () => {
    // The point of the whole mechanism: raising the bar must exclude someone it previously admitted.
    // Without this, `setMinKycLevel` could write to a field nothing reads and every other test here
    // would still pass.
    const h = await ComplianceHarness.create(validCredential(), 1n);
    h.cred.kycLevel = 3n;
    await expect(h.proveEligibility()).resolves.toBeDefined();

    h.cred.userId = POLICY_SECRET;
    await h.setMinKycLevel(4n);

    h.cred.userId = bytes32(11);
    h.cred.kycLevel = 3n;
    await expect(h.proveEligibility()).rejects.toThrow(/KYC level below the required minimum/);
  });

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

describe('deployed state — what the constructor actually establishes', () => {
  // These replace a block that pinned the *broken* defaults: with no constructor, `minKycLevel` and
  // `policyAuthority` both started at zero, which admitted every credential and locked the policy
  // permanently — a compliance layer enforcing nothing, with no way to fix it after deployment.
  //
  // Keeping those tests green would have meant keeping the bug. They are replaced rather than
  // removed, so the same facts are still asserted, now about a contract that works.

  it('stores exactly the policy it was deployed with', async () => {
    const h = await ComplianceHarness.create();
    expect(h.ledger.minKycLevel).toBe(REQUIRED_KYC);
    expect(hex(h.ledger.policyAuthority)).toBe(hex(POLICY_COMMITMENT));
  });

  it('never leaves the authority at the unreachable zero default', async () => {
    // The specific regression. 32 zero bytes is not an open door but a sealed one — nothing hashes
    // to it, so `setMinKycLevel` could never be called by anyone. This asserts the deployed contract
    // is not in that state.
    const h = await ComplianceHarness.create();
    expect(hex(h.ledger.policyAuthority)).not.toBe('00'.repeat(32));
  });

  it('rejects the weakest credential at the deployed minimum', async () => {
    // The corridor deploys at 1, not 0, so level 0 is a case the circuit genuinely refuses. At the
    // old default this was impossible to demonstrate: every credential passed.
    const h = await ComplianceHarness.create();
    h.cred.kycLevel = 0n;
    await expect(h.proveEligibility()).rejects.toThrow(/KYC level below the required minimum/);
  });

  it('can still be deployed permissively, if that is deliberate', async () => {
    // A minimum of 0 remains expressible — it is now a choice made at deploy time rather than a
    // default nobody picked. That distinction is the whole fix.
    const h = await ComplianceHarness.create(validCredential(), 0n);
    h.cred.kycLevel = 0n;
    await expect(h.proveEligibility()).resolves.toBeDefined();
  });
});
