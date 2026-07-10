/**
 * Shared input validation — the single source of truth used by every form (and mirrored on the
 * server where relevant). Each validator returns `{ ok }` or `{ ok: false, error }` so screens can
 * show one consistent inline message and gate their primary action.
 */

export type Valid = { ok: true } | { ok: false; error: string };

const ok: Valid = { ok: true };
const bad = (error: string): Valid => ({ ok: false, error });

/** Digits only, for length checks / normalization. */
export function digitsOf(input: string): string {
  return input.replace(/\D/g, '');
}

/** Phone: required, 8–15 digits (E.164 range), optional leading '+'. */
export function validatePhone(input: string): Valid {
  const raw = input.trim();
  if (raw.length === 0) return bad('Phone number is required');
  if (!/^\+?[\d\s()-]+$/.test(raw)) return bad('Phone can only contain digits');
  const d = digitsOf(raw);
  if (d.length < 8) return bad('Phone number is too short');
  if (d.length > 15) return bad('Phone number is too long');
  return ok;
}

/** OTP: required, exactly `length` digits. */
export function validateOtp(input: string, length = 6): Valid {
  const d = digitsOf(input);
  if (d.length === 0) return bad('Enter the code');
  if (d.length !== length) return bad(`Code must be ${length} digits`);
  return ok;
}

/** Person / recipient name: required, 2–60 chars, letters + common separators. */
export function validateName(input: string): Valid {
  const t = input.trim();
  if (t.length === 0) return bad('Name is required');
  if (t.length < 2) return bad('Name is too short');
  if (t.length > 60) return bad('Name is too long');
  if (!/^[\p{L}][\p{L}\s.'-]*$/u.test(t)) return bad('Use letters only');
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
