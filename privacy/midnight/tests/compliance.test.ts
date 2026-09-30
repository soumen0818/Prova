import { describe, expect, it } from 'vitest';
import {
  createCircuitContext,
  createConstructorContext,
  ecMulGenerator,
  type CircuitContext,
  type JubjubPoint,
} from '@midnight-ntwrk/compact-runtime';
import * as Compliance from '../build/contract/index.js';
import { bytes32, COIN_PUBLIC_KEY, CONTRACT_ADDRESS, hex, NOW, REQUIRED_KYC } from './harness.js';

const JUBJUB_ORDER =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;
const TWO_248 =
  452312848583266388373324160190187140051835877600158453279131187530910662656n;

const POLICY_SECRET = bytes32(77);
const POLICY_COMMITMENT = Compliance.pureCircuits.policyCommitment(POLICY_SECRET);
const HOLDER_SECRET = bytes32(11);
const CREDENTIAL_ID = bytes32(22);
const ISSUER_SK = 123_456_789n;
const ISSUER_PK = ecMulGenerator(ISSUER_SK);
const ATTACKER_SK = 987_654_321n;
const EXPIRY = 2_000_000_000n;
const NULLIFIER = bytes32(33);

interface PrivateState {
  credential: Compliance.ComplianceCredential;
  holderSecret: Uint8Array;
  policySecret: Uint8Array;
}

const sign = (
  issuerSecret: bigint,
  message: bigint[],
  nonce: bigint = 424_242n,
): Compliance.Schnorr_SchnorrSignature => {
  const publicKey = ecMulGenerator(issuerSecret);
  const announcement = ecMulGenerator(nonce);
  const fullChallenge = Compliance.pureCircuits.schnorrChallenge(
    announcement.x,
    announcement.y,
    publicKey.x,
    publicKey.y,
    message,
  );
  const challenge = fullChallenge % TWO_248;
  const response = (nonce + challenge * issuerSecret) % JUBJUB_ORDER;
  return { announcement, response };
};

const issueCredential = (
  holderSecret: Uint8Array = HOLDER_SECRET,
  issuerSecret: bigint = ISSUER_SK,
  kycLevel: bigint = 3n,
  expiry: bigint = EXPIRY,
  credentialId: Uint8Array = CREDENTIAL_ID,
): Compliance.ComplianceCredential => {
  const userId = Compliance.pureCircuits.credentialUserId(holderSecret);
  const message = Compliance.pureCircuits.credentialMessage(
    userId,
    kycLevel,
    expiry,
    credentialId,
  );
  return {
    userId,
    kycLevel,
    expiry,
    credentialId,
    signature: sign(issuerSecret, message),
  };
};

const defaultWitnesses: Compliance.Witnesses<PrivateState> = {
  complianceCredential: ({ privateState }) => [privateState, privateState.credential],
  credentialHolderSecret: ({ privateState }) => [privateState, privateState.holderSecret],
  policySecret: ({ privateState }) => [privateState, privateState.policySecret],
  getSchnorrReduction: ({ privateState }, challengeHash) => [
    privateState,
    [challengeHash / TWO_248, challengeHash % TWO_248],
  ],
};

class ComplianceHarness {
  readonly contract: Compliance.Contract<PrivateState>;
  context: CircuitContext<PrivateState>;

