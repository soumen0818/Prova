/**
 * The shielded pool, from the wallet's side (Docs/shielded-pool.md).
 *
 * Three things a user does — deposit, send, cash out — plus the scan that finds money sent to them.
 * Everything private happens here on the device: the seed derives the keys, the keys open the notes,
 * and the proofs are built natively. The backend only ever sees ciphertext and proofs.
 *
 * ## The ordering rule that shapes the UI
 *
 * A note is not spendable until it has been **folded** into the Merkle tree, because a spend proves
 * membership and an unfolded commitment is not yet a leaf. That takes a few seconds after the
 * transaction lands. Money is never at risk in that window, but it cannot move — so the UI must
 * present those notes as *confirming*, never as available balance. `poolBalance()` returns both
 * numbers precisely so a screen cannot accidentally conflate them.
 */

import { bytesToUtf8 } from '@noble/ciphers/utils.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';

import {
  userId as deriveUserId,
  poolKeys as nativePoolKeys,
  poolScan as nativePoolScan,
  poolShieldProve,
  poolSpendProve,
  poolWarmUp,
  type FoundNote,
  type PoolKeys,
} from '../../modules/prova-prover';
import {
  getPoolNotes,
  getPoolPath,
  getSpentNullifiers,
  relayPoolSpend,
  type PoolNoteRecord,
} from './api';
import { getStoredCredential, isExpired } from './kyc';
import {
  markFolded,
  markSpent,
  mergeNotes,
  pendingBalance,
  scanCursor,
  selectNoteFor,
  spendableBalance,
  type OwnedNote,
} from './notes';
import { getSecret, SecureKey } from './secure-store';
import { secureRandomHex } from './wallet';

/** How many feed entries to pull per scan page. Trial decryption is ~0.4 ms per note. */
const SCAN_PAGE = 200;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

let cachedKeys: PoolKeys | null = null;

/**
 * The wallet's pool keys, derived from the master seed.
 *
 * Cached in memory only. Re-derivation is ~1 ms and the secrets should not be written anywhere but
 * the enclave, so there is nothing to gain from persisting them.
 */
export async function poolIdentity(): Promise<PoolKeys> {
  if (cachedKeys) return cachedKeys;
  const seed = await getSecret(SecureKey.masterSeed);
  if (!seed) throw new Error('No wallet on this device yet.');
  cachedKeys = await nativePoolKeys(seed);
  return cachedKeys;
}

/**
 * The identity the KYC credential must be issued against.
 *
 * The spend circuit derives `user_id = Poseidon(ownerSk, domain)` from the **pool spending key**, not
 * from the older v2 transfer secret. A credential bound to the wrong identity produces a proof the
 * contract rejects, with no clue as to why — so this is the single value the KYC flow must use.
 */
export async function poolUserId(): Promise<string> {
  const k = await poolIdentity();
  return deriveUserId(k.owner_sk);
}

/** Forget the in-memory keys (sign-out, or after a restore changes the seed). */
export function forgetPoolIdentity(): void {
  cachedKeys = null;
}

/**
 * The address to receive money at: where notes go, and how to encrypt them so only this wallet can
 * find them. Reveals nothing about balance or history.
 */
export async function poolAddress(): Promise<{ ownerPk: string; encPkX: string; encPkY: string }> {
  const k = await poolIdentity();
  return { ownerPk: k.owner_pk, encPkX: k.enc_pk_x, encPkY: k.enc_pk_y };
}

/**
 * Serialise a pool address for a QR code / copy-paste, so it can travel outside the app (over chat,
 * a photo, a paste) and still round-trip exactly. Not a secret — this is the "share to get paid"
 * value, equivalent in purpose to a Stellar receive address.
 *
 * Base64 via `@scure/base`, not the global `btoa`/`atob` — unreliable on Hermes, and the rest of the
 * app already standardises on `@scure/base` for this (see `lib/keys.ts`).
 */
export function encodePoolAddress(addr: Payee): string {
  const json = JSON.stringify({ pk: addr.ownerPk, ex: addr.encPkX, ey: addr.encPkY });
  return `prova-pay:${base64.encode(utf8ToBytes(json))}`;
}

