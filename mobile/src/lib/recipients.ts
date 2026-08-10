/**
 * Saved beneficiaries ("recipients"). Who you send to — e.g. "Amma · India".
 *
 * Stored on-device. Kept alongside wallet material so a reset wipes it too.
 *
 * A recipient is a name you choose plus the one field that actually moves money: their **pool
 * address**, taken from their own Receive screen. Everything else here is a label for the sender.
 */
import { getSecret, SecureKey, setSecret } from './secure-store';
import { secureRandomHex } from './wallet';

export interface Recipient {
  id: string;
  /** Display name, e.g. "Amma". */
  name: string;
  /**
   * Legacy bank/phone label, e.g. "HDFC ••4821".
   *
   * No longer collected. It existed for a payout leg that does not exist yet — money moves to the
   * pool address below, never to an account number — so asking for it implied a capability the app
   * does not have. Kept optional so recipients saved by earlier builds still read and restore.
   */
  handle?: string;
  /** Destination country label, e.g. "India". */
  country: string;
  createdAt: number;
  /**
   * Shielded-pool payee, captured from the recipient's own Receive screen (QR/paste). Optional so
   * older vault backups — sealed before the pool address existed — still restore cleanly; a
   * recipient without these fields simply cannot be paid privately yet.
   */
  poolOwnerPk?: string;
  poolEncPkX?: string;
  poolEncPkY?: string;
}

export async function listRecipients(): Promise<Recipient[]> {
  const raw = await getSecret(SecureKey.recipients);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Recipient[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeAll(list: Recipient[]): Promise<void> {
  await setSecret(SecureKey.recipients, JSON.stringify(list));
}

export async function addRecipient(input: {
  name: string;
  country?: string;
  poolOwnerPk?: string;
  poolEncPkX?: string;
  poolEncPkY?: string;
}): Promise<Recipient> {
  const list = await listRecipients();
  const recipient: Recipient = {
    id: secureRandomHex(8),
    name: input.name.trim(),
    country: (input.country ?? 'India').trim(),
    createdAt: Math.floor(Date.now() / 1000),
    ...(input.poolOwnerPk && input.poolEncPkX && input.poolEncPkY
      ? {
          poolOwnerPk: input.poolOwnerPk,
          poolEncPkX: input.poolEncPkX,
          poolEncPkY: input.poolEncPkY,
        }
      : {}),
  };
  await writeAll([recipient, ...list]);
  return recipient;
}

/** Overwrite the recipient list from a restored backup snapshot (restore flow only). */
export async function restoreRecipients(list: Recipient[]): Promise<void> {
  await writeAll(Array.isArray(list) ? list : []);
}

export async function removeRecipient(id: string): Promise<void> {
  const list = await listRecipients();
  await writeAll(list.filter((r) => r.id !== id));
}

export async function getRecipient(id: string): Promise<Recipient | null> {
  const list = await listRecipients();
  return list.find((r) => r.id === id) ?? null;
}

/** Uppercase initials for an avatar, e.g. "Amma Devi" → "AD". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
