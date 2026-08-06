/**
 * Real (testnet) on-chain wallet flow — the "add money" path when DEPOSIT_MODE = 'anchor'.
 *
 * Steps, each done in order:
 *   1. **Activate** — a brand-new Stellar account must be funded to exist (Friendbot, testnet).
 *   2. **Trustline** — you must opt in to an asset before anyone can send it to you.
 *   3. **Deposit** — the USER authenticates (SEP-10) so the anchor deposits to the user's wallet,
 *      then the anchor's SEP-24 page opens.
 *   4. **Balance** — read the real balance from the chain, not a local counter.
 *
 * Two safety properties:
 *  - the Stellar secret **never leaves the device** — the backend prepares transactions and the
 *    phone signs their 32-byte hash (verified byte-for-byte against the Go SDK);
 *  - **nothing is blind-signed** — every signature goes through `reviewAndSign`, which shows the
 *    server-provided plain-language summary and requires the user to approve first.
 */
import { Alert } from 'react-native';

import {
  completeDeposit,
  fundAccount,
  getAccountState,
  prepareDeposit,
  prepareShieldTx,
  prepareTrustline,
  submitShieldTx,
  submitTrustline,
  type AccountState,
  type DepositResponse,
  type OnChainBalance,
} from './api';
import type { ShieldPlan, ShieldResult } from './pool';
import { env } from '@/config/env';
import { signStellarHash } from './keys';
import { getSecret, SecureKey } from './secure-store';
import { ensureAccount, getStellarAddress } from './wallet';

/**
 * Stellar assets carry 7 decimal places, so contract amounts are in stroops while the app counts
 * whole units. Getting this wrong by a factor of 10^7 is the classic on-chain money bug, so the
 * conversion lives in exactly one place.
 */
const STROOPS_PER_UNIT = 10_000_000;

/**
 * Hex lengths of the Groth16 proof components the contract expects: G1 (96 bytes), G2 (192), G1.
 * `prepareShield` returns them concatenated as `A‖B‖C`.
 */
const PROOF_A_HEX = 96 * 2;
const PROOF_B_HEX = 192 * 2;

/** Raised when the user declines a signing review. */
export class UserRejectedError extends Error {
  constructor() {
    super('rejected');
  }
}

/** Read the master seed (needed to sign), creating the account on first use. */
async function master(): Promise<string> {
  const existing = await getSecret(SecureKey.masterSeed);
  if (existing) return existing;
  await ensureAccount();
  const created = await getSecret(SecureKey.masterSeed);
  if (!created) throw new Error('wallet unavailable');
  return created;
}

async function address(): Promise<string> {
  return (await getStellarAddress()) ?? (await ensureAccount()).address;
}

/**
 * Show the user what they're about to sign and, on approval, sign the hash. This is what turns
 * blind-hash-signing into informed consent (Docs/deposit-flow.md). Rejecting throws
 * `UserRejectedError` so callers can treat it as a cancel, not a failure.
 */
function reviewAndSign(summary: string, hashHex: string, masterHex: string): Promise<string> {
  return new Promise((resolve, reject) => {
    Alert.alert('Approve this action', summary, [
      { text: 'Cancel', style: 'cancel', onPress: () => reject(new UserRejectedError()) },
      { text: 'Approve', onPress: () => resolve(signStellarHash(masterHex, hashHex)) },
    ]);
  });
}

export interface OnChainStatus {
  address: string;
  activated: boolean;
  trusted: boolean;
  assetBalance: string;
  balances: OnChainBalance[];
}

/** Summarise the account's on-chain state for the deposit screen. */
export async function getOnChainStatus(): Promise<OnChainStatus> {
  const addr = await address();
  const state: AccountState = await getAccountState(addr);
  const asset = state.balances.find((b) => b.code === env.depositAsset);
  return {
    address: addr,
    activated: state.exists,
    trusted: asset !== undefined,
    assetBalance: asset?.balance ?? '0',
    balances: state.balances,
  };
}

/** Step 1 — activate the account (testnet Friendbot). */
export async function activateAccount(): Promise<void> {
  await fundAccount(await address());
}

/** Step 2 — establish the trustline: prepare (server) → review + sign (user) → submit (server). */
export async function establishTrustline(): Promise<string> {
  const addr = await address();
  const unsigned = await prepareTrustline(addr);
  const signature = await reviewAndSign(unsigned.summary, unsigned.hash, await master());
  const { hash } = await submitTrustline(unsigned.xdr, addr, signature);
  return hash;
}

/**
 * Move a proved note into the shielded pool: prepare (server) → review + sign (user) → submit.
 *
 * This is the one pool operation the relayer cannot perform. The contract calls
 * `from.require_auth()` and then moves tokens out of the user's account, so only they can authorise
 * it — which is also why Prova never has to custody anyone's funds.
 *
 * The amount is deliberately public here: a deposit is visible on-chain by design. Privacy starts
 * once the value is inside the pool.
 */
export async function shieldIntoPool(plan: ShieldPlan): Promise<ShieldResult> {
  const addr = await address();
  const unsigned = await prepareShieldTx({
    address: addr,
    // The contract takes the token's own units; the app counts whole units.
    amount: plan.amount * STROOPS_PER_UNIT,
    note: {
      commitment: plan.commitment,
      ownerPk: plan.ownerPk,
      epkX: plan.epkX,
      epkY: plan.epkY,
      encAmount: plan.encAmount,
      encRho: plan.encRho,
    },
    proofA: plan.proof.slice(0, PROOF_A_HEX),
    proofB: plan.proof.slice(PROOF_A_HEX, PROOF_A_HEX + PROOF_B_HEX),
    proofC: plan.proof.slice(PROOF_A_HEX + PROOF_B_HEX),
  });
  const signature = await reviewAndSign(unsigned.summary, unsigned.hash, await master());
  const res = await submitShieldTx(unsigned.xdr, addr, signature);
  return { txHash: res.hash, status: res.status };
}

/**
 * Step 3 — the user authenticates (SEP-10) and the deposit starts. The user signs the challenge
 * (after review), so the anchor deposits to the user's own wallet. Returns the anchor URL to open.
 */
export async function startUserDeposit(): Promise<DepositResponse> {
  const addr = await address();
  const challenge = await prepareDeposit(addr);
  const signature = await reviewAndSign(challenge.summary, challenge.hash, await master());
  return completeDeposit({
    address: addr,
    xdr: challenge.xdr,
    webAuth: challenge.webAuth,
    network: challenge.network,
    publicKey: addr,
    signature,
  });
}