/** Parse a value produced by {@link encodePoolAddress}. Returns `null` for anything else. */
export function decodePoolAddress(text: string): Payee | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('prova-pay:')) return null;
  try {
    const json = bytesToUtf8(base64.decode(trimmed.slice('prova-pay:'.length)));
    const parsed = JSON.parse(json) as {
      pk?: unknown;
      ex?: unknown;
      ey?: unknown;
    };
    if (
      typeof parsed.pk !== 'string' ||
      typeof parsed.ex !== 'string' ||
      typeof parsed.ey !== 'string' ||
      !parsed.pk ||
      !parsed.ex ||
      !parsed.ey
    ) {
      return null;
    }
    return { ownerPk: parsed.pk, encPkX: parsed.ex, encPkY: parsed.ey };
  } catch {
    return null;
  }
}

/**
 * Derive the proving keys ahead of time (~1 s).
 *
 * Call once at app start from somewhere the user is not waiting. Skipped silently if the native
 * module is missing, since that only happens in Expo Go where nothing else would work either.
 */
export async function warmUpProver(): Promise<void> {
  try {
    await poolWarmUp();
  } catch {
    // Not fatal: the cost simply lands on the first proof instead.
  }
}

// ---------------------------------------------------------------------------
// Scanning — finding money sent to you
// ---------------------------------------------------------------------------

export interface ScanResult {
  /** Notes discovered in this pass. */
  found: number;
  /** Notes that became spendable (their fold landed). */
  newlySpendable: number;
  /** Notes confirmed spent on-chain. */
  newlySpent: number;
}

/**
 * Pull new notes and work out which are ours.
 *
 * The feed is unfiltered by design — asking the server for "my notes" would tell it who is being
 * paid — so every entry is trial-decrypted locally and what opens is ours. A match is conclusive:
 * the decrypted values must rebuild the exact published commitment.
 *
 * Also reconciles against the chain's spent set, which is what stops a restored wallet counting
 * already-spent notes as balance.
 */
export async function scanForNotes(): Promise<ScanResult> {
  const keys = await poolIdentity();
  const after = await scanCursor();
  const page = await getPoolNotes(after, SCAN_PAGE);

  const candidates = page.notes.map((n: PoolNoteRecord) => ({
    queue_index: n.queueIndex,
    commitment: n.commitment,
    epk_x: n.encrypted.epkX,
    epk_y: n.encrypted.epkY,
    enc_amount: n.encrypted.encAmount,
    enc_rho: n.encrypted.encRho,
    slot: n.encrypted.slot,
  }));

  const found: FoundNote[] = candidates.length
    ? await nativePoolScan(keys.enc_sk, keys.owner_pk, candidates, keys.owner_sk)
    : [];

  // Leaf indices come from the feed, not from decryption — a note's tree position is public.
  const leafByCommitment = new Map<string, number>();
  for (const n of page.notes) {
    if (n.leafIndex !== undefined) leafByCommitment.set(n.commitment, n.leafIndex);
  }

  const now = Math.floor(Date.now() / 1000);
  const owned: OwnedNote[] = found.map((f) => ({
    commitment: f.commitment,
    amount: f.amount,
    rho: f.rho,
    nullifier: f.nullifier,
    queueIndex: f.queue_index,
    leafIndex: leafByCommitment.get(f.commitment) ?? null,
    spent: false,
    seenAt: now,
  }));

  await mergeNotes(owned, page.next);
  await markFolded(leafByCommitment);

  const newlySpendable = owned.filter((n) => n.leafIndex !== null).length;
  const newlySpent = await reconcileSpent();

  return { found: owned.length, newlySpendable, newlySpent };
}

/** Ask the chain which of our notes are already spent, and record it. */
async function reconcileSpent(): Promise<number> {
  const { spendableNotes } = await import('./notes');
  const unspent = await spendableNotes();
  const nullifiers = unspent.map((n) => n.nullifier).filter(Boolean);
  if (nullifiers.length === 0) return 0;

  const { spent } = await getSpentNullifiers(nullifiers);
  await markSpent(spent);
  return spent.length;
}

/** Spendable and confirming balances, in minor units. Never conflate the two in the UI. */
export async function poolBalance(): Promise<{ spendable: number; pending: number }> {
  return { spendable: await spendableBalance(), pending: await pendingBalance() };
}

// ---------------------------------------------------------------------------
// Shield — moving money into the pool
// ---------------------------------------------------------------------------

export interface ShieldPlan {
  /** `A‖B‖C`, hex. */
  proof: string;
  commitment: string;
  ownerPk: string;
  epkX: string;
  epkY: string;
  encAmount: string;
  encRho: string;
  amount: number;
}

