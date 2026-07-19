/**
 * On-device spendable balance.
 *
 * Because the transfer amount is private and never leaves the phone, the balance can't live on a
 * server — the backend never learns amounts. So it's tracked here, in minor units (e.g. fils),
 * credited on deposit and debited on send. On mainnet this is replaced by the real anchor/Stellar
 * balance; on testnet it gives an honest, private spend view.
 */
import { getSecret, SecureKey, setSecret } from './secure-store';
import { env } from '@/config/env';

const MINOR = 100; // 2 decimal places

export async function getBalanceMinor(): Promise<number> {
  const raw = await getSecret(SecureKey.balance);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function setBalanceMinor(minor: number): Promise<void> {
  await setSecret(SecureKey.balance, String(Math.max(0, Math.floor(minor))));
}

/** Credit whole currency units (e.g. AED). Returns the new minor balance. */
export async function credit(units: number): Promise<number> {
  const next = (await getBalanceMinor()) + Math.round(units * MINOR);
  await setBalanceMinor(next);
  return next;
}

/** Debit whole currency units. Throws if there aren't sufficient funds. */
export async function debit(units: number): Promise<number> {
  const current = await getBalanceMinor();
  const cost = Math.round(units * MINOR);
  if (cost > current) throw new Error('Insufficient balance');
  const next = current - cost;
  await setBalanceMinor(next);
  return next;
}

export async function canAfford(units: number): Promise<boolean> {
  return Math.round(units * MINOR) <= (await getBalanceMinor());
}

/** Overwrite the balance from a restored backup snapshot (restore flow only). */
export async function restoreBalanceMinor(minor: number): Promise<void> {
  await setBalanceMinor(minor);
}

/** Whole currency units from a minor balance. */
export function toUnits(minor: number): number {
  return minor / MINOR;
}

/** "AED 1,234.00" style. */
export function formatMinor(minor: number, currency = env.currency): string {
  const value = (minor / MINOR).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency} ${value}`;
}
