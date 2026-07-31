/**
 * Input validation rules — FROZEN, and the single source of truth for **both** the app and the
 * backend (mirrors `validation.go`).
 *
 * ## Why this lives in shared
 *
 * Client-side validation is a courtesy: it makes a form pleasant. Server-side validation is the
 * actual control, because anything can post to the API. Historically each side kept its own copy of
 * the rules, which meant they could drift — and a drift here is a silently rejected sign-up or, in
 * the other direction, junk reaching the database.
 *
 * So the rules live here once, in a form both languages can mirror exactly, and both sides have
 * tests that assert the same cases. Never tighten one side without the other.
 *
 * ## What is NOT validated here
 *
 * Amounts, commitments and proofs. Those are enforced by the circuit and the contract, which is a
 * far stronger guarantee than any string check — see `Docs/shielded-pool.md`.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Email: RFC 5321 caps the whole address at 254 and the local part at 64. */
export const EMAIL_MAX = 254;
export const EMAIL_LOCAL_MAX = 64;

/** Display / legal name. */
export const NAME_MIN = 2;
export const NAME_MAX = 60;

/** One-time codes. */
export const OTP_LENGTH = 6;

/** E.164 allows 15 digits total including the country code; 8 is a sane practical floor. */
export const PHONE_DIGITS_MIN = 8;
export const PHONE_DIGITS_MAX = 15;

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

/**
 * Supported dialling countries.
 *
 * `nationalDigits` is how many digits the user types *after* the dial code. It is per-country
 * because it genuinely differs — India is 10, the UAE is 9 — and a single hardcoded length would
 * reject every valid UAE number, which is half of Prova's corridor.
 *
 * Ordered with the corridor first, since that is what most users need.
 */
export interface Country {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
  /** Dial prefix including '+'. */
  dial: string;
  /** Exact number of national digits expected after the dial code. */
  nationalDigits: number;
  flag: string;
}

export const COUNTRIES: readonly Country[] = [
  { code: 'AE', name: 'United Arab Emirates', dial: '+971', nationalDigits: 9, flag: '🇦🇪' },
  { code: 'IN', name: 'India', dial: '+91', nationalDigits: 10, flag: '🇮🇳' },
  { code: 'PK', name: 'Pakistan', dial: '+92', nationalDigits: 10, flag: '🇵🇰' },
  { code: 'BD', name: 'Bangladesh', dial: '+880', nationalDigits: 10, flag: '🇧🇩' },
  { code: 'PH', name: 'Philippines', dial: '+63', nationalDigits: 10, flag: '🇵🇭' },
  { code: 'LK', name: 'Sri Lanka', dial: '+94', nationalDigits: 9, flag: '🇱🇰' },
  { code: 'NP', name: 'Nepal', dial: '+977', nationalDigits: 10, flag: '🇳🇵' },
  { code: 'EG', name: 'Egypt', dial: '+20', nationalDigits: 10, flag: '🇪🇬' },
  { code: 'SA', name: 'Saudi Arabia', dial: '+966', nationalDigits: 9, flag: '🇸🇦' },
  { code: 'GB', name: 'United Kingdom', dial: '+44', nationalDigits: 10, flag: '🇬🇧' },
  { code: 'US', name: 'United States', dial: '+1', nationalDigits: 10, flag: '🇺🇸' },
] as const;

/** Default selection: the sending side of the corridor. */
export const DEFAULT_COUNTRY = 'AE';

export function findCountry(code: string): Country | undefined {
  return COUNTRIES.find((c) => c.code === code.toUpperCase());
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Digits only — for length checks and normalisation. */
export function digitsOf(input: string): string {
  return input.replace(/\D/g, '');
}

/**
 * Practical email check.
 *
 * Deliberately not an RFC 5322 regex: those accept addresses no mail provider will deliver to, and
 * reject some that work. The real proof an address exists is that its one-time code arrives, so this
 * only catches obvious mistakes before sending one.
 */
export function isValidEmail(input: string): boolean {
  const value = input.trim();
  if (value.length === 0 || value.length > EMAIL_MAX) return false;
  if (/\s/.test(value)) return false;

  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return false;

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > EMAIL_LOCAL_MAX) return false;
  // Consecutive dots, or a dot at either end, are invalid on both sides.
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  if (domain.startsWith('-') || domain.endsWith('-')) return false;
  // A domain must have a dot and a TLD of at least two letters.
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return false;
  const lastDot = domain.lastIndexOf('.');
  if (lastDot <= 0 || domain.length - lastDot - 1 < 2) return false;
  if (!/^[A-Za-z]{2,}$/.test(domain.slice(lastDot + 1))) return false;

  return /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local);
}