/**
 * Prepare a deposit: prove the commitment binds the amount.
 *
 * The proof exists because the contract cannot compute Poseidon and so cannot check the commitment
 * itself — without it a user could deposit 100 while committing to a million and drain the pool.
 *
 * The resulting transaction must be submitted by the **user's own account**, because it moves their
 * tokens and needs their authorisation. That is not a privacy loss: a deposit is public by design.
 */
export async function prepareShield(amount: number): Promise<ShieldPlan> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Deposit amount must be a positive whole number.');
  }
  const keys = await poolIdentity();

  const out = await poolShieldProve({
    amount,
    owner_pk: keys.owner_pk,
    rho: secureRandomHex(32),
    enc_pk_x: keys.enc_pk_x,
    enc_pk_y: keys.enc_pk_y,
    // Fresh per deposit: reusing it would repeat the one-time pad.
    esk: secureRandomHex(32),
  });

  return {
    proof: out.proof,
    commitment: out.commitment,
    ownerPk: keys.owner_pk,
    epkX: out.epk_x,
    epkY: out.epk_y,
    encAmount: out.enc_amount,
    encRho: out.enc_rho,
    amount,
  };
}

/** Outcome of a completed deposit into the pool. */
export interface ShieldResult {
  txHash: string;
  /**
   * `pending` means the transaction was accepted but not yet confirmed. The money may still arrive,
   * so the UI must say "processing" — never "failed", which is what makes someone deposit twice.
   */
  status: 'confirmed' | 'pending';
}

/**
 * Deposit `amount` whole units into the pool: prove, review, sign, submit.
 *
 * The user signs this themselves because the contract moves their own tokens
 * (`from.require_auth()`), so it cannot be relayed like a spend. `reviewAndSign` shows what is being
 * approved first — nothing is blind-signed.
 *
 * The resulting note is **not spendable immediately**: it must be folded into the Merkle tree first
 * (a few seconds). `poolBalance()` reports it as pending until then.
 */
export async function shieldToPool(
  amount: number,
  onProgress?: (stage: 'proving' | 'approving' | 'submitting') => void,
): Promise<ShieldResult> {
  onProgress?.('proving');
  const plan = await prepareShield(amount);

  onProgress?.('approving');
  const { shieldIntoPool } = await import('./onchain');
  return shieldIntoPool(plan);
}

// ---------------------------------------------------------------------------
// Send / cash out — spending
// ---------------------------------------------------------------------------

/** Where a payment is going. */
export interface Payee {
  ownerPk: string;
  encPkX: string;
  encPkY: string;
}

export class InsufficientFunds extends Error {
  constructor(
    readonly requested: number,
    readonly largestNote: number,
  ) {
    super(
      largestNote > 0
        ? `Your balance is split across notes. The largest single note is ${largestNote}, ` +
            `so ${requested} cannot be sent in one payment yet.`
        : 'Not enough spendable balance.',
    );
    this.name = 'InsufficientFunds';
  }
}

/**
 * Send `amount` privately to `payee`, returning the transaction hash.
 *
 * On-chain an observer sees a nullifier and two commitments — not the amount, not the sender, not
 * the recipient. The relayer submits it so this user's Stellar account is never recorded alongside.
 *
 * `onProgress` is called before proving, which takes noticeably longer than everything else: always
 * show it.
 */
export async function sendPrivately(
  amount: number,
  payee: Payee,
  onProgress?: (stage: 'selecting' | 'proving' | 'submitting') => void,
): Promise<string> {
  return spend({ amount, payee, onProgress });
}

/**
 * Cash out `amount` to a public Stellar destination.
 *
 * `destinationField` is the field element the contract binds the payout to — fetch it from the
 * contract's `destination_field` view for the address being paid. It is bound inside the proof, so
 * nobody (including the relayer) can redirect the payment.
 */
export async function cashOut(
  amount: number,
  destination: string,
  destinationField: string,
  onProgress?: (stage: 'selecting' | 'proving' | 'submitting') => void,
): Promise<string> {
  const keys = await poolIdentity();
  // The change note comes back to us; nothing is paid to a third party inside the pool.
  const self: Payee = { ownerPk: keys.owner_pk, encPkX: keys.enc_pk_x, encPkY: keys.enc_pk_y };
  return spend({
    amount,
    payee: self,
    publicAmount: amount,
    destination,
    destinationField,
    onProgress,
  });
}

