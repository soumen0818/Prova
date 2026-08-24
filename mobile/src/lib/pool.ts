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
  decodePoolAddress as decodeAddress,
  encodePoolAddress as encodeAddress,
} from '@prova/shared';
import {
  ApiError,
  getPoolNotes,
  getPoolPath,
  getSpentNullifiers,
  relayPoolSpend,
  type PoolNoteRecord,
} from './api';
import { getStoredCredential, isExpired } from './kyc';
import {
  largestSpendableNote,
  markFolded,
  markSpent,
  mergeNotes,
  pendingBalance,
  pendingNotes,
  earliestUnfoldedIndex,
  scanCursor,
  selectNoteFor,
  spendableBalance,
  type OwnedNote,
} from './notes';
import { STROOPS_PER_UNIT } from './onchain';
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
 * Serialise a pool address for a QR code / copy-paste, and parse one back.
 *
 * The format lives in `@prova/shared` because it is a contract between components rather than an app
 * detail — and because it is testable there, which matters for a value that decides where money
 * goes. See `shared/src/address.ts` for the encoding and why it carries a checksum.
 *
 * `decodePoolAddress` accepts addresses written in the older, longer JSON form as well, so
 * recipients saved before the change keep working.
 */
export function encodePoolAddress(addr: Payee): string {
  return encodeAddress(addr);
}

/** Parse a value produced by {@link encodePoolAddress}. Returns `null` for anything else. */
export function decodePoolAddress(text: string): Payee | null {
  return decodeAddress(text);
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
  /**
   * Activity entries that stopped being "processing" in this pass.
   *
   * Reported separately because it is the one outcome with no note behind it: a send that timed out
   * moves from processing to failed without any of the other counts changing, and a caller that
   * refreshes only on those would leave the row spinning forever.
   */
  settled: number;
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
  // Rewind to the earliest note we are still waiting on, so its fold is actually seen. Resuming
  // from the cursor alone left folded notes stuck as "confirming" indefinitely.
  const [cursor, pendingFrom] = await Promise.all([scanCursor(), earliestUnfoldedIndex()]);
  const after = pendingFrom === null ? cursor : Math.min(cursor, pendingFrom);
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

  // Anything we did not put here ourselves is money somebody sent us. Our own deposits and the
  // change from our own sends were already logged with their commitments, so they are skipped.
  const { recordIncoming } = await import('./activity');
  await recordIncoming(owned, (stroops) => Math.floor(stroops / STROOPS_PER_MINOR));

  const newlySpendable = owned.filter((n) => n.leafIndex !== null).length;
  const { newlySpent, settled } = await reconcileSpent();

  return { found: owned.length, newlySpendable, newlySpent, settled };
}

/**
 * Ask the chain which of our notes are already spent, record it, and settle anything still shown as
 * processing.
 *
 * Both halves ask the same question of the same endpoint, so they share one round trip. The nullifier
 * set is also the evidence a pending send needs — it is exactly "did my spend land?" — which is why
 * settling happens here rather than on its own timer.
 */
async function reconcileSpent(): Promise<{ newlySpent: number; settled: number }> {
  const { spendableNotes } = await import('./notes');
  const { pendingActivity, settleAgainstChain } = await import('./activity');

  const [unspent, pending] = await Promise.all([spendableNotes(), pendingActivity()]);

  // A pending send's input note is already marked spent locally, so it is not in `spendableNotes` —
  // its nullifier has to be added explicitly or the entry could never be confirmed.
  const nullifiers = [
    ...new Set(
      [...unspent.map((n) => n.nullifier), ...pending.map((e) => e.nullifier ?? '')].filter(
        Boolean,
      ),
    ),
  ];
  if (nullifiers.length === 0) return { newlySpent: 0, settled: 0 };

  const { spent } = await getSpentNullifiers(nullifiers);
  await markSpent(spent);
  // Still called when nothing came back spent: that is how a send that never landed times out.
  const settled = pending.length > 0 ? await settleAgainstChain(new Set(spent)) : 0;
  return { newlySpent: spent.length, settled };
}

