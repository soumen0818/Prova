/**
 * Form validation — the app's half of the rules.
 *
 * The rules themselves live in `@prova/shared` (`validation.ts`, mirrored in Go as `validation.go`)
 * and are enforced by the backend, which is the actual control since anything can post to the API.
 * This module only wraps them with the user-facing messages screens display, so a rule can never be
 * tightened here without the server agreeing — and a drift would fail the shared parity tests.
 *
 * Each validator returns `{ ok }` or `{ ok: false, error }` so screens can show one consistent
 * inline message and gate their primary action.
 */

import {
  NAME_MAX,
  NAME_MIN,
  OTP_LENGTH,
  digitsOf as sharedDigitsOf,
  findCountry,
  isValidEmail,
  isValidName,
  isValidNationalNumber,
} from '@prova/shared';

export type Valid = { ok: true } | { ok: false; error: string };

const ok: Valid = { ok: true };
const bad = (error: string): Valid => ({ ok: false, error });

/** Digits only, for length checks / normalization. Re-exported from the shared spec. */
export const digitsOf = sharedDigitsOf;

/**
 * Email — the account identifier.
 *
 * The address is only *proved* to exist when its one-time code arrives, so this catches obvious
 * mistakes before one is sent rather than trying to be exhaustive.
 */
export function validateEmail(input: string): Valid {
  const t = input.trim();
  if (t.length === 0) return bad('Email is required');
  if (!isValidEmail(t)) return bad('Enter a valid email address');
  return ok;
}

/**
 * The national part of a phone number, for the chosen country.
 *
 * The expected length comes from the country itself — India is 10 digits, the UAE is 9 — so the
 * message can say exactly how many are needed instead of a vague "invalid number".
 */
export function validateNationalPhone(input: string, countryCode: string): Valid {
  const country = findCountry(countryCode);
  if (!country) return bad('Choose a country');

  const d = digitsOf(input);
  if (d.length === 0) return bad('Phone number is required');
  if (d.startsWith('0')) return bad('Drop the leading 0');
  if (d.length < country.nationalDigits) {
    return bad(`${country.name} numbers are ${country.nationalDigits} digits`);
  }
  if (d.length > country.nationalDigits) {
    return bad(`That is too long — ${country.nationalDigits} digits`);
  }
  if (!isValidNationalNumber(input, countryCode)) return bad('Enter a valid phone number');
  return ok;
}

/** OTP: required, exactly OTP_LENGTH digits. */
export function validateOtp(input: string, length = OTP_LENGTH): Valid {
  const d = digitsOf(input);
  if (d.length === 0) return bad('Enter the code');
  if (d.length !== length) return bad(`Code must be ${length} digits`);
  return ok;
}

/**
 * Person / recipient name.
 *
 * Accepts Unicode letters and combining marks: in Bengali, Devanagari and most Indic scripts the
 * vowel signs are marks, not letters, so a letters-only rule would silently reject names like
 * `সৌমেন` — a large share of this corridor.
 */
export function validateName(input: string): Valid {
  const t = input.trim();
  if (t.length === 0) return bad('Name is required');
  if ([...t].length < NAME_MIN) return bad('Name is too short');
  if ([...t].length > NAME_MAX) return bad('Name is too long');
  if (!isValidName(t)) return bad('Use letters only');
  return ok;
}

/** Recipient destination (masked account / phone): required, 3–40 chars. */
export function validateHandle(input: string): Valid {
  const t = input.trim();
  if (t.length === 0) return bad('Account or phone is required');
  if (t.length < 3) return bad('This looks too short');
  if (t.length > 40) return bad('This looks too long');
  return ok;
}

/** Free-text country label: required, 2–40 chars. */
export function validateCountry(input: string): Valid {
  const t = input.trim();
  if (t.length === 0) return bad('Destination country is required');
  if (t.length < 2) return bad('Enter a valid country');
  if (t.length > 40) return bad('Country is too long');
  return ok;
}

/** Whole-number amount within [min, max], optionally checked against an available balance (units). */
export function validateAmount(
  input: string,
  opts: { min: number; max: number; available?: number },
): Valid {
  const t = input.trim();
  if (t.length === 0) return bad('Enter an amount');
  if (!/^\d+$/.test(t)) return bad('Amount must be a whole number');
  const n = Number(t);
  if (!Number.isInteger(n)) return bad('Amount must be a whole number');
  if (n < opts.min) return bad(`Minimum is ${opts.min}`);
  if (n > opts.max) return bad(`Maximum is ${opts.max.toLocaleString('en-US')}`);
  if (opts.available != null && n > opts.available) return bad('Insufficient balance');
  return ok;
}
