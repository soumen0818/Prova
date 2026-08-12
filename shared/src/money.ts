/**
 * What an amount is denominated in.
 *
 * Prova has two different units, and conflating them is a compliance bug rather than a cosmetic one:
 *
 *   - a **settlement asset** — what the wallet actually holds on Stellar (testnet: `SRT`)
 *   - a **fiat currency** — what a user paid at a licensed anchor (`AED`, `USD`, `GBP`, …)
 *
 * Today only the first exists. `testanchor.stellar.org` is SDF's *reference* anchor and `SRT` is a
 * test token with no bank behind it, so nobody funds in any currency at all — there is no fiat leg
 * to report. The app therefore shows the asset it genuinely holds instead of naming a currency
 * nobody paid in. An asset code has no nationality, so it is equally true for a sender in Dubai and
 * one in New York.
 *
 * When a licensed anchor is integrated, its SEP-24 transaction reports `amount_in_asset`
 * (e.g. `iso4217:AED`). That becomes a `kind: 'fiat'` denomination recorded against the balance,
 * and every screen renders it with no further change. That is the entire reason this travels *with*
 * the balance instead of being a build-time constant: a constant is one answer for every user of a
 * build, and the answer differs per user the moment real rails exist.
 *
 * Mirrors money.go.
 */

/** Whether a denomination is an on-chain asset or a real-world currency. */
export type DenominationKind =
  /** A Stellar asset code — what the wallet holds. Has no country. */
  | 'asset'
  /** An ISO 4217 currency — real money someone actually paid. */
  | 'fiat';

/** The unit an amount is measured in. Always carried alongside the amount, never assumed. */
export interface Denomination {
  /** Stellar asset code (`SRT`) or ISO 4217 currency code (`AED`). */
  code: string;
  kind: DenominationKind;
  /** Decimal places. Drives both minor-unit maths and formatting. */
  exponent: number;
}

/** Decimal places assumed when a code is not listed below. Correct for most ISO 4217 currencies. */
export const DEFAULT_EXPONENT = 2;

/**
 * ISO 4217 currencies whose exponent is **not** 2.
 *
 * This exists because `minor = units * 100` is wrong for a large part of the world: 1000 fils is
 * one Kuwaiti dinar, not ten, and yen has no minor unit at all. Unlisted codes use
 * `DEFAULT_EXPONENT`.
 */
const FIAT_EXPONENTS: Readonly<Record<string, number>> = {
  // Three decimal places.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // No minor unit.
  CLP: 0,
  ISK: 0,
  JPY: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

/**
 * A Stellar asset denomination.
 *
 * The exponent is 2, not Stellar's native 7. The wallet tracks a *spendable* balance in minor units
 * for display and limit checks, and has done so since the balance existed; widening it would change
 * the meaning of every stored balance. On-chain precision is a separate concern handled at the
 * Horizon boundary — do not change this to 7 without migrating stored balances.
 */
export function assetDenomination(code: string): Denomination {
  return { code, kind: 'asset', exponent: 2 };
}

/** A fiat denomination, with the correct ISO 4217 exponent for the code. */
export function fiatDenomination(code: string): Denomination {
  const upper = code.toUpperCase();
  return { code: upper, kind: 'fiat', exponent: FIAT_EXPONENTS[upper] ?? DEFAULT_EXPONENT };
}

/**
 * Parse what a person typed into whole minor units, or `null` if it is not a valid amount.
 *
 * Deliberately string arithmetic, never `Number(text) * 100`. Floating point cannot represent most
 * decimal fractions exactly — `10.07 * 100` is `1006.9999999999999`, which rounds to a different
 * amount of money than the person typed. Splitting on the decimal point and padding keeps every
 * value exact.
 *
 * Rejects more decimals than the denomination has, rather than silently rounding: if someone types
 * 10.005 they should be told it is not a valid amount, not quietly charged 10.00 or 10.01.
 */
export function parseAmountToMinor(input: string, d: Denomination): number | null {
  const text = input.trim();
  if (text === '' || text === '.' || !/^\d*(\.\d*)?$/.test(text)) return null;

  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > d.exponent) return null;

  const minor = Number((whole || '0') + fraction.padEnd(d.exponent, '0'));
  // Beyond this, arithmetic on the value stops being exact — reject rather than lose precision.
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Minor units in one whole unit, e.g. 100 for `AED`, 1 for `JPY`, 1000 for `KWD`. */
export function minorPerUnit(d: Denomination): number {
  return 10 ** d.exponent;
}

/**
 * Structural check for a value coming from untrusted storage — a restored cloud backup or a secure
 * store entry written by an older build. Anything that fails this is treated as "not recorded"
 * rather than trusted, so a corrupt entry degrades to "unknown" instead of mislabelling money.
 */
export function isDenomination(value: unknown): value is Denomination {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Partial<Denomination>;
  return (
    typeof d.code === 'string' &&
    d.code.length > 0 &&
    (d.kind === 'asset' || d.kind === 'fiat') &&
    typeof d.exponent === 'number' &&
    Number.isInteger(d.exponent) &&
    d.exponent >= 0 &&
    d.exponent <= 8
  );
}

/**
 * Render a minor-unit amount in its denomination.
 *
 * Fiat uses the locale's own currency conventions (`$1,234.00`, not `USD 1,234.00`) because showing
 * a US user a code where they expect a symbol reads as broken. Assets keep the code after the
 * number, which is the convention for tokens and avoids implying `SRT` is money.
 *
 * `Intl` currency formatting is unavailable in some JS runtimes and throws on unknown codes, so a
 * plain grouped fallback is always available. Formatting must never be able to crash a balance
 * screen.
 */
export function formatAmount(minor: number, d: Denomination, locale?: string): string {
  const value = minor / minorPerUnit(d);
  const digits = { minimumFractionDigits: d.exponent, maximumFractionDigits: d.exponent };

  if (d.kind === 'fiat') {
    try {
      const fmt = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: d.code,
        ...digits,
      });
      return fmt.format(value);
    } catch {
      // Unknown code, or a runtime built without full-ICU — fall through to the plain form.
    }
  }
  return `${groupedNumber(value, locale, digits)} ${d.code}`;
}

function groupedNumber(
  value: number,
  locale: string | undefined,
  digits: { minimumFractionDigits: number; maximumFractionDigits: number },
): string {
  try {
    return new Intl.NumberFormat(locale, digits).format(value);
  } catch {
    return value.toFixed(digits.maximumFractionDigits);
  }
}
