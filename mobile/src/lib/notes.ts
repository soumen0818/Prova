/**
 * The note store — the wallet's private money (Docs/shielded-pool.md).
 *
 * Balance in the shielded pool is not a number the server can tell you: it is the sum of the notes
 * you own and have not spent. This module is where those notes live.
 *
 * ## Why a file and not the enclave
 *
 * `expo-secure-store` is the right home for the *seed*, but it is a keychain entry — historically
 * rejected above ~2 KB, which is roughly eight notes. So the notes live in an **AES-256-GCM
 * encrypted file** whose key is held in the enclave. Same protection at rest, no size ceiling.
 *
 * ## Why losing it is survivable
 *
 * Every note's contents are also published on-chain, encrypted to its owner. So this file is a
 * **cache**: delete it and the wallet rebuilds by rescanning from the seed alone. That is the whole
 * point of the in-circuit note encryption — it is why a restore needs nothing but the seed phrase.
 * It still deserves encryption at rest, because it reveals amounts and payment history.
 *
 * ## Spendability
 *
 * A note is only spendable once it has been folded into the Merkle tree — a membership proof needs a
 * leaf that exists. Queued notes are real money, but not yet movable, so the UI must show them as
 * confirming rather than available. `spendable()` and `pending()` keep that distinction honest.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { bytesToUtf8 } from '@noble/ciphers/utils.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { Directory, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';

import { getSecret, SecureKey, setSecret } from './secure-store';

const NONCE_LEN = 12; // AES-GCM standard
const STORE_VERSION = 1;
const DIR_NAME = 'prova';
const FILE_NAME = 'notes.enc';

/** A note this wallet owns. */
export interface OwnedNote {
  /** Tree leaf, and the id everything else keys off. */
  commitment: string;
  /** Value in minor units. */
  amount: number;
  /** Per-note nonce; needed to spend, and to rebuild the commitment. */
  rho: string;
  /** Nullifier published when spent. Lets the backend tell us if it is already gone. */
  nullifier: string;
  /** Position in the scan feed — also the wallet's resume cursor. */
  queueIndex: number;
  /**
   * Position in the Merkle tree, or null while still queued.
   *
   * Null means real money that cannot yet move: a spend proves membership, and an unfolded note is
   * not a leaf. Never present these as spendable balance.
   */
  leafIndex: number | null;
  /** True once seen spent on-chain. Kept rather than deleted, so history survives. */
  spent: boolean;
  /** Unix seconds first seen. */
  seenAt: number;
}

interface NoteStore {
  v: number;
  /** Highest queue index scanned, so the next poll resumes instead of restarting. */
  cursor: number;
  notes: OwnedNote[];
}

const EMPTY: NoteStore = { v: STORE_VERSION, cursor: 0, notes: [] };

// ---------------------------------------------------------------------------
// Encrypted file
// ---------------------------------------------------------------------------

function storeFile(): File {
  const dir = new Directory(Paths.document, DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true });
  return new File(dir, FILE_NAME);
}

/**
 * The note-file encryption key, created on first use and kept in the enclave.
 *
 * Deliberately independent of the master seed: this key only protects a rebuildable cache, so it
 * never needs to be backed up or restored. Losing it costs a rescan, not money.
 */
async function fileKey(): Promise<Uint8Array> {
  let hex = await getSecret(SecureKey.noteStoreKey);
  if (!hex) {
    hex = bytesToHex(Crypto.getRandomBytes(32));
    await setSecret(SecureKey.noteStoreKey, hex);
  }
  return hexToBytes(hex);
}

async function readStore(): Promise<NoteStore> {
  const file = storeFile();
  if (!file.exists) return { ...EMPTY };

  try {
    const raw = hexToBytes(await file.text());
    const nonce = raw.slice(0, NONCE_LEN);
    const ciphertext = raw.slice(NONCE_LEN);
    const plain = gcm(await fileKey(), nonce).decrypt(ciphertext);
    const parsed = JSON.parse(bytesToUtf8(plain)) as NoteStore;
    if (parsed.v !== STORE_VERSION) return { ...EMPTY };
    return parsed;
  } catch {
    // Tampering, a lost key, or a format change. The notes are all recoverable from chain, so
    // starting clean and rescanning is strictly better than failing to open the wallet.
    return { ...EMPTY };
  }
}