interface SpendArgs {
  amount: number;
  payee: Payee;
  /** > 0 for an unshield. */
  publicAmount?: number;
  destination?: string;
  destinationField?: string;
  onProgress?: (stage: 'selecting' | 'proving' | 'submitting') => void;
}

/** The shared path behind both a private transfer and a cash-out. */
async function spend(args: SpendArgs): Promise<string> {
  const { amount, payee, publicAmount = 0, destination, destinationField, onProgress } = args;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Amount must be a positive whole number.');
  }

  onProgress?.('selecting');
  const keys = await poolIdentity();

  // One input note only — the spend circuit is 1-in-2-out. If no single note covers the amount we
  // surface that specifically, because "insufficient funds" would be misleading when the balance is
  // there but fragmented.
  const input = await selectNoteFor(amount);
  if (!input) {
    const { spendableNotes } = await import('./notes');
    const notes = await spendableNotes();
    const largest = notes.reduce((m, n) => Math.max(m, n.amount), 0);
    throw new InsufficientFunds(amount, largest);
  }
  if (input.leafIndex === null) {
    throw new Error('That money is still confirming. Try again in a few seconds.');
  }

  const credential = await getStoredCredential();
  if (!credential) {
    throw new Error('A verified identity is required before sending.');
  }
  if (isExpired(credential)) {
    throw new Error('Your verification has expired. Renew it before sending.');
  }
  // The circuit binds the credential to the pool spending key. If they disagree the proof is
  // rejected on-chain with no explanation, so catch it here and say what actually needs doing.
  const expectedUserId = await poolUserId();
  if (credential.userId !== expectedUserId) {
    throw new Error(
      'Your verification is linked to an older wallet identity. Please verify again to send ' +
        'from the private pool.',
    );
  }

  // The path is the private witness proving our note is in the tree. A 409 here means the note is
  // queued but not folded — real money that cannot move yet.
  const path = await getPoolPath(input.commitment);

  // out1 goes to the payee, out2 is the change back to us. An unshield sends its value out publicly,
  // so out1 carries zero and the change still returns here.
  const change = input.amount - amount;
  const recipientAmount = publicAmount > 0 ? 0 : amount;

  onProgress?.('proving');
  const proof = await poolSpendProve({
    in_amount: input.amount,
    in_rho: input.rho,
    owner_sk: keys.owner_sk,
    leaf_index: path.leafIndex,
    siblings: path.siblings,
    root: path.root,
    out1: {
      amount: recipientAmount,
      owner_pk: payee.ownerPk,
      rho: secureRandomHex(32),
      enc_pk_x: payee.encPkX,
      enc_pk_y: payee.encPkY,
    },
    out2: {
      amount: change,
      owner_pk: keys.owner_pk,
      rho: secureRandomHex(32),
      enc_pk_x: keys.enc_pk_x,
      enc_pk_y: keys.enc_pk_y,
    },
    esk: secureRandomHex(32),
    public_amount: publicAmount,
    destination: destinationField ?? '',
    kyc_level: credential.kycLevel,
    expiry: credential.expiry,
    sig_rx: credential.signature.rX,
    sig_ry: credential.signature.rY,
    sig_s: credential.signature.s,
    anchor_pk_x: credential.anchor.x,
    anchor_pk_y: credential.anchor.y,
    current_time: Math.floor(Date.now() / 1000),
  });

  onProgress?.('submitting');
  const { txHash } = await relayPoolSpend({
    proof: proof.proof,
    root: path.root,
    nullifier: proof.nullifier,
    outputs: {
      c1: proof.out_c1,
      c2: proof.out_c2,
      epkX: proof.epk_x,
      epkY: proof.epk_y,
      enc1Amount: proof.enc1_amount,
      enc1Rho: proof.enc1_rho,
      enc2Amount: proof.enc2_amount,
      enc2Rho: proof.enc2_rho,
    },
    currentTime: Math.floor(Date.now() / 1000),
    ...(publicAmount > 0 ? { amount: publicAmount, destination } : {}),
  });

  // Mark the input spent immediately rather than waiting for the next scan, so the balance cannot
  // briefly show money that is already gone. The chain confirms it on the following poll.
  await markSpent([input.nullifier]);
  return txHash;
}
