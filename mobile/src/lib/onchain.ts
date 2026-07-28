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
  prepareTrustline,
  submitTrustline,
  type AccountState,
  type DepositResponse,
  type OnChainBalance,
} from './api';
import { env } from '@/config/env';
import { signStellarHash } from './keys';
import { getSecret, SecureKey } from './secure-store';
import { ensureAccount, getStellarAddress } from './wallet';

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