/** Normalise an email for storage and comparison: trimmed and lowercased. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/** A one-time code: exactly OTP_LENGTH digits and nothing else. */
export function isValidOtp(input: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(input.trim());
}

/**
 * A person's name.
 *
 * Unicode letters **and combining marks**, plus the separators real names use — spaces, apostrophes,
 * hyphens and dots, for `O'Brien`, `Jean-Luc`, `R. Kumar`. Digits and symbols are rejected.
 *
 * `\p{M}` is not optional here: in Bengali, Devanagari, Tamil and most Indic scripts the vowel signs
 * (matras) are marks, not letters. A `\p{L}`-only rule silently rejects names like `সৌমেন` — which
 * would lock out a large share of this corridor's users, and is the kind of failure nobody reports
 * because they just give up on the form.
 */
export function isValidName(input: string): boolean {
  const value = input.trim();
  if ([...value].length < NAME_MIN || [...value].length > NAME_MAX) return false;
  return /^[\p{L}][\p{L}\p{M}\s.'-]*$/u.test(value);
}

/** Collapse internal whitespace so " Ravi   Kumar " and "Ravi Kumar" store identically. */
export function normalizeName(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

/**
 * The national part of a phone number, for a chosen country.
 *
 * The user picks a country, sees its dial code, and types only the national digits — so this checks
 * exactly that, against the country's own expected length rather than a one-size-fits-all rule.
 */
export function isValidNationalNumber(nationalDigits: string, countryCode: string): boolean {
  const country = findCountry(countryCode);
  if (!country) return false;
  const digits = digitsOf(nationalDigits);
  if (digits.length !== country.nationalDigits) return false;
  // A national number never starts with 0 in these plans — that is a trunk prefix users sometimes
  // type out of habit, and keeping it would produce an unreachable E.164 number.
  return !digits.startsWith('0');
}

/** Build the E.164 string stored and sent to the provider: `+<dial><national>`. */
export function toE164(nationalDigits: string, countryCode: string): string | null {
  const country = findCountry(countryCode);
  if (!country) return null;
  if (!isValidNationalNumber(nationalDigits, countryCode)) return null;
  return `${country.dial}${digitsOf(nationalDigits)}`;
}

/**
 * A full E.164 number, as received by the API.
 *
 * The server cannot assume the client composed it correctly, so it re-checks the whole string:
 * a leading '+', then PHONE_DIGITS_MIN..MAX digits.
 */
export function isValidE164(input: string): boolean {
  const value = input.trim();
  if (!value.startsWith('+')) return false;
  const digits = value.slice(1);
  if (!/^\d+$/.test(digits)) return false;
  return digits.length >= PHONE_DIGITS_MIN && digits.length <= PHONE_DIGITS_MAX;
}

/**
 * True when an E.164 number matches one of the supported countries exactly.
 *
 * Stricter than [`isValidE164`], and what the KYC step uses: a number outside the supported list
 * cannot receive a code, so accepting it would strand the user mid-verification.
 */
export function isSupportedE164(input: string): boolean {
  const value = input.trim();
  if (!isValidE164(value)) return false;
  return COUNTRIES.some((c) => {
    if (!value.startsWith(c.dial)) return false;
    return value.length - c.dial.length === c.nationalDigits;
  });
}

// ---------------------------------------------------------------------------
// Opaque identifiers
// ---------------------------------------------------------------------------

const HEX32 = /^[0-9a-f]{64}$/;

/**
 * The opaque wallet identifier: `Poseidon(ownerSk, domain)` as 32-byte lowercase hex.
 *
 * It has a known shape, so the server can and should insist on it. Accepting free text would let
 * anything become a row in the verification table — an easy way to pollute the KYC audit trail,
 * which is the one record a regulator will actually ask to see.
 */
export function isValidUserId(input: string): boolean {
  return HEX32.test(input.trim());
}

/** A 32-byte lowercase-hex field element (commitment, nullifier, root). */
export function isValidHex32(input: string): boolean {
  return HEX32.test(input.trim());
}

/**
 * A Stellar ed25519 public key: `G` plus 55 base32 characters.
 *
 * Shape only — not the checksum, and not whether the account exists, which are the network's job.
 * The point is to reject obvious junk before it becomes a Horizon call, so a typo fails fast and
 * locally rather than as an opaque upstream error.
 */
export function isValidStellarAddress(input: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(input.trim());
}