/**
 * Stroops per app minor unit.
 *
 * Two different "smallest units" meet here. On-chain, and therefore inside notes and proofs, amounts
 * are stroops (7 decimals) — the contract verifies the proof against the exact number it transfers.
 * The app's own minor unit is cents-like (exponent 2, see `assetDenomination`), which every balance
 * and limit has used since balances existed. Notes are converted at this boundary rather than
 * changing either convention: raising the app's exponent would reinterpret every stored balance.
 */
const STROOPS_PER_MINOR = STROOPS_PER_UNIT / 100;
/**
 * Minor units in one whole unit, for the display layer.
 *
 * The app renders money with an exponent of 2 while the chain uses 7; every figure shown to a person
 * goes through this. Do not "simplify" it to STROOPS_PER_UNIT — that is the bug that once printed a
 * 1,000 XLM deposit as 100,000,000.
 */

/** Spendable and confirming balances, in the app's minor units. Never conflate the two in the UI. */
export async function poolBalance(): Promise<{
  spendable: number;
  pending: number;
  largestNote: number;
  pendingIsChange: boolean;
}> {
  const [spendable, pending, largest, pendingList] = await Promise.all([
    spendableBalance(),
    pendingBalance(),
    largestSpendableNote(),
    pendingNotes(),
  ]);
  return {
    spendable: Math.floor(spendable / STROOPS_PER_MINOR),
    pending: Math.floor(pending / STROOPS_PER_MINOR),
    // The ceiling on a single transfer. Reported alongside the total so a screen can tell the user
    // what is actually sendable now, rather than letting the circuit refuse it afterwards.
    largestNote: Math.floor(largest / STROOPS_PER_MINOR),
    /*
     * Whether the confirming money is change from our own send rather than money arriving.
     *
     * Purely for wording, and the wording matters more than it looks. Paying 200 from a 900 note
     * returns 700 as change, so the screen shows a number three times the payment with no stated
     * connection to it — which reads as a much larger sum having gone missing. Naming it as change
     * turns an alarming number into an obvious one.
     *
     * `every`, not `some`: the sentence claims all of it is change, so a mixed state (change landing
     * while a deposit is also confirming) has to fall back to the neutral wording.
     */
    pendingIsChange: pendingList.length > 0 && pendingList.every((n) => n.isChange === true),
  };
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
export async function prepareShield(amountMinor: number): Promise<ShieldPlan> {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('Deposit amount must be a positive number of minor units.');
  }
  const keys = await poolIdentity();

  // Everything inside the pool is denominated in the token's own smallest unit, because that is
  // what the contract moves and what it verifies the proof against. Proving in whole units while
  // transferring stroops made the two disagree, and the contract rejected it as InvalidProof.
  const minor = amountMinor * STROOPS_PER_MINOR;

  const out = await poolShieldProve({
    amount: minor,
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
    amount: minor,
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
  amountMinor: number,
  onProgress?: (stage: 'proving' | 'approving' | 'submitting') => void,
): Promise<ShieldResult> {
  onProgress?.('proving');
  const plan = await prepareShield(amountMinor);

  onProgress?.('approving');
  const { shieldIntoPool } = await import('./onchain');
  const result = await shieldIntoPool(plan);

  // Written here, not on the next scan, because only this call knows the note was *our deposit*
  // rather than a payment from somebody else. `pending` still counts: the money is on its way, and
  // history that omits it looks like the deposit vanished.
  const { recordActivity } = await import('./activity');
  await recordActivity({
    kind: 'added',
    amountMinor,
    txHash: result.txHash,
    commitment: plan.commitment,
  });

  return result;
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

/**
 * No single note covers the requested amount.
 *
 * Both values are in the app's minor units. The message is deliberately plain: the screen that
 * catches this knows the denomination and formats the numbers, and a currency string assembled down
 * here would be wrong for any build that settles in something else.
 */
export class InsufficientFunds extends Error {
  constructor(
    readonly requestedMinor: number,
    readonly largestNoteMinor: number,
  ) {
    super(
      largestNoteMinor > 0
        ? 'This is more than can be sent in one transfer.'
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
  amountMinor: number,
  payee: Payee,
  onProgress?: (stage: 'selecting' | 'proving' | 'submitting') => void,
  /** Shown in the user's own history only; never transmitted. */
  counterparty?: string,
): Promise<string> {
  return spend({ amountMinor, payee, onProgress, kind: 'sent', counterparty });
}

/**
 * Cash out `amount` to a public Stellar destination.
 *
 * `destinationField` is the field element the contract binds the payout to — fetch it from the
 * contract's `destination_field` view for the address being paid. It is bound inside the proof, so
 * nobody (including the relayer) can redirect the payment.
 */
export async function cashOut(
  amountMinor: number,
  destination: string,
  destinationField: string,
  onProgress?: (stage: 'selecting' | 'proving' | 'submitting') => void,
): Promise<string> {
  const keys = await poolIdentity();
  // The change note comes back to us; nothing is paid to a third party inside the pool.
  const self: Payee = { ownerPk: keys.owner_pk, encPkX: keys.enc_pk_x, encPkY: keys.enc_pk_y };
  return spend({
    amountMinor,
    payee: self,
    publicMinorUnits: amountMinor,
    destination,
    destinationField,
    onProgress,
    kind: 'withdrawn',
    counterparty: destination,
  });
}

interface SpendArgs {
  /** In the app's minor units (exponent 2), matching what every screen displays. */
  amountMinor: number;
  payee: Payee;
  /** > 0 for an unshield, in the same minor units. */
  publicMinorUnits?: number;
  destination?: string;
  destinationField?: string;
  onProgress?: (stage: 'selecting' | 'proving' | 'submitting') => void;
  /** How this spend is described in the user's own local history. */
  kind: 'sent' | 'withdrawn';
  counterparty?: string;
}

/** The shared path behind both a private transfer and a cash-out. */
async function spend(args: SpendArgs): Promise<string> {
  const {
    amountMinor,
    payee,
    publicMinorUnits = 0,
    destination,
    destinationField,
    onProgress,
    kind,
    counterparty,
  } = args;
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('Amount must be a positive number of minor units.');
  }

  onProgress?.('selecting');
  const keys = await poolIdentity();

  // Notes hold the token's smallest unit (see prepareShield), while callers speak the app's minor
  // units. Convert once, here, before selecting a note and before the change arithmetic below —
  // mixing the two would silently pick the wrong note.
  const amountStroops = amountMinor * STROOPS_PER_MINOR;
  const publicStroops = publicMinorUnits * STROOPS_PER_MINOR;

  // One input note only — the spend circuit is 1-in-2-out. If no single note covers the amount we
  // surface that specifically, because "insufficient funds" would be misleading when the balance is
  // there but fragmented.
  const input = await selectNoteFor(amountStroops);
  if (!input) {
    const { spendableNotes } = await import('./notes');
    const notes = await spendableNotes();
    const largest = notes.reduce((m, n) => Math.max(m, n.amount), 0);
    throw new InsufficientFunds(amountMinor, Math.floor(largest / STROOPS_PER_MINOR));
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
  const change = input.amount - amountStroops;
  const recipientAmount = publicStroops > 0 ? 0 : amountStroops;
  // Held rather than generated inline: this is the nonce of our own change note, and we need it to
  // record that note locally the moment the spend lands.
  const changeRho = secureRandomHex(32);

  /*
   * ONE timestamp, used by both the proof and the submission.
   *
   * `current_time` is public input #9 of the spend circuit. The wallet binds it into the proof, and
   * the contract rebuilds the input list from the value the relayer submits — so the two must be the
   * same integer or the pairing check simply returns false.
   *
   * This was previously two separate `Date.now()` calls with the whole Groth16 proving run between
   * them. Proving is the heaviest thing the wallet does — tens of seconds on a phone — so the second
   * sample was never the same second as the first, and every private transfer was rejected on-chain
   * with `Error(Contract, #4)`. It reads as a proof failure, which sent debugging towards the keys
   * and the anchor; the proof was fine and the public input was not.
   */
  const currentTime = Math.floor(Date.now() / 1000);

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
      rho: changeRho,
      enc_pk_x: keys.enc_pk_x,
      enc_pk_y: keys.enc_pk_y,
    },
    esk: secureRandomHex(32),
    public_amount: publicStroops,
    destination: destinationField ?? '',
    kyc_level: credential.kycLevel,
    expiry: credential.expiry,
    sig_rx: credential.signature.rX,
    sig_ry: credential.signature.rY,
    sig_s: credential.signature.s,
    anchor_pk_x: credential.anchor.x,
    anchor_pk_y: credential.anchor.y,
    current_time: currentTime,
  });

  onProgress?.('submitting');

  /*
   * The activity entry is written BEFORE the relay, not after.
   *
   * It used to be written only once a txHash came back, which meant a payment that failed — or one
   * whose reply was lost — left no trace at all. Someone would watch a spinner, get an error, return
   * to a home screen showing nothing, and have no way to tell whether their money had moved. The
   * only honest record of an attempt is one made at the moment of attempting.
   *
   * It carries the input nullifier so it can settle itself later: the chain publishes that nullifier
   * when the note is spent, so `settleAgainstChain` can answer "did it land?" from the spent set the
   * scan already fetches — no server ever learns we are the one asking.
   */
  const { recordActivity, updateActivity } = await import('./activity');
  const logged = await recordActivity({
    kind,
    amountMinor,
    counterparty,
    // Both output commitments, because logging c2 — our own change coming home — is what stops the
    // next scan announcing it as money received.
    commitment: proof.out_c1,
    relatedCommitments: [proof.out_c2],
    // The prover's nullifier, not the note cache's copy. They agree, but this one is derived from
    // the exact witness that was proved, so it is the value the contract will publish — and the
    // whole point of storing it is to compare it against what the chain publishes.
    nullifier: proof.nullifier,
    status: 'pending',
  });

  let txHash: string;
  try {
    ({ txHash } = await relayPoolSpend({
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
      // Must be the exact value bound into the proof above — see the note on `currentTime`.
      currentTime,
      ...(publicStroops > 0 ? { amount: publicStroops, destination } : {}),
    }));
  } catch (e) {
    /*
     * Two different failures, and treating them alike is what strands people.
     *
     * A server that answered — any real HTTP status — has told us it did not submit. That is final,
     * and the entry becomes `failed` immediately so the screen stops implying money is in flight.
     *
     * A transport failure (`ApiError` with status 0: no reply, aborted, offline) is genuinely
     * unknown. The relay may have submitted and the answer been lost. Calling that failed would
     * invite a second payment for the same thing, so it stays `pending` and lets the chain decide —
     * `settleAgainstChain` will complete it when the nullifier appears, or give up after the
     * timeout.
     */
    const answered = e instanceof ApiError && e.status > 0;
    if (answered) {
      await updateActivity(logged.id, {
        status: 'failed',
        // The server's message, which is written for the person reading it — see poolSpend in
        // backend/internal/server/pool_handlers.go. Never diagnostic output.
        failureReason: e.message,
      });
    }
    throw e;
  }

  await updateActivity(logged.id, { status: 'complete', txHash });

  // Mark the input spent immediately rather than waiting for the next scan, so the balance cannot
  // briefly show money that is already gone. The chain confirms it on the following poll.
  await markSpent([input.nullifier]);

  // Record our own change note at the same time.
  //
  // Without this the balance read **zero** between a send and the next scan: the input was already
  // spent and the change had not yet been trial-decrypted back off the feed. Sending 100 out of
  // 1,100 made the whole balance disappear for up to a scan interval, with nothing shown as
  // confirming to explain it. The wallet generated this note — it does not need to rediscover it.
  if (change > 0) {
    const { addLocalNote, LOCAL_QUEUE_INDEX } = await import('./notes');
    await addLocalNote({
      commitment: proof.out_c2,
      amount: change,
      rho: changeRho,
      // Both are filled in by the scan once the feed catches up; see `mergeNotes`.
      nullifier: '',
      queueIndex: LOCAL_QUEUE_INDEX,
      // Unfolded: real money that cannot move until the folder runs, which is what "confirming"
      // means everywhere else in the app.
      leafIndex: null,
      spent: false,
      seenAt: Math.floor(Date.now() / 1000),
      // Our own change, not money arriving — so the balance screen can say which it is while this
      // note waits to be folded. See `OwnedNote.isChange`.
      isChange: true,
    });
  }

  return txHash;
}