  private constructor(
    credential: Compliance.ComplianceCredential,
    holderSecret: Uint8Array,
    issuer: JubjubPoint,
    minimum: bigint,
    policyTime: bigint,
    witnessOverrides: Partial<Compliance.Witnesses<PrivateState>>,
  ) {
    const privateState: PrivateState = {
      credential,
      holderSecret,
      policySecret: POLICY_SECRET,
    };
    this.contract = new Compliance.Contract({ ...defaultWitnesses, ...witnessOverrides });
    const initial = this.contract.initialState(
      createConstructorContext(privateState, COIN_PUBLIC_KEY),
      POLICY_COMMITMENT,
      issuer,
      minimum,
      policyTime,
    );
    this.context = createCircuitContext(
      CONTRACT_ADDRESS,
      initial.currentZswapLocalState,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  }

  static create({
    credential = issueCredential(),
    holderSecret = HOLDER_SECRET,
    issuer = ISSUER_PK,
    minimum = REQUIRED_KYC,
    policyTime = NOW,
    witnessOverrides = {},
  }: {
    credential?: Compliance.ComplianceCredential;
    holderSecret?: Uint8Array;
    issuer?: JubjubPoint;
    minimum?: bigint;
    policyTime?: bigint;
    witnessOverrides?: Partial<Compliance.Witnesses<PrivateState>>;
  } = {}): ComplianceHarness {
    return new ComplianceHarness(
      credential,
      holderSecret,
      issuer,
      minimum,
      policyTime,
      witnessOverrides,
    );
  }

  get privateState(): PrivateState {
    return this.context.currentPrivateState;
  }

  get ledger(): Compliance.Ledger {
    return Compliance.ledger(this.context.currentQueryContext.state);
  }

  prove(nullifier: Uint8Array = NULLIFIER): Uint8Array {
    const result = this.contract.impureCircuits.proveEligibility(this.context, nullifier);
    this.context = result.context;
    return result.result;
  }

  setMinimum(level: bigint): void {
    this.context = this.contract.impureCircuits.setMinKycLevel(this.context, level).context;
  }

  setPolicyTime(time: bigint): void {
    this.context = this.contract.impureCircuits.setPolicyTime(this.context, time).context;
  }

  setIssuer(issuer: JubjubPoint): void {
    this.context = this.contract.impureCircuits.setCredentialIssuer(this.context, issuer).context;
  }

  resign(issuerSecret: bigint): void {
    const credential = this.privateState.credential;
    const message = Compliance.pureCircuits.credentialMessage(
      credential.userId,
      credential.kycLevel,
      credential.expiry,
      credential.credentialId,
    );
    credential.signature = sign(issuerSecret, message);
  }
}

describe('authenticated eligibility', () => {
  it('accepts a valid issuer-signed credential and records the settlement decision', () => {
    const h = ComplianceHarness.create();
    const expected = Compliance.pureCircuits.settlementDecision(NULLIFIER);
    expect(hex(h.prove())).toBe(hex(expected));
    expect(h.ledger.approvedSettlements.member(expected)).toBe(true);
  });

  it('binds different Stellar nullifiers to different decisions', () => {
    const a = Compliance.pureCircuits.settlementDecision(bytes32(31));
    const b = Compliance.pureCircuits.settlementDecision(bytes32(32));
    expect(hex(a)).not.toBe(hex(b));
  });

  it('rejects replay of the same Stellar settlement', () => {
    const h = ComplianceHarness.create();
    h.prove();
    expect(() => h.prove()).toThrow(/settlement already authorised/);
    expect(h.ledger.approvedSettlements.size()).toBe(1n);
  });

  it('rejects an expired credential using ledger policy time', () => {
    const h = ComplianceHarness.create({ policyTime: EXPIRY + 1n });
    expect(() => h.prove()).toThrow(/credential has expired/);
  });

  it('accepts a credential expiring exactly at policy time', () => {
    const h = ComplianceHarness.create({ policyTime: EXPIRY });
    expect(() => h.prove()).not.toThrow();
  });

  it('rejects a credential below the minimum', () => {
    const h = ComplianceHarness.create({ credential: issueCredential(HOLDER_SECRET, ISSUER_SK, 2n), minimum: 3n });
    expect(() => h.prove()).toThrow(/KYC level below the required minimum/);
  });

  it('accepts a credential exactly at the minimum', () => {
    const h = ComplianceHarness.create({ credential: issueCredential(HOLDER_SECRET, ISSUER_SK, 3n), minimum: 3n });
    expect(() => h.prove()).not.toThrow();
  });

  it('rejects a credential signed by an untrusted issuer', () => {
    const credential = issueCredential(HOLDER_SECRET, ATTACKER_SK);
    const h = ComplianceHarness.create({ credential });
    expect(() => h.prove()).toThrow(/Invalid credential signature/);
  });

  it('rejects a KYC level changed after signing', () => {
    const h = ComplianceHarness.create();
    h.privateState.credential.kycLevel += 1n;
    expect(() => h.prove()).toThrow(/Invalid credential signature/);
  });

  it('rejects an expiry changed after signing', () => {
    const h = ComplianceHarness.create();
    h.privateState.credential.expiry += 1n;
    expect(() => h.prove()).toThrow(/Invalid credential signature/);
  });

  it('rejects a credential id changed after signing', () => {
    const h = ComplianceHarness.create();
    h.privateState.credential.credentialId = bytes32(99);
    expect(() => h.prove()).toThrow(/Invalid credential signature/);
  });

  it('rejects a credential copied to a different holder', () => {
    const h = ComplianceHarness.create({ holderSecret: bytes32(12) });
    expect(() => h.prove()).toThrow(/credential belongs to another holder/);
  });

  it('rejects a non-canonical Schnorr challenge reduction', () => {
    const h = ComplianceHarness.create({
      witnessOverrides: {
        getSchnorrReduction: ({ privateState }, challengeHash) => [
          privateState,
          [116n, challengeHash % TWO_248],
        ],
      },
    });
    expect(() => h.prove()).toThrow(/Schnorr quotient out of range/);
  });

  it('does not put a stable credential identifier in the public decision', () => {
    const first = ComplianceHarness.create({
      credential: issueCredential(HOLDER_SECRET, ISSUER_SK, 3n, EXPIRY, bytes32(41)),
    });
    const otherHolder = bytes32(55);
    const second = ComplianceHarness.create({
      credential: issueCredential(otherHolder, ISSUER_SK, 3n, EXPIRY, bytes32(42)),
      holderSecret: otherHolder,
    });
    expect(hex(first.prove())).toBe(hex(second.prove()));
  });
});

describe('policy administration', () => {
  it('stores the configured authority, issuer, minimum, and policy time', () => {
    const h = ComplianceHarness.create();
    expect(hex(h.ledger.policyAuthority)).toBe(hex(POLICY_COMMITMENT));
    expect(h.ledger.credentialIssuer).toEqual(ISSUER_PK);
    expect(h.ledger.minKycLevel).toBe(REQUIRED_KYC);
    expect(h.ledger.policyTime).toBe(NOW);
  });

  it('lets the policy authority raise the minimum', () => {
    const h = ComplianceHarness.create();
    h.setMinimum(4n);
    expect(h.ledger.minKycLevel).toBe(4n);
    expect(() => h.prove()).toThrow(/KYC level below the required minimum/);
  });

  it('lets the policy authority lower the minimum', () => {
    const h = ComplianceHarness.create({ minimum: 4n });
    h.setMinimum(2n);
    expect(h.ledger.minKycLevel).toBe(2n);
    expect(() => h.prove()).not.toThrow();
  });

  it('rejects a minimum change without the policy secret', () => {
    const h = ComplianceHarness.create();
    h.privateState.policySecret = bytes32(99);
    expect(() => h.setMinimum(4n)).toThrow(/not authorised to change policy/);
    expect(h.ledger.minKycLevel).toBe(REQUIRED_KYC);
  });

  it('advances policy time and expires an old credential', () => {
    const h = ComplianceHarness.create();
    h.setPolicyTime(EXPIRY + 1n);
    expect(h.ledger.policyTime).toBe(EXPIRY + 1n);
    expect(() => h.prove()).toThrow(/credential has expired/);
  });

  it('cannot move policy time backwards', () => {
    const h = ComplianceHarness.create();
    expect(() => h.setPolicyTime(NOW - 1n)).toThrow(/policy time cannot move backwards/);
    expect(h.ledger.policyTime).toBe(NOW);
  });

  it('rotates the issuer and invalidates credentials signed by the old key', () => {
    const h = ComplianceHarness.create();
    const newIssuerSecret = 555_555n;
    h.setIssuer(ecMulGenerator(newIssuerSecret));
    expect(() => h.prove()).toThrow(/Invalid credential signature/);
    h.resign(newIssuerSecret);
    expect(() => h.prove()).not.toThrow();
  });

  it('rejects issuer rotation without the policy secret', () => {
    const h = ComplianceHarness.create();
    h.privateState.policySecret = bytes32(99);
    expect(() => h.setIssuer(ecMulGenerator(555_555n))).toThrow(/not authorised to change policy/);
    expect(h.ledger.credentialIssuer).toEqual(ISSUER_PK);
  });
});
