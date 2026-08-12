/**
 * The wallet's own record of what it did — deposits, sends and cash-outs.
 *
 * ## Why this is local and not a server call
 *
 * The obvious place for transaction history is the backend. It cannot live there: the backend never
 * learns an amount, by design, and asking it for "my history" would tell it which notes belong to
 * which user — reconstructing exactly the link the pool exists to break. So the device keeps its own
 * record, written at the moment it acts, and nothing is reported anywhere.
 *
 * ## Why an explicit log rather than deriving it from notes
 *
 * A note on its own cannot say where it came from. A deposit you made and a payment somebody sent
 * you both arrive as an owned note, and the difference matters to the person reading the screen.
 * Recording each action as it happens is the only way to tell them apart honestly; incoming notes
 * that match no action of ours are, by elimination, money received.
 *
 * Stored encrypted, keyed like the note cache. Losing it costs history, never money.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { bytesToUtf8 } from '@noble/ciphers/utils.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import { getSecret, SecureKey, setSecret } from './secure-store';

const DIR_NAME = 'prova';
const FILE_NAME = 'activity.enc';
const STORE_VERSION = 1;
const NONCE_LEN = 12;
/** Entries kept. Old history is nice to have; an unbounded file on a phone is not. */
const MAX_ENTRIES = 500;

export type ActivityKind =
  /** Money moved from the public balance into the pool. */
  | 'added'
  /** A private transfer to somebody else. */
  | 'sent'
  /** A note that arrived and was not one of ours — somebody paid us. */
  | 'received'
  /** Money taken back out to a public address. */
  | 'withdrawn';

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  /** In the app's minor units, matching what balances are rendered in. */
  amountMinor: number;
  /** Unix seconds. */
  at: number;
  /** Who it went to, for a send. Display-only; never leaves the device. */
  counterparty?: string;
  /** Stellar transaction hash, when there is one to link to. */
  txHash?: string;
  /** The note commitment, so an incoming note is not also logged as received. */
  commitment?: string;
  /**
   * Other commitments this action produced — chiefly the change note a send hands back to us.
   * Change is our own money coming home, so it must not surface again as "received".
   */
  relatedCommitments?: string[];
}

interface ActivityStore {
  v: number;
  entries: ActivityEntry[];
}

const EMPTY: ActivityStore = { v: STORE_VERSION, entries: [] };

function storeFile(): File {
  const dir = new Directory(Paths.document, DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return new File(dir, FILE_NAME);
}

/** Reuses the note cache's key: both protect rebuildable local data, neither is backed up. */
async function fileKey(): Promise<Uint8Array> {
  let hex = await getSecret(SecureKey.noteStoreKey);
  if (!hex) {
    hex = bytesToHex(Crypto.getRandomBytes(32));
    await setSecret(SecureKey.noteStoreKey, hex);
  }
  return hexToBytes(hex);
}

async function readStore(): Promise<ActivityStore> {
  const file = storeFile();
  if (!file.exists) return { ...EMPTY };
  try {
    const raw = hexToBytes(await file.text());
    const plain = gcm(await fileKey(), raw.slice(0, NONCE_LEN)).decrypt(raw.slice(NONCE_LEN));
    const parsed = JSON.parse(bytesToUtf8(plain)) as ActivityStore;
    if (parsed.v !== STORE_VERSION) return { ...EMPTY };
    return parsed;
  } catch {
    // History is a convenience, not a source of truth about money. Starting clean beats refusing
    // to open the screen.
    return { ...EMPTY };
  }
}

async function writeStore(store: ActivityStore): Promise<void> {
  const nonce = Crypto.getRandomBytes(NONCE_LEN);
  const ciphertext = gcm(await fileKey(), nonce).encrypt(utf8ToBytes(JSON.stringify(store)));
  const blob = new Uint8Array(nonce.length + ciphertext.length);
  blob.set(nonce, 0);
  blob.set(ciphertext, nonce.length);
  const file = storeFile();
  if (!file.exists) file.create();
  file.write(bytesToHex(blob));
}

/** Newest first. */
export async function listActivity(): Promise<ActivityEntry[]> {
  const { entries } = await readStore();
  return [...entries].sort((a, b) => b.at - a.at);
}

/** Append an entry. Returns it so callers can log the id if they need to. */
export async function recordActivity(
  entry: Omit<ActivityEntry, 'id' | 'at'> & { at?: number },
): Promise<ActivityEntry> {
  const store = await readStore();
  const full: ActivityEntry = {
    ...entry,
    id: bytesToHex(Crypto.getRandomBytes(8)),
    at: entry.at ?? Math.floor(Date.now() / 1000),
  };
  store.entries = [full, ...store.entries].slice(0, MAX_ENTRIES);
  await writeStore(store);
  return full;
}

/**
 * Log notes that arrived without a matching action of ours as money received.
 *
 * Called after a scan. A commitment we already recorded — our own deposit, or our own change note
 * coming back from a send — is skipped, so nothing is counted twice.
 */
export async function recordIncoming(
  notes: { commitment: string; amount: number; seenAt: number }[],
  toMinor: (stroops: number) => number,
): Promise<number> {
  if (notes.length === 0) return 0;
  const store = await readStore();
  const known = new Set<string>();
  for (const e of store.entries) {
    if (e.commitment) known.add(e.commitment);
    for (const c of e.relatedCommitments ?? []) known.add(c);
  }

  const fresh = notes
    .filter((n) => !known.has(n.commitment))
    .map<ActivityEntry>((n) => ({
      id: bytesToHex(Crypto.getRandomBytes(8)),
      kind: 'received',
      amountMinor: toMinor(n.amount),
      at: n.seenAt,
      commitment: n.commitment,
    }));

  if (fresh.length === 0) return 0;
  store.entries = [...fresh, ...store.entries].slice(0, MAX_ENTRIES);
  await writeStore(store);
  return fresh.length;
}

/**
 * How one entry is labelled, shared by every screen that lists activity.
 *
 * Kept in the data layer rather than in a screen so Home and the Activity tab cannot describe the
 * same transaction differently — which is exactly what happened when Home read the server's
 * transfer list and Activity read this one.
 */
export function describeActivity(kind: ActivityKind): {
  label: string;
  sign: string;
  positive: boolean;
} {
  switch (kind) {
    case 'added':
      return { label: 'Added to private balance', sign: '+', positive: true };
    case 'received':
      return { label: 'Received', sign: '+', positive: true };
    case 'withdrawn':
      return { label: 'Cashed out', sign: '\u2212', positive: false };
    case 'sent':
    default:
      return { label: 'Sent privately', sign: '\u2212', positive: false };
  }
}

/** Wipe history (wallet reset / sign-out). */
export async function clearActivity(): Promise<void> {
  await writeStore({ ...EMPTY });
}