async function writeStore(store: NoteStore): Promise<void> {
  const nonce = Crypto.getRandomBytes(NONCE_LEN);
  const ciphertext = gcm(await fileKey(), nonce).encrypt(utf8ToBytes(JSON.stringify(store)));
  const blob = new Uint8Array(nonce.length + ciphertext.length);
  blob.set(nonce, 0);
  blob.set(ciphertext, nonce.length);

  const file = storeFile();
  if (!file.exists) file.create();
  file.write(bytesToHex(blob));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Every note this wallet knows about, including spent ones. */
export async function allNotes(): Promise<OwnedNote[]> {
  return (await readStore()).notes;
}

/**
 * Notes that can be spent right now: unspent AND folded into the tree.
 *
 * The folded check is not a detail — spending an unfolded note is impossible, and offering it would
 * produce a proof the contract rejects.
 */
export async function spendableNotes(): Promise<OwnedNote[]> {
  const notes = await allNotes();
  return notes.filter((n) => !n.spent && n.leafIndex !== null);
}

/** Notes that are real money but not yet movable — show these as "confirming". */
export async function pendingNotes(): Promise<OwnedNote[]> {
  const notes = await allNotes();
  return notes.filter((n) => !n.spent && n.leafIndex === null);
}

/** Spendable balance in minor units. */
export async function spendableBalance(): Promise<number> {
  return (await spendableNotes()).reduce((sum, n) => sum + n.amount, 0);
}

/** Incoming balance still confirming, in minor units. */
export async function pendingBalance(): Promise<number> {
  return (await pendingNotes()).reduce((sum, n) => sum + n.amount, 0);
}

/** Where the next scan should resume from. */
export async function scanCursor(): Promise<number> {
  return (await readStore()).cursor;
}

/**
 * Merge freshly discovered notes and advance the cursor.
 *
 * Keyed on commitment and idempotent: rescanning the same range must not duplicate a note, or the
 * balance would silently inflate. Known notes keep their existing state and only gain newly-learned
 * facts (a leaf index once folded).
 */
export async function mergeNotes(found: OwnedNote[], cursor: number): Promise<void> {
  const store = await readStore();
  const byCommitment = new Map(store.notes.map((n) => [n.commitment, n]));

  for (const note of found) {
    const existing = byCommitment.get(note.commitment);
    if (!existing) {
      byCommitment.set(note.commitment, note);
      continue;
    }
    byCommitment.set(note.commitment, {
      ...existing,
      // A note becomes folded exactly once; never let a later sighting un-fold it.
      leafIndex: existing.leafIndex ?? note.leafIndex,
      // Spent is one-way too: once gone, always gone.
      spent: existing.spent || note.spent,
    });
  }

  store.notes = [...byCommitment.values()].sort((a, b) => a.queueIndex - b.queueIndex);
  store.cursor = Math.max(store.cursor, cursor);
  await writeStore(store);
}

/**
 * Mark notes spent, by nullifier.
 *
 * Driven by what the chain reports rather than by what this wallet believes it did — that is what
 * keeps a restored wallet from showing already-spent notes as available balance.
 */
export async function markSpent(nullifiers: string[]): Promise<void> {
  if (nullifiers.length === 0) return;
  const spent = new Set(nullifiers);
  const store = await readStore();
  let changed = false;

  store.notes = store.notes.map((n) => {
    if (!n.spent && spent.has(n.nullifier)) {
      changed = true;
      return { ...n, spent: true };
    }
    return n;
  });

  if (changed) await writeStore(store);
}

/** Record leaf indices learned from the feed, making those notes spendable. */
export async function markFolded(leafByCommitment: Map<string, number>): Promise<void> {
  if (leafByCommitment.size === 0) return;
  const store = await readStore();
  let changed = false;

  store.notes = store.notes.map((n) => {
    const leaf = leafByCommitment.get(n.commitment);
    if (n.leafIndex === null && leaf !== undefined) {
      changed = true;
      return { ...n, leafIndex: leaf };
    }
    return n;
  });

  if (changed) await writeStore(store);
}

/**
 * Choose notes to cover `amount`.
 *
 * The spend circuit takes **exactly one** input note, so this looks for a single note that covers
 * the amount rather than a combination. Smallest-sufficient first, which keeps large notes intact
 * for later and limits fragmentation.
 *
 * Returns null when no single note is big enough — even if the total balance is sufficient. That is
 * a real product limitation of the 1-in-2-out design (Docs/shielded-pool.md §6.2), and the UI must
 * say so plainly rather than showing a generic failure. Consolidating requires a 2-in-2-out circuit,
 * which is deliberately out of scope for now.
 */
export async function selectNoteFor(amount: number): Promise<OwnedNote | null> {
  if (amount <= 0) return null;
  const candidates = (await spendableNotes())
    .filter((n) => n.amount >= amount)
    .sort((a, b) => a.amount - b.amount);
  return candidates[0] ?? null;
}

/** Wipe the cache. Safe: everything is recoverable by rescanning from the seed. */
export async function resetNotes(): Promise<void> {
  const file = storeFile();
  if (file.exists) file.delete();
}
