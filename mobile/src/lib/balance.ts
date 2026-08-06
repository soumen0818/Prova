/**
 * On-device spendable balance.
 *
 * Because the transfer amount is private and never leaves the phone, the balance can't live on a
 * server — the backend never learns amounts. So it's tracked here, in minor units (e.g. fils),
 * credited on deposit and debited on send. On mainnet this is replaced by the real anchor/Stellar
 * balance; on testnet it gives an honest, private spend view.
 *
 * The balance is stored together with its **denomination** (see `@prova/shared/money`). A bare
 * number has no unit, and a unit taken from a build-time constant is one answer for every user of a
 * build — which is wrong the moment senders are not all in one country. So the unit is recorded
 * when money actually arrives, and until then it is genuinely unknown and shown as such.
 */
import {
  assetDenomination,
  formatAmount,
  isDenomination,
  minorPerUnit,
  type Denomination,
} from '@prova/shared';

import { getSecret, SecureKey, setSecret } from './secure-store';
import { env } from '@/config/env';

/**
 * What this build settles in: the on-chain asset the wallet actually holds.
 *
 * Not a currency. `SRT` is SDF's test token — no bank, no fiat, no country. When a licensed anchor
 * is integrated, the deposit records the fiat it reports instead and this stays as the fallback for
 * balances that never went through one.
 */
export function settlementDenomination(): Denomination {
  return assetDenomination(env.depositAsset);
}

export async function getBalanceMinor(): Promise<number> {
  const raw = await getSecret(SecureKey.balance);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

async function setBalanceMinor(minor: number): Promise<void> {
  await setSecret(SecureKey.balance, String(Math.max(0, Math.floor(minor))));
}

/**
 * What the balance is denominated in, or `null` when no money has ever arrived.
 *
 * `null` is a real state, not a missing value: a fresh account has no unit because nothing has been
 * funded yet. Callers must render that as "nothing added yet" rather than substituting a default —
 * printing `AED 0.00` to a user in New York is the exact bug this replaces.
 */
export async function getDenomination(): Promise<Denomination | null> {
  const raw = await getSecret(SecureKey.balanceDenom);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isDenomination(parsed)) return parsed;
    } catch {
      // Corrupt entry — fall through and re-derive below rather than trusting it.
    }
  }
  // A balance written before denominations existed, or restored from an older backup. It was always
  // the settlement asset, so say so; claiming "unknown" would hide money the user really has.
  return (await getBalanceMinor()) > 0 ? settlementDenomination() : null;
}

async function setDenomination(d: Denomination): Promise<void> {
  await setSecret(SecureKey.balanceDenom, JSON.stringify(d));
}

/**
 * Credit whole units of `denom` (defaults to what this build settles in). Returns the new minor
 * balance.
 *
 * Recording the denomination here is the point: this is the moment money becomes real, and the only
 * moment the app can honestly learn what unit it is in.
 */
export async function credit(units: number, denom?: Denomination): Promise<number> {
  const d = denom ?? settlementDenomination();
  const next = (await getBalanceMinor()) + Math.round(units * minorPerUnit(d));
  await setBalanceMinor(next);
  await setDenomination(d);
  return next;
}

/** Debit whole units. Throws if there aren't sufficient funds. */
export async function debit(units: number): Promise<number> {
  const current = await getBalanceMinor();
  const cost = Math.round(units * (await unitScale()));
  if (cost > current) throw new Error('Insufficient balance');
  const next = current - cost;
  await setBalanceMinor(next);
  return next;
}

/** Minor units per whole unit for the current balance. */
async function unitScale(): Promise<number> {
  return minorPerUnit((await getDenomination()) ?? settlementDenomination());
}

/**
 * Balance text for display.
 *
 * `fallback` is what to show when no denomination is known — i.e. nothing has ever been funded.
 * Screens choose their own wording because a balance card can afford a sentence and a stat tile
 * cannot; what they must not do is invent a unit.
 */
export function formatBalance(
  minor: number,
  denom: Denomination | null | undefined,
  fallback = '—',
): string {
  return denom ? formatAmount(minor, denom) : fallback;
}

/**
 * Overwrite the balance from a restored backup snapshot (restore flow only).
 *
 * `denom` is optional because boxes sealed by older builds don't carry one; those balances were the
 * settlement asset, which `getDenomination` infers.
 */
export async function restoreBalanceMinor(
  minor: number,
  denom?: Denomination | null,
): Promise<void> {
  await setBalanceMinor(minor);
  if (denom && isDenomination(denom)) await setDenomination(denom);
}
